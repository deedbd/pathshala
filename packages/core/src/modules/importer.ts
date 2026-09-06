import * as XLSX from 'xlsx';
import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters, JobContext } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { FileService } from '../files.js';
import type { PeopleService, StudentInput } from './people.js';
import { badRequest, notFound } from '../context.js';
import { normalizeBdPhone } from '../util.js';

/** Column keys accepted in the student import template (header row, case-insensitive, spaces/underscores ignored). */
export const STUDENT_COLUMNS = ['admission_no', 'first_name', 'last_name', 'name_bn', 'gender', 'date_of_birth', 'class', 'section', 'roll_no', 'admission_date', 'blood_group', 'religion', 'guardian_name', 'guardian_phone', 'guardian_relation', 'guardian2_name', 'guardian2_phone', 'guardian2_relation', 'present_address', 'previous_school'] as const;
const REQUIRED = ['first_name', 'gender', 'date_of_birth', 'class'];

export interface ImportRowError { row: number; field: string; message: string }

/**
 * Excel import for students (SheetJS, pure JS). Flow: upload → parse + validate every row (fast, in the
 * request) → `import_jobs` row → chunked `people.import_students` job inserts ~100 rows per chunk and
 * resumes across process recycles → error rows written back to an .xlsx with a "Problems" column →
 * `import.finished` event (rule N12 mails the summary). 1,500 rows take well under two minutes on SQLite.
 */
export class ImportService {
  constructor(private db: Db, private adapters: Adapters, private outbox: OutboxService, private files: FileService, private people: PeopleService) {}

