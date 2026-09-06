import { randomBytes } from 'node:crypto';
import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters, JobContext } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { NumberingService } from './numbering.js';
import type { FileService } from '../files.js';
import type { ApprovalService } from '../approvals.js';
import { HttpError, badRequest, notFound } from '../context.js';

export type DocType = 'tc' | 'testimonial' | 'character' | 'bonafide' | 'id_card' | 'admit_card' | 'report_card' | 'payslip' | 'receipt' | 'invoice' | 'offer_letter' | 'appointment_letter' | 'experience_letter' | 'certificate' | 'marksheet' | 'custom';
export interface IssueInput {
  docType: DocType | string; personType: 'student' | 'staff' | 'alumni' | 'other'; studentId?: string | null; staffId?: string | null;
  data: Record<string, string>; templateId?: string | null; requestId?: string | null; validUntil?: string | null; signedBy?: string | null;
  entityType?: string | null; entityId?: string | null;
}

/** Documents that clear nothing are worthless, so each type says what must be settled first. */
const BLOCKERS: Record<string, ('fees' | 'library' | 'hostel' | 'discipline')[]> = {
  tc: ['fees', 'library', 'hostel', 'discipline'],
  testimonial: ['fees', 'library'],
  character: ['discipline'],
  bonafide: [],
  marksheet: ['fees'],
  experience_letter: [],
};

const DEFAULT_TEMPLATES: { docType: DocType; name: string; body: string; variables: string[] }[] = [
  { docType: 'tc', name: 'Transfer certificate', variables: ['name', 'admission_no', 'class', 'date_of_birth', 'admission_date', 'leaving_date', 'reason', 'conduct'], body: 'This is to certify that {{name}}, admission number {{admission_no}}, was a student of this institution in class {{class}}.\nDate of birth: {{date_of_birth}}. Admitted on {{admission_date}} and left on {{leaving_date}}.\nReason for leaving: {{reason}}.\nConduct during the stay: {{conduct}}.\nAll dues have been cleared and no property of the institution is held.' },
  { docType: 'testimonial', name: 'Testimonial', variables: ['name', 'class', 'result', 'conduct'], body: 'This is to certify that {{name}} of class {{class}} bears a good moral character.\nAcademic record: {{result}}. Conduct: {{conduct}}.\nWe wish the student every success.' },
  { docType: 'character', name: 'Character certificate', variables: ['name', 'class', 'conduct'], body: 'This is to certify that {{name}} of class {{class}} has been known to us and bears a {{conduct}} moral character to the best of our knowledge.' },
  { docType: 'bonafide', name: 'Bonafide certificate', variables: ['name', 'admission_no', 'class', 'year'], body: 'This is to certify that {{name}}, admission number {{admission_no}}, is a bonafide student of class {{class}} in the session {{year}} of this institution.' },
  { docType: 'admit_card', name: 'Admit card', variables: ['name', 'application_no', 'test', 'held_at', 'venue', 'guardian'], body: 'Admit card for {{name}}, application {{application_no}}.\nTest: {{test}}\nWhen: {{held_at}}\nWhere: {{venue}}\nGuardian: {{guardian}}\nBring this card and a photograph. Reach the venue thirty minutes early.' },
  { docType: 'offer_letter', name: 'Offer of admission', variables: ['name', 'application_no', 'campaign', 'expires_at', 'amount', 'guardian'], body: 'Dear {{guardian}},\nWe are pleased to offer {{name}} (application {{application_no}}) a place under {{campaign}}.\nTo confirm the place, pay the admission fee of {{amount}} by {{expires_at}}.\nThe offer lapses after that date and the seat goes to the next applicant on the waiting list.' },
  { docType: 'experience_letter', name: 'Experience letter', variables: ['name', 'designation', 'join_date', 'leave_date', 'conduct'], body: 'This is to certify that {{name}} served this institution as {{designation}} from {{join_date}} to {{leave_date}}.\nDuring this period the conduct was {{conduct}}.\nWe wish every success in future endeavours.' },
];

/**
 * Documents: versioned templates, requests whose eligibility is checked against the modules that
 * actually hold the debt (fees, library, hostel, discipline), issued PDFs with a verification code
 * anyone can check on a public page, ID cards, and bulk print jobs rendered in chunks.
 */
