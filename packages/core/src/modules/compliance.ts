import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters, ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { AcademicService } from './academic.js';
import type { FileService } from '../files.js';
import type { HrService } from './hr.js';
import type { TaskService } from '../tasks.js';
import type { SettingsService } from '../settings.js';
import { round } from './accounting.js';
import { HttpError, badRequest, notFound } from '../context.js';

export type ReportType = 'banbeis_census' | 'board_registration' | 'mpo_salary_sheet' | 'stipend_list' | 'annual_return' | 'custom';

/**
 * What the government asks for, and what the school owes the people in its records.
 *
 * Every return here is built from the live tables rather than typed again: a census that disagrees
 * with the register is a census somebody made up. Each one is kept as a row with the numbers it was
 * built from, so when the office is asked in six months where a figure came from, the answer exists.
 *
 * The other half is the duty running the other way — consent that a guardian gave and can withdraw, a
 * request to see or delete what is held, and retention rules that say when old records stop being
 * kept. A deletion request is never carried out silently: it is a task for a person, because a school
 * has records it is legally obliged to keep and only a person can weigh that.
 */
export class ComplianceService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService,
    private academic: AcademicService, private files: FileService, private hr: HrService,
    private tasks: TaskService, private settings: SettingsService, private adapters: Adapters,
  ) {}

  // ---------- government returns ----------
  /**
   * The BANBEIS census: pupils by class and sex, staff by category and sex, and the facilities count.
   * Built from the register on the day it is asked for.
   */
  async banbeisCensus(schoolId: string, opts: { academicYearId?: string; asOf?: string } = {}) {
    const year = await this.academic.requireYear(schoolId, opts.academicYearId ?? null);
    const asOf = opts.asOf ?? nowSql().slice(0, 10);
    const school = await this.db.findOne<Row>('schools', { id: schoolId });
    const byClass = await this.db.query<Row>(`SELECT c.name AS class_name, c.numeric_level,
        SUM(CASE WHEN s.gender = 'male' THEN 1 ELSE 0 END) AS boys,
        SUM(CASE WHEN s.gender = 'female' THEN 1 ELSE 0 END) AS girls,
        COUNT(*) AS total
      FROM student_enrollments e JOIN students s ON s.id = e.student_id JOIN classes c ON c.id = e.class_id
      WHERE e.school_id = ? AND e.academic_year_id = ? AND e.status = 'active' AND s.status = 'active'
      GROUP BY c.id, c.name, c.numeric_level ORDER BY c.numeric_level`, [schoolId, String(year.id)]);
    const staff = await this.db.query<Row>(`SELECT staff_category,
        SUM(CASE WHEN gender = 'male' THEN 1 ELSE 0 END) AS men,
        SUM(CASE WHEN gender = 'female' THEN 1 ELSE 0 END) AS women,
        COUNT(*) AS total
      FROM staff WHERE school_id = ? AND status IN ('active','probation') GROUP BY staff_category`, [schoolId]);
    const rooms = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM rooms WHERE school_id = ?`, [schoolId]);
    const books = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM library_book_copies WHERE school_id = ?`, [schoolId]);
    const mpo = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM staff WHERE school_id = ? AND mpo_index_no IS NOT NULL AND status IN ('active','probation')`, [schoolId]);
    const data = {
      school: { name: String(school?.name ?? ''), code: String(school?.code ?? ''), eiin: String(school?.eiin ?? ''), type: String(school?.institution_type ?? '') },
      asOf, academicYear: String(year.name),
      students: {
        byClass: byClass.map(r => ({ class: String(r.class_name), boys: Number(r.boys), girls: Number(r.girls), total: Number(r.total) })),
        boys: byClass.reduce((a, r) => a + Number(r.boys), 0),
        girls: byClass.reduce((a, r) => a + Number(r.girls), 0),
        total: byClass.reduce((a, r) => a + Number(r.total), 0),
      },
      staff: {
        byCategory: staff.map(r => ({ category: String(r.staff_category), men: Number(r.men), women: Number(r.women), total: Number(r.total) })),
        total: staff.reduce((a, r) => a + Number(r.total), 0),
        mpoListed: Number(mpo[0]?.n ?? 0),
      },
      facilities: { rooms: Number(rooms[0]?.n ?? 0), libraryBooks: Number(books[0]?.n ?? 0) },
    };
    return this.saveReport(schoolId, 'banbeis_census', asOf.slice(0, 7), data, this.censusCsv(data));
  }
  /** The stipend list the programme's authority asks for: who is on it, and how they are paid. */
  async stipendList(schoolId: string, programId: string, period = nowSql().slice(0, 7)) {
    const program = await this.db.findOne<Row>('stipend_programs', { id: programId, school_id: schoolId });
    if (!program) throw notFound('stipend programme');
    const rows = await this.db.query<Row>(`SELECT e.*, s.first_name, s.last_name, s.admission_no, s.gender, s.date_of_birth, c.name AS class_name
      FROM stipend_enrollments e JOIN students s ON s.id = e.student_id LEFT JOIN classes c ON c.id = s.current_class_id
      WHERE e.school_id = ? AND e.program_id = ? AND e.status = 'active' ORDER BY c.numeric_level, s.admission_no`, [schoolId, programId]);
    const lines = ['admission_no,name,class,gender,date_of_birth,account,amount'];
    for (const r of rows) {
      const bank = json<{ kind?: string; number?: string }>(r.bank_or_mfs) ?? {};
      lines.push([String(r.admission_no), `${r.first_name} ${r.last_name ?? ''}`.trim(), String(r.class_name ?? ''), String(r.gender), String(r.date_of_birth ?? ''), `${bank.kind ?? ''} ${bank.number ?? ''}`.trim(), String(round(Number(program.amount ?? 0)))].map(csv).join(','));
    }
    const data = { programme: String(program.name), authority: String(program.authority ?? ''), period, students: rows.length, amountEach: round(Number(program.amount ?? 0)), total: round(rows.length * Number(program.amount ?? 0)) };
    return this.saveReport(schoolId, 'stipend_list', period, data, lines.join('\r\n'));
  }
  /** The MPO salary sheet, which HR already builds from the payroll it was paid against. */
  async mpoSalarySheet(schoolId: string, runId: string) {
    const sheet = await this.hr.mpoSheet(schoolId, runId);
    const saved = await this.saveReport(schoolId, 'mpo_salary_sheet', sheet.period, { staff: sheet.staff, total: sheet.total, banks: sheet.banks, missing: sheet.missing }, null, sheet.fileId);
    return { ...saved, ...sheet };
  }
  private async saveReport(schoolId: string, reportType: ReportType, period: string, data: Record<string, unknown>, csvBody: string | null, fileId?: string) {
    let file = fileId ?? null;
    if (csvBody != null) {
      const stored = await this.files.store({ schoolId, data: Buffer.from(csvBody, 'utf8'), fileName: `${reportType}-${period}.csv`, mimeType: 'text/csv', purpose: 'govt_report', entityType: 'compliance.report' });
      file = stored.id;
    }
    const ex = await this.db.findOne<Row>('govt_reports', { school_id: schoolId, report_type: reportType, period });
    const row = { school_id: schoolId, report_type: reportType, period, data: data as never, file_id: file, status: 'generated' };
    if (ex && ex.status === 'submitted') throw new HttpError(409, `the ${reportType} for ${period} has already been submitted`, 'conflict');
    const id = ex ? String(ex.id) : ulid();
    if (ex) await this.db.update('govt_reports', { ...row, updated_at: nowSql() }, { id });
    else await this.db.insert('govt_reports', { id, ...row, submitted_at: null });
    await this.outbox.emitNow({ type: 'govt_report.generated', schoolId, aggregateType: 'compliance.report', aggregateId: id, payload: { reportId: id, reportType, period } });
    return { id, reportType, period, fileId: file, data };
  }
  async markSubmitted(schoolId: string, reportId: string, opts: { submittedAt?: string } = {}) {
    const r = await this.db.findOne<Row>('govt_reports', { id: reportId, school_id: schoolId });
    if (!r) throw notFound('report');
    await this.db.update('govt_reports', { status: 'submitted', submitted_at: opts.submittedAt ?? nowSql(), updated_at: nowSql() }, { id: reportId });
    return { id: reportId, status: 'submitted' as const };
  }
  async reports(schoolId: string, reportType?: string) {
    const where: Row = { school_id: schoolId };
    if (reportType) where.report_type = reportType;
    const rows = await this.db.findMany<Row>('govt_reports', where, { orderBy: 'created_at DESC', limit: 100 });
    return rows.map(r => ({ ...r, data: json(r.data) }) as Row);
  }
  private censusCsv(data: { students: { byClass: { class: string; boys: number; girls: number; total: number }[] }; staff: { byCategory: { category: string; men: number; women: number; total: number }[] } }) {
    const lines = ['section,name,male,female,total'];
    for (const c of data.students.byClass) lines.push(['students', c.class, c.boys, c.girls, c.total].map(csv).join(','));
    for (const s of data.staff.byCategory) lines.push(['staff', s.category, s.men, s.women, s.total].map(csv).join(','));
    return lines.join('\r\n');
  }

  // ---------- stipend programmes ----------
  async createProgram(schoolId: string, p: { name: string; authority?: string | null; amount?: number | null; frequency?: 'monthly' | 'quarterly' | 'half_yearly' | 'yearly'; criteria?: Record<string, unknown> | null }) {
    const ex = await this.db.findOne<{ id: string }>('stipend_programs', { school_id: schoolId, name: p.name });
    if (ex) return ex.id;
    const id = ulid();
    await this.db.insert('stipend_programs', { id, school_id: schoolId, name: p.name, authority: p.authority ?? null, criteria: (p.criteria ?? null) as never, amount: p.amount ?? null, frequency: p.frequency ?? 'quarterly', status: 'active' });
    return id;
  }
  async enrolInStipend(schoolId: string, p: { programId: string; studentId: string; bankOrMfs?: { kind?: string; number?: string } | null; enrolledOn?: string }) {
    if (!(await this.db.findOne('stipend_programs', { id: p.programId, school_id: schoolId }))) throw notFound('stipend programme');
    if (!(await this.db.findOne('students', { id: p.studentId, school_id: schoolId }))) throw notFound('student');
    const ex = await this.db.findOne('stipend_enrollments', { program_id: p.programId, student_id: p.studentId });
    if (ex) throw new HttpError(409, 'this student is already on that programme', 'duplicate');
    const id = ulid();
    await this.db.insert('stipend_enrollments', { id, school_id: schoolId, program_id: p.programId, student_id: p.studentId, enrolled_on: p.enrolledOn ?? nowSql().slice(0, 10), bank_or_mfs: (p.bankOrMfs ?? null) as never, disbursements: [] as never, status: 'active' });
    return id;
  }
  /** Records money the authority actually paid, per student, so the next list is honest about arrears. */
  async recordDisbursement(schoolId: string, enrollmentId: string, d: { period: string; amount: number; paidOn?: string; reference?: string | null }) {
    const e = await this.db.findOne<Row>('stipend_enrollments', { id: enrollmentId, school_id: schoolId });
    if (!e) throw notFound('stipend enrolment');
    const history = json<{ period: string; amount: number; paidOn: string; reference?: string | null }[]>(e.disbursements) ?? [];
    if (history.some(h => h.period === d.period)) throw new HttpError(409, `${d.period} is already recorded for this student`, 'duplicate');
    history.push({ period: d.period, amount: round(d.amount), paidOn: d.paidOn ?? nowSql().slice(0, 10), reference: d.reference ?? null });
    await this.db.update('stipend_enrollments', { disbursements: history as never, updated_at: nowSql() }, { id: enrollmentId });
    return { id: enrollmentId, periods: history.length, total: round(history.reduce((a, h) => a + h.amount, 0)) };
  }
  async stipends(schoolId: string, programId?: string) {
    const where: string[] = ['e.school_id = ?']; const params: unknown[] = [schoolId];
    if (programId) { where.push('e.program_id = ?'); params.push(programId); }
    const rows = await this.db.query<Row>(`SELECT e.*, s.first_name, s.last_name, s.admission_no, p.name AS program_name FROM stipend_enrollments e JOIN students s ON s.id = e.student_id JOIN stipend_programs p ON p.id = e.program_id WHERE ${where.join(' AND ')} ORDER BY s.admission_no LIMIT 500`, params);
    return rows.map(r => ({ ...r, bank_or_mfs: json(r.bank_or_mfs), disbursements: json(r.disbursements) }) as Row);
  }
  async programs(schoolId: string) {
    return this.db.query<Row>(`SELECT p.*, (SELECT COUNT(*) FROM stipend_enrollments e WHERE e.program_id = p.id AND e.status = 'active') AS students FROM stipend_programs p WHERE p.school_id = ? ORDER BY p.name`, [schoolId]);
  }

  // ---------- consent ----------
  /**
   * Consent, recorded with what it was given for and when it runs out. Withdrawing is a new row rather
   * than an edit: the school must be able to show what it was allowed to do at the time it did it.
   */
  async recordConsent(schoolId: string, c: { userId: string; consentType: string; granted: boolean; studentId?: string | null; expiresAt?: string | null; evidence?: Record<string, unknown> | null }) {
    const id = ulid();
    await this.db.insert('consent_records', { id, school_id: schoolId, user_id: c.userId, student_id: c.studentId ?? null, consent_type: c.consentType, granted: c.granted, granted_at: nowSql(), expires_at: c.expiresAt ?? null, evidence: (c.evidence ?? null) as never });
    return { id, granted: c.granted };
  }
  /** The current answer for one person and one purpose: the latest row that has not expired. */
  async hasConsent(schoolId: string, userId: string, consentType: string, studentId?: string | null) {
    const rows = await this.db.query<Row>(`SELECT * FROM consent_records WHERE school_id = ? AND user_id = ? AND consent_type = ?${studentId ? ' AND student_id = ?' : ''} ORDER BY granted_at DESC, id DESC LIMIT 1`, studentId ? [schoolId, userId, consentType, studentId] : [schoolId, userId, consentType]);
    const latest = rows[0];
    if (!latest) return { granted: false, reason: 'never asked' as const };
    if (!Number(latest.granted)) return { granted: false, reason: 'withdrawn' as const, at: String(latest.granted_at) };
    if (latest.expires_at && String(latest.expires_at) < nowSql()) return { granted: false, reason: 'expired' as const, at: String(latest.expires_at) };
    return { granted: true, at: String(latest.granted_at) };
  }
  async consents(schoolId: string, f: { userId?: string; studentId?: string; consentType?: string } = {}) {
    const where: Row = { school_id: schoolId };
    if (f.userId) where.user_id = f.userId;
    if (f.studentId) where.student_id = f.studentId;
    if (f.consentType) where.consent_type = f.consentType;
    return this.db.findMany<Row>('consent_records', where, { orderBy: 'granted_at DESC', limit: 300 });
  }

  // ---------- what a person may ask for about themselves ----------
  /**
   * A request to see, correct or delete what the school holds. An export is produced by the system; a
   * deletion is a task for a person, because a school is obliged to keep some records and only a
   * person can weigh a request against that obligation.
   */
  async requestData(schoolId: string, userId: string, kind: 'export' | 'delete' | 'correct') {
    const id = ulid();
    await this.db.insert('data_requests', { id, school_id: schoolId, user_id: userId, kind, status: 'requested', file_id: null, processed_by: null, processed_at: null });
    await this.notifications.notifyRole(schoolId, 'admin', { channels: ['in_app', 'email'], eventKey: 'compliance.data_request', title: `A ${kind} request`, body: kind === 'delete' ? 'Somebody has asked for their records to be deleted. Check what the school is obliged to keep before acting.' : `Somebody has asked to ${kind} the records held about them.`, entityType: 'compliance.data_request', entityId: id });
    await this.outbox.emitNow({ type: 'data_request.made', schoolId, aggregateType: 'compliance.data_request', aggregateId: id, payload: { requestId: id, userId, kind } });
    return { id, kind, status: 'requested' as const };
  }
  /** Everything the school holds about one person, as one JSON file they can take away. */
  async fulfilExport(schoolId: string, requestId: string, processedBy?: string | null) {
    const r = await this.db.findOne<Row>('data_requests', { id: requestId, school_id: schoolId });
    if (!r) throw notFound('data request');
    if (r.kind !== 'export') throw badRequest('only an export request is produced by the system');
    const userId = String(r.user_id);
    const user = await this.db.findOne<Row>('users', { id: userId });
    const guardian = await this.db.findOne<Row>('guardians', { school_id: schoolId, user_id: userId });
    const student = await this.db.findOne<Row>('students', { school_id: schoolId, user_id: userId });
    const staff = await this.db.findOne<Row>('staff', { school_id: schoolId, user_id: userId });
    const children = guardian ? await this.db.query<Row>(`SELECT s.id, s.admission_no, s.first_name, s.last_name FROM student_guardians sg JOIN students s ON s.id = sg.student_id WHERE sg.guardian_id = ?`, [String(guardian.id)]) : [];
    const bundle = {
      exportedAt: nowSql(),
      account: user ? { id: String(user.id), name: String(user.display_name), phone: user.phone, email: user.email, userType: String(user.user_type), createdAt: String(user.created_at) } : null,
      guardian: guardian ? { name: guardian.full_name, phone: guardian.phone, email: guardian.email, occupation: guardian.occupation } : null,
      student: student ? { admissionNo: student.admission_no, name: `${student.first_name} ${student.last_name ?? ''}`.trim(), dateOfBirth: student.date_of_birth, status: student.status } : null,
      staff: staff ? { employeeNo: staff.employee_no, name: `${staff.first_name} ${staff.last_name ?? ''}`.trim(), joinDate: staff.join_date, status: staff.status } : null,
      children: children.map(c => ({ admissionNo: c.admission_no, name: `${c.first_name} ${c.last_name ?? ''}`.trim() })),
      notifications: await this.db.query<Row>(`SELECT event_key, title, channel, created_at FROM notifications WHERE school_id = ? AND recipient_user_id = ? ORDER BY created_at DESC LIMIT 500`, [schoolId, userId]),
      consents: await this.consents(schoolId, { userId }),
    };
    const f = await this.files.store({ schoolId, data: Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'), fileName: `data-export-${userId.slice(-6)}.json`, mimeType: 'application/json', purpose: 'data_export', entityType: 'compliance.data_request', entityId: requestId });
    await this.db.update('data_requests', { status: 'done', file_id: f.id, processed_by: processedBy ?? null, processed_at: nowSql(), updated_at: nowSql() }, { id: requestId });
    await this.notifications.notify({ schoolId, userId, channels: ['in_app', 'email'], eventKey: 'compliance.data_ready', title: 'Your records are ready', body: 'The export of what the school holds about you is ready to download.', entityType: 'compliance.data_request', entityId: requestId });
    return { id: requestId, fileId: f.id, status: 'done' as const };
  }
  async decideRequest(schoolId: string, requestId: string, status: 'processing' | 'done' | 'rejected', processedBy?: string | null) {
    if (!(await this.db.update('data_requests', { status, processed_by: processedBy ?? null, processed_at: status === 'processing' ? null : nowSql(), updated_at: nowSql() }, { id: requestId, school_id: schoolId }))) throw notFound('data request');
    return { id: requestId, status };
  }
  async dataRequests(schoolId: string, status?: string) {
    const where: Row = { school_id: schoolId };
    if (status) where.status = status;
    return this.db.query<Row>(`SELECT d.*, u.display_name, u.phone FROM data_requests d JOIN users u ON u.id = d.user_id WHERE d.school_id = ?${status ? ' AND d.status = ?' : ''} ORDER BY d.created_at DESC LIMIT 200`, status ? [schoolId, status] : [schoolId]);
  }

  // ---------- retention ----------
  async setRetention(schoolId: string, p: { entityType: string; keepYears: number; action?: 'archive' | 'anonymise' | 'delete'; isActive?: boolean }) {
    if (p.keepYears < 1 || p.keepYears > 100) throw badRequest('keep between 1 and 100 years');
    const ex = await this.db.findOne<Row>('retention_policies', { school_id: schoolId, entity_type: p.entityType });
    const row = { school_id: schoolId, entity_type: p.entityType, keep_years: p.keepYears, action: p.action ?? 'archive', is_active: p.isActive ?? true };
    if (ex) { await this.db.update('retention_policies', { ...row, updated_at: nowSql() }, { id: String(ex.id) }); return String(ex.id); }
    const id = ulid();
    await this.db.insert('retention_policies', { id, ...row });
    return id;
  }
  async retentionPolicies(schoolId: string) { return this.db.findMany<Row>('retention_policies', { school_id: schoolId }, { orderBy: 'entity_type ASC' }); }
  /**
   * What each retention rule would touch today. It reports and never deletes: a rule that quietly
   * removed a leaver's file would be found out only when somebody needed the file.
   */
  async retentionReview(schoolId: string, asOf = nowSql().slice(0, 10)) {
    const policies = await this.db.findMany<Row>('retention_policies', { school_id: schoolId, is_active: true });
    const out: { entityType: string; keepYears: number; action: string; cutoff: string; rows: number }[] = [];
    const countable: Record<string, { table: string; dateColumn: string; where?: string }> = {
      student: { table: 'students', dateColumn: 'status_changed_at', where: `status IN ('graduated','transferred','dropped','alumni')` },
      staff: { table: 'staff', dateColumn: 'leave_date', where: `status IN ('resigned','retired','terminated')` },
      notification: { table: 'notifications', dateColumn: 'created_at' },
      audit_log: { table: 'audit_logs', dateColumn: 'created_at' },
      admission_application: { table: 'admission_applications', dateColumn: 'created_at', where: `status IN ('rejected','withdrawn')` },
      attendance: { table: 'student_attendance', dateColumn: 'on_date' },
    };
    for (const p of policies) {
      const spec = countable[String(p.entity_type)];
      if (!spec) { out.push({ entityType: String(p.entity_type), keepYears: Number(p.keep_years), action: String(p.action), cutoff: '', rows: -1 }); continue; }
      const cutoff = new Date(Date.parse(`${asOf}T00:00:00Z`) - Number(p.keep_years) * 365.25 * 86_400_000).toISOString().slice(0, 10);
      const rows = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${spec.table} WHERE school_id = ? AND ${spec.dateColumn} IS NOT NULL AND ${spec.dateColumn} < ?${spec.where ? ` AND ${spec.where}` : ''}`, [schoolId, cutoff]);
      out.push({ entityType: String(p.entity_type), keepYears: Number(p.keep_years), action: String(p.action), cutoff, rows: Number(rows[0]?.n ?? 0) });
    }
    return { asOf, policies: out, due: out.filter(o => o.rows > 0).length };
  }

  /**
   * O5, first half: the census the school owes BANBEIS, built without anybody being asked to build it.
   *
   * Which months the window opens in is a school setting (`compliance.census_months`, July by
   * default) because the authority moves it; what does not move is that the return must agree with
   * the register, and the register is here. In the window the return is generated from live rows and
   * a task is raised naming what to check before it is submitted — submitting it is a person's act,
   * on a portal this system does not talk to. A school with no EIIN is not in the scheme and is left
   * alone, and a period already generated is not generated again.
   */
  async censusIfDue(schoolId: string, onDate = nowSql().slice(0, 10)) {
    const school = await this.db.findOne<Row>('schools', { id: schoolId });
    if (!school?.eiin) return { generated: false as const, why: 'the school has no EIIN' };
    const months = (await this.settings.get<number[]>(schoolId, 'compliance.census_months')) ?? [7];
    const month = Number(onDate.slice(5, 7));
    if (!months.includes(month)) return { generated: false as const, why: 'outside the census window' };
    const period = onDate.slice(0, 7);
    const ex = await this.db.findOne<Row>('govt_reports', { school_id: schoolId, report_type: 'banbeis_census', period });
    if (ex) return { generated: false as const, why: 'already generated', reportId: String(ex.id) };
    const report = await this.banbeisCensus(schoolId, { asOf: onDate });
    const d = report.data as { students?: { total?: number }; staff?: { total?: number } };
    await this.tasks.ensure({ schoolId, title: `Check and submit the BANBEIS census for ${period}`, description: `Built from the register on ${onDate}: ${d.students?.total ?? 0} pupils and ${d.staff?.total ?? 0} staff. Check the figures against the register before submitting, then mark it submitted here.`, taskType: 'compliance.return', assignedRole: 'admin', entityType: 'compliance.report', entityId: report.id, priority: 'high' });
    return { generated: true as const, reportId: report.id, period };
  }

  /**
   * O5, second half: the stipend list for the period that has come due. The authority pays the
   * students, not the school, so nothing here moves money — it produces the list of who is on the
   * programme and how they are paid, and asks the office to send it. A period already recorded as
   * disbursed for everybody is not asked for again.
   */
  async stipendListsIfDue(schoolId: string, onDate = nowSql().slice(0, 10)) {
    const programs = await this.db.findMany<Row>('stipend_programs', { school_id: schoolId, status: 'active' });
    const out: { programId: string; period: string; reportId: string; students: number }[] = [];
    for (const p of programs) {
      const period = periodFor(String(p.frequency ?? 'quarterly'), onDate);
      if (!period) continue;                       // not the first month of this programme's cycle
      if (await this.db.findOne('govt_reports', { school_id: schoolId, report_type: 'stipend_list', period })) continue;
      const enrolled = await this.db.count('stipend_enrollments', { school_id: schoolId, program_id: String(p.id), status: 'active' });
      if (!enrolled) continue;
      const report = await this.stipendList(schoolId, String(p.id), period);
      await this.tasks.ensure({ schoolId, title: `Send the ${p.name} stipend list for ${period}`, description: `${enrolled} student(s) on the programme. The list is built from the register; check the accounts on it before sending it to ${p.authority ?? 'the authority'}.`, taskType: 'compliance.return', assignedRole: 'admin', entityType: 'compliance.report', entityId: report.id, priority: 'normal' });
      out.push({ programId: String(p.id), period, reportId: report.id, students: enrolled });
    }
    return out;
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      /**
       * O2 and O5, monthly: what the school owes, and what it is holding.
       *
       * The retention review still only ever reports — a rule that quietly deleted a leaver's file
       * would be found out on the day somebody needed the file — but it now leaves a task behind it
       * as well as a message, because a message read on a phone at nine at night chases nobody. The
       * returns that are due in this month are generated from the register before anybody is asked
       * for them, and the ones generated a fortnight ago and still unsent are named again.
       */
      'compliance.review': async ({ schoolId, payload }) => {
        const onDate = typeof payload?.onDate === 'string' ? payload.onDate : nowSql().slice(0, 10);
        const review = await this.retentionReview(schoolId, onDate);
        if (review.due) {
          const summary = review.policies.filter(p => p.rows > 0).map(p => `${p.entityType}: ${p.rows} older than ${p.keepYears} years (${p.action})`).join('; ');
          await this.notifications.notifyRoleOnce(schoolId, 'admin', { channels: ['in_app'], eventKey: 'compliance.retention_due', title: 'Records are past their retention period', body: summary, entityType: 'compliance.retention', entityId: schoolId, withinHours: 24 * 25 });
          await this.tasks.ensure({ schoolId, title: `${review.due} retention rule(s) have records past their period`, description: `${summary}. Nothing has been deleted: decide, record by record, what the school is still obliged to keep.`, taskType: 'compliance.retention', assignedRole: 'admin', entityType: 'compliance.retention', entityId: schoolId });
        }
        const census = await this.censusIfDue(schoolId, onDate);
        const stipends = await this.stipendListsIfDue(schoolId, onDate);
        const stale = await this.db.query<Row>(`SELECT * FROM govt_reports WHERE school_id = ? AND status = 'generated' AND created_at < ?`, [schoolId, nowSql(new Date(Date.now() - 14 * 86_400_000))]);
        for (const r of stale) {
          await this.notifications.notifyRoleOnce(schoolId, 'admin', { channels: ['in_app'], eventKey: 'compliance.report_unsent', title: `${r.report_type} for ${r.period} has not been submitted`, body: 'It was generated a fortnight ago and is still marked unsent.', entityType: 'compliance.report', entityId: String(r.id), withinHours: 24 * 14 });
          await this.tasks.ensure({ schoolId, title: `Submit the ${String(r.report_type).replace(/_/g, ' ')} for ${r.period}`, taskType: 'compliance.return', assignedRole: 'admin', entityType: 'compliance.report', entityId: String(r.id), priority: 'high' });
        }
        return { retentionDue: review.due, unsentReports: stale.length, censusGenerated: census.generated, stipendLists: stipends.length };
      },
      /**
       * O4, daily: the duties that run the other way, which have clocks on them.
       *
       * An export of what the school holds about somebody is produced entirely by this system — no
       * judgement, nothing irreversible — so a request that is still sitting unread is fulfilled and
       * the person is told their file is ready. A deletion or a correction is never done this way: a
       * school has records it is legally obliged to keep, only a person can weigh a request against
       * that, and so those are escalated on the statutory clock (`compliance.response_days`, thirty
       * by default) rather than acted on. Consent that has run out is the third: the school stops
       * being allowed to do the thing on the day the date passes, so the guardian is asked once to
       * renew it and the office is told what has lapsed.
       */
      'compliance.daily_watch': async ({ schoolId }) => {
        const now = nowSql();
        const days = Number((await this.settings.get<number>(schoolId, 'compliance.response_days')) ?? 30);
        // exports the system can finish by itself
        const exports_ = await this.db.query<Row>(`SELECT * FROM data_requests WHERE school_id = ? AND kind = 'export' AND status IN ('requested','processing') ORDER BY created_at LIMIT 25`, [schoolId]);
        let fulfilled = 0;
        for (const r of exports_) { await this.fulfilExport(schoolId, String(r.id)); fulfilled++; }
        // deletions and corrections: a person decides, and the clock is shown to them
        const overdue = await this.db.query<Row>(`SELECT d.*, u.display_name FROM data_requests d JOIN users u ON u.id = d.user_id WHERE d.school_id = ? AND d.kind <> 'export' AND d.status IN ('requested','processing') AND d.created_at < ?`, [schoolId, nowSql(new Date(Date.now() - days * 86_400_000))]);
        for (const r of overdue) {
          await this.notifications.notifyRoleOnce(schoolId, 'admin', { channels: ['in_app', 'email'], eventKey: 'compliance.request_overdue', title: `A ${r.kind} request is past its ${days}-day answer`, body: `${r.display_name} asked on ${String(r.created_at).slice(0, 10)} and has had no answer. Decide what the school is obliged to keep and answer them.`, entityType: 'compliance.data_request', entityId: String(r.id), withinHours: 24 * 7 });
          await this.tasks.ensure({ schoolId, title: `Answer the ${r.kind} request from ${r.display_name}`, taskType: 'compliance.data_request', assignedRole: 'admin', entityType: 'compliance.data_request', entityId: String(r.id), priority: 'high' });
        }
        // consent that has run out and has not been given again
        const expired = await this.db.query<Row>(`SELECT c.*, u.display_name, u.phone FROM consent_records c JOIN users u ON u.id = c.user_id
          WHERE c.school_id = ? AND c.granted = TRUE AND c.expires_at IS NOT NULL AND c.expires_at < ? AND c.expires_at > ?
          ORDER BY c.expires_at LIMIT 200`, [schoolId, now, nowSql(new Date(Date.now() - 60 * 86_400_000))]);
        let lapsed = 0;
        for (const c of expired) {
          const current = await this.hasConsent(schoolId, String(c.user_id), String(c.consent_type), (c.student_id as string) ?? null);
          if (current.granted) continue;                       // they have already renewed it
          await this.notifications.notifyOnce({ schoolId, userId: String(c.user_id), address: (c.phone as string) ?? null, channels: ['in_app', 'push'], eventKey: 'compliance.consent_expired', title: 'A permission you gave has run out', body: `Your consent for ${String(c.consent_type).replace(/_/g, ' ')} ran out on ${String(c.expires_at).slice(0, 10)}. Please renew it in the app if you are happy to.`, entityType: 'compliance.consent', entityId: String(c.id), withinHours: 24 * 30 });
          await this.outbox.emitNow({ type: 'consent.expired', schoolId, aggregateType: 'compliance.consent', aggregateId: String(c.id), payload: { consentId: String(c.id), userId: String(c.user_id), consentType: String(c.consent_type), expiredAt: String(c.expires_at) } });
          lapsed++;
        }
        if (lapsed) await this.notifications.notifyRoleOnce(schoolId, 'admin', { channels: ['in_app'], eventKey: 'compliance.consent_lapsed', title: `${lapsed} consent(s) have run out`, body: 'Until they are renewed the school may not do what they covered.', entityType: 'compliance.consent', entityId: schoolId, withinHours: 24 * 7 });
        return { exportsFulfilled: fulfilled, requestsOverdue: overdue.length, consentsLapsed: lapsed };
      },
    };
  }
}

/**
 * The period a stipend programme is asking for this month, or null when this is not the first month
 * of its cycle. Quarterly means January, April, July and October; half-yearly January and July.
 */
function periodFor(frequency: string, onDate: string): string | null {
  const month = Number(onDate.slice(5, 7));
  const every = frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : frequency === 'half_yearly' ? 6 : 12;
  return (month - 1) % every === 0 ? onDate.slice(0, 7) : null;
}

const csv = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