  /** Blank template with the accepted headers and one example row. */
  template(): Buffer {
    const ws = XLSX.utils.aoa_to_sheet([[...STUDENT_COLUMNS], ['', 'Ayesha', 'Rahman', 'আয়েশা রহমান', 'female', '2014-03-02', 'Class 6', 'A', '1', '2026-01-10', 'O+', 'Islam', 'Abdur Rahman', '01712345678', 'father', 'Salma Begum', '01812345678', 'mother', 'House 12, Road 3, Mirpur, Dhaka', 'ABC Kindergarten']]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Students');
    return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  }

  parse(buffer: Buffer): { headers: string[]; rows: Record<string, string>[] } {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw badRequest('the workbook has no sheets');
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '' });
    if (aoa.length < 2) throw badRequest('the sheet has no data rows');
    const headers = (aoa[0] as unknown[]).map(h => normKey(String(h)));
    const rows = aoa.slice(1).filter(r => r.some(v => String(v ?? '').trim() !== '')).map(r => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()])));
    return { headers, rows };
  }

  /** Validates and normalises rows against the academic structure. Returns cleaned inputs plus per-row errors. */
  async prepare(schoolId: string, rows: Record<string, string>[], opts: { academicYearId?: string | null; mapping?: Record<string, string> } = {}) {
    const year = opts.academicYearId ? await this.db.findOne<Row>('academic_years', { id: opts.academicYearId, school_id: schoolId }) : await this.db.findOne<Row>('academic_years', { school_id: schoolId, is_current: true });
    if (!year) throw badRequest('no academic year');
    const classes = await this.db.findMany<Row>('classes', { school_id: schoolId, status: 'active' });
    const sections = await this.db.findMany<Row>('sections', { school_id: schoolId, academic_year_id: String(year.id), status: 'active' });
    const classByName = new Map(classes.flatMap(c => [[normKey(String(c.name)), c], [normKey(String(c.name_bn ?? '')), c]] as [string, Row][]).filter(([k]) => k));
    const sectionKey = (classId: string, name: string) => `${classId}:${normKey(name)}`;
    const sectionMap = new Map(sections.map(s => [sectionKey(String(s.class_id), String(s.name)), s]));
    const existingNos = new Set((await this.db.findMany<{ admission_no: string }>('students', { school_id: schoolId })).map(r => r.admission_no));
    const map = (row: Record<string, string>, key: string) => row[opts.mapping?.[key] ? normKey(opts.mapping[key]) : key] ?? '';
    const cleaned: { row: number; input: StudentInput }[] = []; const errors: ImportRowError[] = []; const seenNos = new Set<string>();
    rows.forEach((r, i) => {
      const rowNo = i + 2; const errs: ImportRowError[] = [];
      for (const k of REQUIRED) if (!map(r, k)) errs.push({ row: rowNo, field: k, message: 'required' });
      const gender = normKey(map(r, 'gender')).replace(/^m$|^boy$|^male$/, 'male').replace(/^f$|^girl$|^female$/, 'female');
      if (map(r, 'gender') && !['male', 'female', 'other'].includes(gender)) errs.push({ row: rowNo, field: 'gender', message: 'male / female / other' });
      const dob = toIsoDate(map(r, 'date_of_birth')); if (map(r, 'date_of_birth') && !dob) errs.push({ row: rowNo, field: 'date_of_birth', message: 'use YYYY-MM-DD or DD/MM/YYYY' });
      const admissionDate = map(r, 'admission_date') ? toIsoDate(map(r, 'admission_date')) : undefined; if (map(r, 'admission_date') && !admissionDate) errs.push({ row: rowNo, field: 'admission_date', message: 'bad date' });
      const cls = classByName.get(normKey(map(r, 'class'))); if (map(r, 'class') && !cls) errs.push({ row: rowNo, field: 'class', message: `unknown class "${map(r, 'class')}"` });
      let sectionId: string | null = null;
      if (cls && map(r, 'section')) { const sec = sectionMap.get(sectionKey(String(cls.id), map(r, 'section'))); if (!sec) errs.push({ row: rowNo, field: 'section', message: `no section "${map(r, 'section')}" in ${cls.name}` }); else sectionId = String(sec.id); }
      const admissionNo = map(r, 'admission_no');
      if (admissionNo) { if (existingNos.has(admissionNo)) errs.push({ row: rowNo, field: 'admission_no', message: 'already exists' }); else if (seenNos.has(admissionNo)) errs.push({ row: rowNo, field: 'admission_no', message: 'duplicate in file' }); seenNos.add(admissionNo); }
      const guardians: StudentInput['guardians'] = [];
      for (const p of ['guardian', 'guardian2']) {
        const name = map(r, `${p}_name`), phone = map(r, `${p}_phone`);
        if (!name && !phone) continue;
        if (!name || !phone) { errs.push({ row: rowNo, field: `${p}_phone`, message: 'guardian needs both name and phone' }); continue; }
        if (!normalizeBdPhone(phone)) { errs.push({ row: rowNo, field: `${p}_phone`, message: 'not a Bangladesh mobile' }); continue; }
        const rel = normKey(map(r, `${p}_relation`)) || (p === 'guardian' ? 'father' : 'mother');
        guardians.push({ fullName: name, phone, relation: (['father', 'mother', 'grandparent', 'sibling', 'uncle', 'aunt', 'legal_guardian', 'other'].includes(rel) ? rel : 'other') as never, isPrimary: p === 'guardian' });
      }
      if (errs.length) { errors.push(...errs); return; }
      cleaned.push({ row: rowNo, input: { firstName: map(r, 'first_name'), lastName: map(r, 'last_name') || null, nameBn: map(r, 'name_bn') || null, gender: gender as never, dateOfBirth: dob!, admissionNo: admissionNo || null, admissionDate: admissionDate ?? undefined, academicYearId: String(year.id), classId: String(cls!.id), sectionId, rollNo: map(r, 'roll_no') || null, bloodGroup: map(r, 'blood_group') || null, religion: map(r, 'religion') || null, presentAddress: map(r, 'present_address') ? { text: map(r, 'present_address') } : null, previousSchool: map(r, 'previous_school') ? { name: map(r, 'previous_school') } : null, guardians } });
    });
    return { yearId: String(year.id), cleaned, errors, total: rows.length };
  }

  /** Stores the workbook, validates, creates the import job and queues the chunked insert. */
  async start(schoolId: string, buffer: Buffer, fileName: string, opts: { academicYearId?: string | null; mapping?: Record<string, string>; createdBy?: string | null } = {}) {
    const { rows } = this.parse(buffer);
    const prep = await this.prepare(schoolId, rows, opts);
    const file = await this.files.store({ schoolId, data: buffer, fileName, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', purpose: 'import', entityType: 'platform.import_job' });
    const id = ulid();
    await this.db.insert('import_jobs', { id, school_id: schoolId, entity_type: 'student', file_id: file.id, mapping: { ...(opts.mapping ?? {}), academicYearId: prep.yearId } as never, total_rows: prep.total, success_rows: 0, error_rows: prep.errors.length, status: 'pending', created_by: opts.createdBy ?? null });
    await this.adapters.storage.put(`${schoolId}/imports/${id}.json`, Buffer.from(JSON.stringify({ rows: prep.cleaned, errors: prep.errors, sourceRows: rows })));
    await this.adapters.queue.push({ name: 'people.import_students', queue: 'batch', schoolId, payload: { importJobId: id }, totalItems: prep.cleaned.length, triggeredBy: 'import' });
    return { id, total: prep.total, valid: prep.cleaned.length, invalid: prep.errors.length, errors: prep.errors.slice(0, 50) };
  }

  /** Queue handler: inserts in chunks of 100, writes progress, resumes from cursor, produces the error workbook at the end. */
  async runJob(payload: Record<string, unknown>, ctx: JobContext) {
    const jobId = String(payload.importJobId);
    const job = await this.db.findOne<Row>('import_jobs', { id: jobId });
    if (!job) throw notFound('import job');
    const schoolId = String(job.school_id);
    const stream = await this.adapters.storage.get(`${schoolId}/imports/${jobId}.json`);
    const chunks: Buffer[] = []; for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { rows: { row: number; input: StudentInput }[]; errors: ImportRowError[]; sourceRows: Record<string, string>[] };
    const cursor = (ctx.job.cursor as { done?: number; failed?: ImportRowError[] } | null) ?? {};
    let done = cursor.done ?? 0; const failed: ImportRowError[] = cursor.failed ?? [];
    if (job.status === 'pending') await this.db.update('import_jobs', { status: 'running', updated_at: nowSql() }, { id: jobId });
    const CHUNK = 100;
    while (done < data.rows.length) {
      const slice = data.rows.slice(done, done + CHUNK);
      await this.db.transaction(async tx => {
        for (const r of slice) {
          try { await this.people.createStudent(schoolId, r.input, tx); }
          catch (e) { failed.push({ row: r.row, field: '*', message: (e as Error).message.slice(0, 200) }); }
        }
      });
      done += slice.length;
      await ctx.progress(done, data.rows.length, { done, failed });
      if (Date.now() > ctx.deadline && done < data.rows.length) return { continue: true, cursor: { done, failed } };
    }
    const allErrors = [...data.errors, ...failed].sort((a, b) => a.row - b.row);
    let errorsFileId: string | null = null;
    if (allErrors.length) {
      const byRow = new Map<number, string[]>(); for (const e of allErrors) byRow.set(e.row, [...(byRow.get(e.row) ?? []), `${e.field}: ${e.message}`]);
      const headers = Object.keys(data.sourceRows[0] ?? {});
      const aoa = [[...headers, 'Problems'], ...[...byRow.keys()].sort((a, b) => a - b).map(rowNo => { const src = data.sourceRows[rowNo - 2] ?? {}; return [...headers.map(h => src[h] ?? ''), byRow.get(rowNo)!.join('; ')]; })];
      const ws = XLSX.utils.aoa_to_sheet(aoa); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Fix and re-import');
      const f = await this.files.store({ schoolId, data: Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })), fileName: `import-${jobId}-errors.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', purpose: 'import_errors', entityType: 'platform.import_job', entityId: jobId });
      errorsFileId = f.id;
    }
    const success = data.rows.length - failed.length;
    await this.db.update('import_jobs', { status: 'success', success_rows: success, error_rows: allErrors.length, errors_file_id: errorsFileId, finished_at: nowSql(), updated_at: nowSql() }, { id: jobId });
    await this.outbox.emitNow({ type: 'import.finished', schoolId, aggregateType: 'platform.import_job', aggregateId: jobId, payload: { importJobId: jobId, entityType: 'student', successRows: success, errorRows: allErrors.length } });
    return { result: { success, errors: allErrors.length, errorsFileId } };
  }

  async status(schoolId: string, id: string) {
    const job = await this.db.findOne<Row>('import_jobs', { id, school_id: schoolId }); if (!job) throw notFound('import job');
    const bg = await this.db.findMany<Row>('background_jobs', { school_id: schoolId, job_name: 'people.import_students' }, { orderBy: 'created_at DESC', limit: 20 });
    const mine = bg.find(b => (json<{ importJobId?: string }>(b.payload)?.importJobId) === id);
    return { ...job, mapping: json(job.mapping), progressPct: mine ? Number(mine.progress_pct) : (job.status === 'success' ? 100 : 0), jobStatus: mine?.status ?? null, jobError: mine?.error ?? null };
  }
  async list(schoolId: string) { return this.db.findMany<Row>('import_jobs', { school_id: schoolId }, { orderBy: 'created_at DESC', limit: 20 }); }
}

function normKey(s: string) { return s.trim().toLowerCase().replace(/[\s-]+/g, '_'); }
function toIsoDate(v: string): string | null {
  const s = v.trim(); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2})$/); if (m) return `20${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