export class DocumentService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService, private numbering: NumberingService,
    private files: FileService, private approvals: ApprovalService, private adapters: Adapters,
  ) {}

  // ---------- templates ----------
  async ensureTemplates(schoolId: string) {
    let made = 0;
    for (const t of DEFAULT_TEMPLATES) {
      if (await this.db.findOne('document_templates', { school_id: schoolId, doc_type: t.docType, name: t.name })) continue;
      await this.db.insert('document_templates', { id: ulid(), school_id: schoolId, doc_type: t.docType, name: t.name, html_template: t.body, css: null, page_size: 'A4', orientation: 'portrait', variables: t.variables as never, is_default: true, version: 1 });
      made++;
    }
    return made;
  }
  async templates(schoolId: string) { return this.db.findMany<Row>('document_templates', { school_id: schoolId }, { orderBy: 'doc_type ASC, version DESC', limit: 200 }); }
  /** Saving over a template keeps the old one: the version goes up and issued documents keep their text. */
  async saveTemplate(schoolId: string, t: { docType: DocType; name: string; body: string; variables?: string[]; pageSize?: string; orientation?: 'portrait' | 'landscape'; isDefault?: boolean }) {
    const ex = await this.db.findOne<Row>('document_templates', { school_id: schoolId, doc_type: t.docType, name: t.name });
    const id = ulid();
    if (ex) {
      await this.db.update('document_templates', { html_template: t.body, variables: (t.variables ?? json(ex.variables) ?? []) as never, page_size: t.pageSize ?? String(ex.page_size), orientation: t.orientation ?? String(ex.orientation), is_default: t.isDefault ?? !!Number(ex.is_default), version: Number(ex.version) + 1, updated_at: nowSql() }, { id: String(ex.id) });
      return String(ex.id);
    }
    await this.db.insert('document_templates', { id, school_id: schoolId, doc_type: t.docType, name: t.name, html_template: t.body, css: null, page_size: t.pageSize ?? 'A4', orientation: t.orientation ?? 'portrait', variables: (t.variables ?? []) as never, is_default: t.isDefault ?? true, version: 1 });
    return id;
  }

  // ---------- requests ----------
  /**
   * N5: what stops this document being issued today. Returns every reason at once so the requester
   * can clear them in one trip rather than discovering them one by one.
   */
  async eligibility(schoolId: string, docType: string, personType: 'student' | 'staff' | 'alumni', personId: string) {
    const checks = BLOCKERS[docType] ?? [];
    const blockers: { kind: string; detail: string }[] = [];
    if (personType === 'student') {
      if (checks.includes('fees')) {
        const due = await this.db.query<{ due: number }>(`SELECT COALESCE(SUM(balance), 0) AS due FROM invoices WHERE school_id = ? AND student_id = ? AND status <> 'cancelled' AND balance > 0`, [schoolId, personId]);
        if (Number(due[0]?.due) > 0) blockers.push({ kind: 'fees', detail: `${Number(due[0]!.due)} in unpaid fees` });
      }
      if (checks.includes('library')) {
        const books = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM library_issues i JOIN library_members m ON m.id = i.member_id WHERE m.school_id = ? AND m.student_id = ? AND i.status IN ('issued','overdue')`, [schoolId, personId]);
        if (Number(books[0]?.n) > 0) blockers.push({ kind: 'library', detail: `${Number(books[0]!.n)} library book(s) not returned` });
      }
      if (checks.includes('hostel')) {
        const beds = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM hostel_allocations WHERE school_id = ? AND student_id = ? AND (vacated_at IS NULL)`, [schoolId, personId]).catch(() => [{ n: 0 }]);
        if (Number(beds[0]?.n) > 0) blockers.push({ kind: 'hostel', detail: 'still allocated a hostel bed' });
      }
      if (checks.includes('discipline')) {
        const cases = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM disciplinary_actions WHERE school_id = ? AND student_id = ? AND status NOT IN ('completed','cancelled')`, [schoolId, personId]).catch(() => [{ n: 0 }]);
        if (Number(cases[0]?.n) > 0) blockers.push({ kind: 'discipline', detail: 'an open disciplinary action' });
      }
    }
    return { eligible: blockers.length === 0, blockers, checked: checks };
  }
  async request(schoolId: string, r: { docType: string; personType: 'student' | 'staff' | 'alumni'; studentId?: string | null; staffId?: string | null; reason?: string | null; requestedBy?: string | null }) {
    const personId = r.personType === 'student' ? r.studentId : r.staffId;
    if (!personId) throw badRequest('who is this document for?');
    const el = await this.eligibility(schoolId, r.docType, r.personType, personId);
    const id = ulid();
    await this.db.insert('document_requests', {
      id, school_id: schoolId, doc_type: r.docType, person_type: r.personType, student_id: r.studentId ?? null, staff_id: r.staffId ?? null, requested_by: r.requestedBy ?? null,
      reason: r.reason ?? null, fee_invoice_id: null, eligibility: el as never, status: el.eligible ? 'requested' : 'blocked', approval_request_id: null, decided_by: null, decided_at: null,
    });
    await this.outbox.emitNow({ type: 'document.requested', schoolId, aggregateType: 'documents.request', aggregateId: id, payload: { requestId: id, docType: r.docType, eligible: el.eligible, blockers: el.blockers.map(b => b.kind) } });
    if (!el.eligible) return { id, status: 'blocked' as const, blockers: el.blockers };
    const ap = await this.approvals.request({ schoolId, entityType: 'documents.request', entityId: id, summary: { docType: r.docType } });
    await this.db.update('document_requests', { approval_request_id: ap.id, status: ap.status === 'approved' ? 'approved' : 'requested', updated_at: nowSql() }, { id });
    return { id, status: ap.status === 'approved' ? ('approved' as const) : ('requested' as const), blockers: [] };
  }
  async requests(schoolId: string, f: { status?: string; studentId?: string } = {}) {
    const where: Row = { school_id: schoolId };
    if (f.status) where.status = f.status;
    if (f.studentId) where.student_id = f.studentId;
    return this.db.findMany<Row>('document_requests', where, { orderBy: 'created_at DESC', limit: 300 });
  }
  /** Re-checks eligibility before issuing: dues cleared since the request are picked up here. */
  async fulfil(schoolId: string, requestId: string, extra: Record<string, string> = {}) {
    const r = await this.db.findOne<Row>('document_requests', { id: requestId, school_id: schoolId });
    if (!r) throw notFound('document request');
    if (r.status === 'issued') throw new HttpError(409, 'this document has already been issued', 'conflict');
    const personId = String(r.person_type === 'student' ? r.student_id : r.staff_id);
    const el = await this.eligibility(schoolId, String(r.doc_type), r.person_type as 'student', personId);
    if (!el.eligible) {
      await this.db.update('document_requests', { status: 'blocked', eligibility: el as never, updated_at: nowSql() }, { id: requestId });
      throw new HttpError(409, `still blocked: ${el.blockers.map(b => b.detail).join('; ')}`, 'blocked');
    }
    const data = { ...(await this.personData(schoolId, r.person_type as 'student', personId)), ...extra };
    const issued = await this.issue(schoolId, { docType: String(r.doc_type), personType: r.person_type as 'student', studentId: (r.student_id as string) ?? null, staffId: (r.staff_id as string) ?? null, data, requestId });
    await this.db.update('document_requests', { status: 'issued', decided_at: nowSql(), updated_at: nowSql() }, { id: requestId });
    return issued;
  }
  private async personData(schoolId: string, personType: 'student' | 'staff' | 'alumni', personId: string): Promise<Record<string, string>> {
    if (personType === 'student') {
      const s = await this.db.query<Row>(`SELECT s.*, c.name AS class_name, y.name AS year_name FROM students s LEFT JOIN classes c ON c.id = s.current_class_id LEFT JOIN academic_years y ON y.id = s.current_academic_year_id WHERE s.id = ?`, [personId]);
      const r = s[0]; if (!r) throw notFound('student');
      return { name: `${r.first_name} ${r.last_name ?? ''}`.trim(), admission_no: String(r.admission_no), class: String(r.class_name ?? ''), year: String(r.year_name ?? ''), date_of_birth: String(r.date_of_birth ?? ''), admission_date: String(r.admission_date ?? ''), leaving_date: String(r.leave_date ?? nowSql().slice(0, 10)), reason: 'guardian request', conduct: 'satisfactory', result: 'promoted' };
    }
    const st = await this.db.query<Row>(`SELECT s.*, d.name AS designation FROM staff s LEFT JOIN designations d ON d.id = s.designation_id WHERE s.id = ?`, [personId]);
    const r = st[0]; if (!r) throw notFound('staff');
    return { name: `${r.first_name} ${r.last_name ?? ''}`.trim(), employee_no: String(r.employee_no), designation: String(r.designation ?? 'Teacher'), join_date: String(r.join_date ?? ''), leave_date: String(r.leave_date ?? nowSql().slice(0, 10)), conduct: 'satisfactory' };
  }

  // ---------- issuing ----------
  /** Renders the template with this data, freezes both, and gives the document a verification code. */
  async issue(schoolId: string, input: IssueInput) {
    const template = input.templateId
      ? await this.db.findOne<Row>('document_templates', { id: input.templateId, school_id: schoolId })
      : await this.db.findOne<Row>('document_templates', { school_id: schoolId, doc_type: input.docType, is_default: true });
    const school = await this.db.findOne<Row>('schools', { id: schoolId });
    const body = fill(String(template?.html_template ?? Object.entries(input.data).map(([k, v]) => `${k}: ${v}`).join('\n')), input.data);
    const id = ulid();
    const documentNo = await this.numbering.next(schoolId, `doc_no_${input.docType}`, { prefix: `${String(input.docType).toUpperCase().slice(0, 6)}-`, padding: 5, resetYearly: true });
    const code = randomBytes(8).toString('hex').toUpperCase();
    const pdf = await this.adapters.pdf.render(this.doc(school, String(template?.name ?? input.docType), body, documentNo, code, input.data));
    const f = await this.files.store({ schoolId, data: pdf, fileName: `${input.docType}-${documentNo}.pdf`, mimeType: 'application/pdf', purpose: String(input.docType), entityType: input.entityType ?? 'documents.issued', entityId: input.entityId ?? id });
    await this.db.insert('issued_documents', {
      id, school_id: schoolId, template_id: template ? String(template.id) : null, request_id: input.requestId ?? null, doc_type: input.docType, document_no: documentNo,
      person_type: input.personType, student_id: input.studentId ?? null, staff_id: input.staffId ?? null, data_snapshot: input.data as never, file_id: f.id,
      verification_code: code, signed_by: input.signedBy ?? null, signature_hash: null, issued_at: nowSql(), valid_until: input.validUntil ?? null, revoked_at: null, revoke_reason: null,
    });
    await this.outbox.emitNow({ type: 'document.issued', schoolId, aggregateType: 'documents.issued', aggregateId: id, payload: { documentId: id, docType: String(input.docType), documentNo, verificationCode: code } });
    return { id, documentNo, verificationCode: code, fileId: f.id };
  }
  async issued(schoolId: string, f: { studentId?: string; docType?: string } = {}) {
    const where: Row = { school_id: schoolId };
    if (f.studentId) where.student_id = f.studentId;
    if (f.docType) where.doc_type = f.docType;
    return this.db.findMany<Row>('issued_documents', where, { orderBy: 'issued_at DESC', limit: 300 });
  }
  async revoke(schoolId: string, id: string, reason: string) {
    return this.db.update('issued_documents', { revoked_at: nowSql(), revoke_reason: reason.slice(0, 160), updated_at: nowSql() }, { id, school_id: schoolId });
  }
  /** The public check behind the QR code: what the document says, and whether it is still valid. */
  async verify(code: string, meta: { ip?: string | null; userAgent?: string | null } = {}) {
    const d = await this.db.findOne<Row>('issued_documents', { verification_code: code.trim().toUpperCase() });
    if (!d) throw notFound('document');
    await this.db.insert('document_verifications', { id: ulid(), school_id: String(d.school_id), document_id: String(d.id), verified_at: nowSql(), ip: meta.ip?.slice(0, 45) ?? null, user_agent: meta.userAgent?.slice(0, 255) ?? null });
    const school = await this.db.findOne<Row>('schools', { id: String(d.school_id) });
    const expired = d.valid_until != null && String(d.valid_until).slice(0, 10) < nowSql().slice(0, 10);
    return {
      valid: !d.revoked_at && !expired, revoked: !!d.revoked_at, expired, revokeReason: (d.revoke_reason as string) ?? null,
      school: String(school?.name ?? ''), docType: String(d.doc_type), documentNo: String(d.document_no), issuedAt: String(d.issued_at),
      validUntil: d.valid_until ? String(d.valid_until).slice(0, 10) : null, data: json<Record<string, string>>(d.data_snapshot) ?? {},
    };
  }

  // ---------- ID cards ----------
  /** N6: one card per person, valid for the session, queued for printing as a single batch. */
  async issueIdCards(schoolId: string, p: { personType: 'student' | 'staff'; validFrom: string; validTo: string; ids?: string[]; createdBy?: string | null }) {
    const people = p.ids?.length
      ? await this.db.query<Row>(`SELECT id FROM ${p.personType === 'student' ? 'students' : 'staff'} WHERE school_id = ? AND id IN (${p.ids.map(() => '?').join(',')})`, [schoolId, ...p.ids])
      : await this.db.query<Row>(`SELECT id FROM ${p.personType === 'student' ? 'students' : 'staff'} WHERE school_id = ? AND status IN ('active','probation') ORDER BY id LIMIT 5000`, [schoolId]);
    const made: string[] = [];
    for (const person of people) {
      const key = p.personType === 'student' ? { student_id: String(person.id) } : { staff_id: String(person.id) };
      const live = await this.db.query<Row>(`SELECT id FROM id_cards WHERE school_id = ? AND ${p.personType}_id = ? AND status IN ('pending_print','active') AND valid_to >= ?`, [schoolId, String(person.id), p.validFrom]);
      if (live.length) continue;
      const id = ulid();
      const cardNo = await this.numbering.next(schoolId, 'id_card_no', { prefix: p.personType === 'student' ? 'STU-' : 'EMP-', padding: 6 });
      await this.db.insert('id_cards', { id, school_id: schoolId, person_type: p.personType, student_id: null, staff_id: null, ...key, card_no: cardNo, template_id: null, valid_from: p.validFrom, valid_to: p.validTo, rfid_tag: null, file_id: null, status: 'pending_print', printed_at: null });
      made.push(id);
    }
    if (!made.length) return { cards: 0, printJobId: null };
    const printJobId = ulid();
    await this.db.insert('print_jobs', { id: printJobId, school_id: schoolId, kind: 'id_cards', items: { ids: made } as never, file_id: null, status: 'queued', created_by: p.createdBy ?? null });
    await this.adapters.queue.push({ name: 'documents.print_job', queue: 'batch', schoolId, payload: { printJobId }, triggeredBy: 'documents.id_cards' });
    return { cards: made.length, printJobId };
  }
  /** Chunked: cards are laid out 8 to a page, 200 cards per pass. */
  async runPrintJob(payload: Record<string, unknown>, ctx: JobContext) {
    const printJobId = String(payload.printJobId);
    const jobRow = await this.db.findOne<Row>('print_jobs', { id: printJobId });
    if (!jobRow) throw notFound('print job');
    const schoolId = String(jobRow.school_id);
    const ids = json<{ ids: string[] }>(jobRow.items)?.ids ?? [];
    await this.db.update('print_jobs', { status: 'rendering', updated_at: nowSql() }, { id: printJobId });
    const cursor = (ctx.job.cursor as { done?: number; pages?: unknown[] } | null) ?? {};
    let done = cursor.done ?? 0;
    const pages = (cursor.pages as Record<string, unknown>[] | undefined) ?? [];
    const CHUNK = 200;
    while (done < ids.length) {
      const slice = ids.slice(done, done + CHUNK);
      const cards = await this.db.query<Row>(`SELECT c.*, s.first_name AS s_first, s.last_name AS s_last, s.admission_no, cl.name AS class_name, st.first_name AS t_first, st.last_name AS t_last, st.employee_no
        FROM id_cards c LEFT JOIN students s ON s.id = c.student_id LEFT JOIN classes cl ON cl.id = s.current_class_id LEFT JOIN staff st ON st.id = c.staff_id
        WHERE c.id IN (${slice.map(() => '?').join(',')})`, slice);
      for (const c of cards) pages.push({ name: `${c.s_first ?? c.t_first} ${c.s_last ?? c.t_last ?? ''}`.trim(), sub: String(c.admission_no ?? c.employee_no ?? ''), extra: String(c.class_name ?? 'Staff'), cardNo: String(c.card_no), validTo: String(c.valid_to).slice(0, 10) });
      done = Math.min(ids.length, done + CHUNK);
      await ctx.progress(done, ids.length, { done, pages });
      if (Date.now() > ctx.deadline && done < ids.length) return { continue: true as const, cursor: { done, pages } };
    }
    const school = await this.db.findOne<Row>('schools', { id: schoolId });
    const pdf = await this.adapters.pdf.render(this.idCardSheet(school, pages as { name: string; sub: string; extra: string; cardNo: string; validTo: string }[]));
    const f = await this.files.store({ schoolId, data: pdf, fileName: `id-cards-${printJobId.slice(-6)}.pdf`, mimeType: 'application/pdf', purpose: 'id_cards', entityType: 'documents.print_job', entityId: printJobId });
    await this.db.update('print_jobs', { file_id: f.id, status: 'ready', updated_at: nowSql() }, { id: printJobId });
    await this.db.execute(`UPDATE id_cards SET file_id = ?, status = 'active', printed_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [f.id, nowSql(), ...ids]);
    await this.notifications.notifyRole(schoolId, 'admin', { channels: ['in_app'], eventKey: 'documents.print_ready', title: 'ID cards ready to print', body: `${ids.length} card(s) laid out and ready to download.`, entityType: 'documents.print_job', entityId: printJobId });
    return { result: { cards: ids.length, fileId: f.id } };
  }
  async printJobs(schoolId: string) { return this.db.findMany<Row>('print_jobs', { school_id: schoolId }, { orderBy: 'created_at DESC', limit: 50 }); }

  // ---------- pdf ----------
  private doc(school: Row | null, title: string, body: string, documentNo: string, code: string, data: Record<string, string>) {
    const verifyUrl = `/verify/${code}`;
    return {
      pageSize: 'A4', pageMargins: [48, 56, 48, 56],
      content: [
        { text: String(school?.name ?? 'School'), style: 'h1', alignment: 'center' },
        school?.name_bn ? { text: String(school.name_bn), style: 'h2', alignment: 'center' } : {},
        school?.address ? { text: addressLine(school.address), style: 'small', alignment: 'center' } : {},
        { text: title, style: 'title', alignment: 'center', margin: [0, 18, 0, 4] },
        { columns: [{ text: `No. ${documentNo}`, style: 'small' }, { text: `Date: ${nowSql().slice(0, 10)}`, style: 'small', alignment: 'right' }], margin: [0, 0, 0, 16] },
        ...body.split('\n').filter(Boolean).map(line => ({ text: line, margin: [0, 0, 0, 6], lineHeight: 1.35 })),
        { columns: [
          { width: '*', stack: [{ text: 'Verify this document', style: 'small' }, { text: `${verifyUrl}`, style: 'code' }, { text: `Code ${code}`, style: 'code' }] },
          { width: 'auto', stack: [{ text: ' ' }, { text: '__________________', margin: [0, 24, 0, 0] }, { text: 'Head of institution', style: 'small', alignment: 'center' }] },
        ], margin: [0, 40, 0, 0] },
        data.note ? { text: String(data.note), style: 'small', margin: [0, 16, 0, 0] } : {},
      ],
      styles: { h1: { fontSize: 18, bold: true }, h2: { fontSize: 12 }, title: { fontSize: 14, bold: true, decoration: 'underline' }, small: { fontSize: 8, color: '#555' }, code: { fontSize: 8, color: '#333' } },
    } as Record<string, unknown>;
  }
  private idCardSheet(school: Row | null, cards: { name: string; sub: string; extra: string; cardNo: string; validTo: string }[]) {
    const rows: unknown[] = [];
    for (let i = 0; i < cards.length; i += 2) {
      rows.push([cardCell(school, cards[i]!), cards[i + 1] ? cardCell(school, cards[i + 1]!) : { text: '' }]);
    }
    return {
      pageSize: 'A4', pageMargins: [24, 24, 24, 24],
      content: [{ table: { widths: ['*', '*'], body: rows.length ? rows : [[{ text: 'No cards' }, { text: '' }]] }, layout: 'lightHorizontalLines' }],
      styles: { cardName: { fontSize: 12, bold: true }, cardSmall: { fontSize: 8, color: '#444' } },
    } as Record<string, unknown>;
  }
}

const cardCell = (school: Row | null, c: { name: string; sub: string; extra: string; cardNo: string; validTo: string }) => ({
  margin: [6, 8, 6, 8],
  stack: [
    { text: String(school?.name ?? 'School'), style: 'cardSmall' },
    { text: c.name, style: 'cardName', margin: [0, 4, 0, 2] },
    { text: c.extra, style: 'cardSmall' },
    { text: `ID ${c.sub}`, style: 'cardSmall' },
    { text: `Card ${c.cardNo} · valid to ${c.validTo}`, style: 'cardSmall', margin: [0, 6, 0, 0] },
  ],
});
/** `{{placeholder}}` substitution; an unknown placeholder is left blank rather than printed raw. */
const fill = (template: string, data: Record<string, string>) => template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => String(data[k] ?? ''));
const addressLine = (v: unknown) => { const a = json<Record<string, string>>(v) ?? {}; return [a.line1, a.area, a.district].filter(Boolean).join(', ') || String(a.text ?? ''); };
