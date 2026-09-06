import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters, JobContext, ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { AcademicService } from './academic.js';
import type { AccountingService } from './accounting.js';
import { round } from './accounting.js';
import type { ApprovalService } from '../approvals.js';
import type { TaskService } from '../tasks.js';
import type { FileService } from '../files.js';
import type { PeopleService } from './people.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface StructureInput { staffId: string; effectiveFrom: string; effectiveTo?: string | null; basic: number; mpoPortion?: number; payFrequency?: 'monthly' | 'weekly'; bankAccount?: { bankName?: string; accountNo?: string; branch?: string; routingNo?: string } | null; items?: { componentId: string; value: number }[] }
export interface LoanInput { staffId: string; loanType?: 'advance' | 'loan' | 'pf_loan'; principal: number; monthlyDeduction: number; startsFrom: string }
export interface ExitInput { staffId: string; exitType: 'resignation' | 'termination' | 'retirement' | 'end_of_contract' | 'death'; noticeDate?: string | null; lastWorkingDay: string; clearance?: Record<string, unknown> | null }

/** A tax slab: income above `from` (up to the next slab) is taxed at `rate` percent. */
export interface TaxSlab { from: number; rate: number }

/** NBR individual slabs (general category). The school can edit them per fiscal year. */
const NBR_SLABS: Record<string, TaxSlab[]> = {
  general: [{ from: 0, rate: 0 }, { from: 350_000, rate: 5 }, { from: 450_000, rate: 10 }, { from: 850_000, rate: 15 }, { from: 1_350_000, rate: 20 }, { from: 1_850_000, rate: 25 }],
  female_senior: [{ from: 0, rate: 0 }, { from: 400_000, rate: 5 }, { from: 500_000, rate: 10 }, { from: 900_000, rate: 15 }, { from: 1_400_000, rate: 20 }, { from: 1_900_000, rate: 25 }],
  disabled: [{ from: 0, rate: 0 }, { from: 475_000, rate: 5 }, { from: 575_000, rate: 10 }, { from: 975_000, rate: 15 }, { from: 1_475_000, rate: 20 }, { from: 1_975_000, rate: 25 }],
};

const DEFAULT_COMPONENTS: { name: string; code: string; type: 'earning' | 'deduction' | 'employer_contribution'; calc: 'fixed' | 'percent_of_basic' | 'slab'; value: number; taxable: boolean; statutory: boolean; gl: string | null; sort: number }[] = [
  { name: 'House rent', code: 'HRA', type: 'earning', calc: 'percent_of_basic', value: 50, taxable: true, statutory: false, gl: '5100', sort: 10 },
  { name: 'Medical allowance', code: 'MED', type: 'earning', calc: 'fixed', value: 700, taxable: false, statutory: false, gl: '5100', sort: 20 },
  { name: 'Conveyance', code: 'CONV', type: 'earning', calc: 'fixed', value: 500, taxable: false, statutory: false, gl: '5100', sort: 30 },
  { name: 'Provident fund (employee)', code: 'PF_EMP', type: 'deduction', calc: 'percent_of_basic', value: 10, taxable: false, statutory: true, gl: '2300', sort: 40 },
  { name: 'Provident fund (employer)', code: 'PF_ER', type: 'employer_contribution', calc: 'percent_of_basic', value: 10, taxable: false, statutory: true, gl: '5110', sort: 50 },
  { name: 'Income tax', code: 'TAX', type: 'deduction', calc: 'slab', value: 0, taxable: false, statutory: true, gl: '2400', sort: 60 },
];

/**
 * HR & payroll: recruitment through to exit. Salary structures are per staff with dated effect;
 * a payroll run reads them together with staff attendance, approved leave, loans and the tax slabs
 * of the fiscal year, and writes one frozen payslip per staff. Approving a run renders the payslip
 * PDFs and the bank transfer file in a chunked job, posts one balanced journal (salary expense and
 * employer PF against PF/tax payable, loan recovery, the MPO share as government grant income, and
 * salary payable for what the school itself owes), and tells each member of staff.
 */
export class HrService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService, private academic: AcademicService,
    private accounting: AccountingService, private approvals: ApprovalService, private tasks: TaskService, private files: FileService,
    private people: PeopleService, private adapters: Adapters,
  ) {}

  // ---------- recruitment ----------
  async postings(schoolId: string, opts: { publicOnly?: boolean } = {}) {
    const where: Row = { school_id: schoolId };
    if (opts.publicOnly) where.status = 'open';
    return this.db.findMany<Row>('job_postings', where, { orderBy: 'created_at DESC', limit: 100 });
  }
  async createPosting(schoolId: string, p: { title: string; departmentId?: string | null; designationId?: string | null; description?: string | null; vacancies?: number; salaryRange?: string | null; closesAt?: string | null; status?: 'draft' | 'open' | 'closed' }) {
    const id = ulid();
    await this.db.insert('job_postings', { id, school_id: schoolId, title: p.title, department_id: p.departmentId ?? null, designation_id: p.designationId ?? null, description: p.description ?? null, vacancies: p.vacancies ?? 1, salary_range: p.salaryRange ?? null, closes_at: p.closesAt ?? null, status: p.status ?? 'draft' });
    return id;
  }
  async setPostingStatus(schoolId: string, id: string, status: 'draft' | 'open' | 'closed') {
    return this.db.update('job_postings', { status, updated_at: nowSql() }, { id, school_id: schoolId });
  }
  /** Public application from the website; the posting must be open and not past its closing date. */
  async apply(schoolId: string, a: { postingId: string; fullName: string; phone: string; email?: string | null; cvFileId?: string | null; notes?: string | null }) {
    const posting = await this.db.findOne<Row>('job_postings', { id: a.postingId, school_id: schoolId });
    if (!posting) throw notFound('job posting');
    if (posting.status !== 'open') throw new HttpError(409, 'this vacancy is not open', 'closed');
    if (posting.closes_at && String(posting.closes_at) < nowSql().slice(0, 10)) throw new HttpError(409, 'this vacancy has closed', 'closed');
    if (await this.db.findOne('job_applicants', { posting_id: a.postingId, phone: a.phone })) throw new HttpError(409, 'you have already applied for this vacancy', 'duplicate');
    const id = ulid();
    await this.db.insert('job_applicants', { id, school_id: schoolId, posting_id: a.postingId, full_name: a.fullName, phone: a.phone, email: a.email ?? null, cv_file_id: a.cvFileId ?? null, score: null, stage: 'applied', interview_at: null, notes: a.notes ?? null, staff_id: null });
    await this.outbox.emitNow({ type: 'application.received', schoolId, aggregateType: 'hr.applicant', aggregateId: id, payload: { applicantId: id, postingId: a.postingId, title: String(posting.title), name: a.fullName } });
    return id;
  }
  async applicants(schoolId: string, postingId?: string) {
    const where: Row = { school_id: schoolId };
    if (postingId) where.posting_id = postingId;
    return this.db.findMany<Row>('job_applicants', where, { orderBy: 'created_at DESC', limit: 300 });
  }
  /** Moves an applicant along the pipeline; `hired` creates the staff record and emits staff.joined. */
  async moveApplicant(schoolId: string, id: string, stage: 'applied' | 'shortlisted' | 'interview' | 'offered' | 'hired' | 'rejected', opts: { interviewAt?: string | null; score?: number | null; notes?: string | null; joinDate?: string; staffCategory?: 'teaching' | 'non_teaching' | 'admin' | 'support'; designationId?: string | null; departmentId?: string | null } = {}) {
    const a = await this.db.findOne<Row>('job_applicants', { id, school_id: schoolId });
    if (!a) throw notFound('applicant');
    let staffId = (a.staff_id as string) ?? null;
    if (stage === 'hired' && !staffId) {
      const [first, ...rest] = String(a.full_name).split(/\s+/);
      const created = await this.people.createStaff(schoolId, { firstName: first as string, lastName: rest.join(' ') || null, phone: String(a.phone), email: (a.email as string) ?? null, staffCategory: opts.staffCategory ?? 'teaching', joinDate: opts.joinDate ?? nowSql().slice(0, 10), designationId: opts.designationId ?? (a.designation_id as string) ?? null, departmentId: opts.departmentId ?? null });
      staffId = created.id;
      await this.onStaffJoined(schoolId, staffId, created.userId);
    }
    await this.db.update('job_applicants', { stage, interview_at: opts.interviewAt ?? a.interview_at, score: opts.score ?? a.score, notes: opts.notes ?? a.notes, staff_id: staffId, updated_at: nowSql() }, { id });
    return { id, stage, staffId };
  }

  // ---------- onboarding ----------
  /** H5: the checklist, the tasks that go with it and an alert to HR. */
  async onStaffJoined(schoolId: string, staffId: string, userId?: string | null) {
    const items = [
      { key: 'id_card', label: 'Issue ID card', done: false },
      { key: 'biometric', label: 'Enrol on the attendance device', done: false },
      { key: 'bank', label: 'Collect bank account details', done: false },
      { key: 'salary_structure', label: 'Set the salary structure', done: false },
      { key: 'documents', label: 'Collect NID, certificates and photo', done: false },
      { key: 'contract', label: 'Sign the contract', done: false },
    ];
    if (!(await this.db.findOne('onboarding_checklists', { staff_id: staffId }))) {
      await this.db.insert('onboarding_checklists', { id: ulid(), school_id: schoolId, staff_id: staffId, items: items as never, completed_at: null });
    }
    await this.tasks.create({ schoolId, title: 'Set the salary structure for a new colleague', taskType: 'hr.onboarding', assignedRole: 'accountant', entityType: 'hr.staff', entityId: staffId, priority: 'high' });
    await this.outbox.emitNow({ type: 'staff.joined', schoolId, aggregateType: 'people.staff', aggregateId: staffId, payload: { staffId, userId: userId ?? null } });
    return items.length;
  }
  async onboarding(schoolId: string, staffId: string) { return this.db.findOne<Row>('onboarding_checklists', { school_id: schoolId, staff_id: staffId }); }
  async completeOnboardingItem(schoolId: string, staffId: string, key: string) {
    const row = await this.db.findOne<Row>('onboarding_checklists', { school_id: schoolId, staff_id: staffId });
    if (!row) throw notFound('onboarding checklist');
    const items = (json<{ key: string; label: string; done: boolean }[]>(row.items) ?? []).map(i => (i.key === key ? { ...i, done: true } : i));
    const all = items.every(i => i.done);
    await this.db.update('onboarding_checklists', { items: items as never, completed_at: all ? nowSql() : null, updated_at: nowSql() }, { id: String(row.id) });
    return { items, completed: all };
  }

  // ---------- contracts, shifts ----------
  async addContract(schoolId: string, c: { staffId: string; contractType: 'permanent' | 'contract' | 'part_time' | 'intern' | 'volunteer' | 'mpo'; startDate: string; endDate?: string | null; fileId?: string | null; notes?: string | null }) {
    const id = ulid();
    await this.db.insert('staff_contracts', { id, school_id: schoolId, staff_id: c.staffId, contract_type: c.contractType, start_date: c.startDate, end_date: c.endDate ?? null, file_id: c.fileId ?? null, notes: c.notes ?? null });
    return id;
  }
  async contracts(schoolId: string, staffId?: string) {
    const where: Row = { school_id: schoolId };
    if (staffId) where.staff_id = staffId;
    return this.db.findMany<Row>('staff_contracts', where, { orderBy: 'start_date DESC', limit: 200 });
  }
  async createShift(schoolId: string, s: { name: string; startTime: string; endTime: string; days?: number[] }) {
    const id = ulid();
    await this.db.insert('work_shifts', { id, school_id: schoolId, name: s.name, start_time: s.startTime, end_time: s.endTime, days: (s.days ?? [0, 1, 2, 3, 4]) as never });
    return id;
  }
  async shifts(schoolId: string) { return this.db.findMany<Row>('work_shifts', { school_id: schoolId }, { orderBy: 'start_time ASC' }); }
  async assignShift(schoolId: string, a: { staffId: string; shiftId: string; fromDate: string; toDate?: string | null }) {
    await this.db.execute(`UPDATE staff_shift_assignments SET to_date = ? WHERE school_id = ? AND staff_id = ? AND (to_date IS NULL OR to_date >= ?)`, [a.fromDate, schoolId, a.staffId, a.fromDate]);
    const id = ulid();
    await this.db.insert('staff_shift_assignments', { id, school_id: schoolId, staff_id: a.staffId, shift_id: a.shiftId, from_date: a.fromDate, to_date: a.toDate ?? null });
    return id;
  }

  // ---------- salary structure ----------
  async ensureSalaryComponents(schoolId: string) {
    if (await this.db.count('salary_components', { school_id: schoolId })) return 0;
    for (const c of DEFAULT_COMPONENTS) {
      const gl = c.gl ? await this.db.findOne<{ id: string }>('gl_accounts', { school_id: schoolId, code: c.gl }) : null;
      await this.db.insert('salary_components', { id: ulid(), school_id: schoolId, name: c.name, code: c.code, component_type: c.type, calc_type: c.calc, default_value: c.value, formula: null, is_taxable: c.taxable, is_statutory: c.statutory, gl_account_id: gl?.id ?? null, sort_order: c.sort });
    }
    return DEFAULT_COMPONENTS.length;
  }
  async components(schoolId: string) { return this.db.findMany<Row>('salary_components', { school_id: schoolId }, { orderBy: 'sort_order ASC' }); }
  async addComponent(schoolId: string, c: { name: string; code: string; componentType: 'earning' | 'deduction' | 'employer_contribution'; calcType?: 'fixed' | 'percent_of_basic' | 'percent_of_gross' | 'formula' | 'attendance_based' | 'slab'; defaultValue?: number; isTaxable?: boolean; isStatutory?: boolean; glAccountId?: string | null; sortOrder?: number }) {
    if (await this.db.findOne('salary_components', { school_id: schoolId, code: c.code })) throw new HttpError(409, `component ${c.code} exists`, 'conflict');
    const id = ulid();
    await this.db.insert('salary_components', { id, school_id: schoolId, name: c.name, code: c.code, component_type: c.componentType, calc_type: c.calcType ?? 'fixed', default_value: c.defaultValue ?? 0, formula: null, is_taxable: c.isTaxable ?? true, is_statutory: c.isStatutory ?? false, gl_account_id: c.glAccountId ?? null, sort_order: c.sortOrder ?? 90 });
    return id;
  }
  /** Sets the current structure; an earlier open-ended one is closed the day before this one starts. */
  async setStructure(schoolId: string, s: StructureInput, approvedBy?: string | null) {
    if (!(await this.db.findOne('staff', { id: s.staffId, school_id: schoolId }))) throw notFound('staff');
    if (s.basic <= 0) throw badRequest('basic pay must be greater than zero');
    if ((s.mpoPortion ?? 0) < 0) throw badRequest('the MPO portion cannot be negative');
    await this.ensureSalaryComponents(schoolId);
    const id = ulid();
    const dayBefore = isoDay(s.effectiveFrom, -1);
    await this.db.transaction(async tx => {
      await tx.execute(`UPDATE salary_structures SET effective_to = ?, updated_at = ? WHERE school_id = ? AND staff_id = ? AND effective_from < ? AND (effective_to IS NULL OR effective_to >= ?)`, [dayBefore, nowSql(), schoolId, s.staffId, s.effectiveFrom, s.effectiveFrom]);
      await tx.delete('salary_structures', { school_id: schoolId, staff_id: s.staffId, effective_from: s.effectiveFrom });
      await tx.insert('salary_structures', { id, school_id: schoolId, staff_id: s.staffId, effective_from: s.effectiveFrom, effective_to: s.effectiveTo ?? null, basic: round(s.basic), pay_frequency: s.payFrequency ?? 'monthly', mpo_portion: round(s.mpoPortion ?? 0), bank_account: (s.bankAccount ?? null) as never, approved_by: approvedBy ?? null });
      const items = s.items ?? (await tx.findMany<Row>('salary_components', { school_id: schoolId })).filter(c => c.calc_type !== 'slab').map(c => ({ componentId: String(c.id), value: Number(c.default_value ?? 0) }));
      if (items.length) await tx.insertMany('salary_structure_items', items.map(i => ({ id: ulid(), school_id: schoolId, structure_id: id, component_id: i.componentId, value: round(i.value) })));
    });
    return id;
  }
  async structureFor(schoolId: string, staffId: string, onDate = nowSql().slice(0, 10)): Promise<(Row & { items: Row[] }) | null> {
    const rows = await this.db.query<Row>(`SELECT * FROM salary_structures WHERE school_id = ? AND staff_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC, id DESC LIMIT 1`, [schoolId, staffId, onDate, onDate]);
    if (!rows[0]) return null;
    const items = await this.db.query<Row>(`SELECT i.*, c.code, c.name, c.component_type, c.calc_type, c.is_taxable, c.is_statutory FROM salary_structure_items i JOIN salary_components c ON c.id = i.component_id WHERE i.structure_id = ? ORDER BY c.sort_order`, [String(rows[0].id)]);
    return { ...rows[0], items } as Row & { items: Row[] };
  }

  // ---------- tax ----------
  async ensureTaxSlabs(schoolId: string, fiscalYearId?: string) {
    const fy = fiscalYearId ? await this.db.findOne<Row>('fiscal_years', { id: fiscalYearId, school_id: schoolId }) : await this.accounting.fiscalYear(schoolId);
    if (!fy) throw notFound('fiscal year');
    let made = 0;
    for (const [category, slabs] of Object.entries(NBR_SLABS)) {
      if (await this.db.findOne('tax_slabs', { school_id: schoolId, fiscal_year_id: String(fy.id), category })) continue;
      await this.db.insert('tax_slabs', { id: ulid(), school_id: schoolId, fiscal_year_id: String(fy.id), category, slabs: slabs as never });
      made++;
    }
    return made;
  }
  async taxFor(schoolId: string, fiscalYearId: string, category = 'general'): Promise<TaxSlab[]> {
    const row = await this.db.findOne<Row>('tax_slabs', { school_id: schoolId, fiscal_year_id: fiscalYearId, category });
    return json<TaxSlab[]>(row?.slabs) ?? NBR_SLABS[category] ?? NBR_SLABS.general!;
  }
  /** Annual tax on `annual` taxable income, walking the slabs from the bottom. */
  static annualTax(annual: number, slabs: TaxSlab[]) {
    const sorted = [...slabs].sort((a, b) => a.from - b.from);
    let tax = 0;
    for (let i = 0; i < sorted.length; i++) {
      const from = sorted[i]!.from;
      const to = sorted[i + 1]?.from ?? Infinity;
      if (annual <= from) break;
      tax += ((Math.min(annual, to) - from) * sorted[i]!.rate) / 100;
    }
    return round(tax);
  }

  // ---------- loans ----------
  async requestLoan(schoolId: string, l: LoanInput, requestedBy?: string | null) {
    if (l.principal <= 0 || l.monthlyDeduction <= 0) throw badRequest('a loan needs a principal and a monthly deduction');
    if (l.monthlyDeduction > l.principal) throw badRequest('the monthly deduction cannot exceed the principal');
    const id = ulid();
    await this.db.insert('staff_loans', { id, school_id: schoolId, staff_id: l.staffId, loan_type: l.loanType ?? 'loan', principal: round(l.principal), monthly_deduction: round(l.monthlyDeduction), balance: round(l.principal), starts_from: l.startsFrom, status: 'pending', approved_by: requestedBy ?? null, journal_entry_id: null });
    const ap = await this.approvals.request({ schoolId, entityType: 'hr.loan', entityId: id, summary: { staffId: l.staffId, principal: l.principal } });
    if (ap.status === 'approved') await this.approveLoan(schoolId, id, requestedBy);
    return { id, approval: ap.status };
  }
  /** Approving pays the money out: Dr advances (an asset the school will recover), Cr cash. */
  async approveLoan(schoolId: string, id: string, approvedBy?: string | null) {
    const loan = await this.db.findOne<Row>('staff_loans', { id, school_id: schoolId });
    if (!loan) throw notFound('loan');
    if (loan.status === 'active') return { id, status: 'active' };
    const j = await this.accounting.post(schoolId, { entryDate: String(loan.starts_from), memo: `Staff loan ${id}`, sourceType: 'hr.loan', sourceId: id, lines: [{ accountCode: '1400', debit: Number(loan.principal), description: 'Staff advance' }, { accountCode: '1100', credit: Number(loan.principal) }] });
    await this.db.update('staff_loans', { status: 'active', approved_by: approvedBy ?? null, journal_entry_id: j.id, updated_at: nowSql() }, { id });
    return { id, status: 'active', journalEntryId: j.id };
  }
  async loans(schoolId: string, staffId?: string) {
    const where: Row = { school_id: schoolId };
    if (staffId) where.staff_id = staffId;
    return this.db.findMany<Row>('staff_loans', where, { orderBy: 'created_at DESC', limit: 200 });
  }

  // ---------- payroll ----------
  /** Creates (or reuses) a draft run for the month and queues the calculation. */
  async draftRun(schoolId: string, p: { periodMonth: string; campusId?: string | null; createdBy?: string | null }) {
    const month = `${p.periodMonth.slice(0, 7)}-01`;
    const ex = await this.db.findOne<Row>('payroll_runs', { school_id: schoolId, period_month: month, campus_id: p.campusId ?? null });
    if (ex && ['approved', 'paid', 'locked'].includes(String(ex.status))) throw new HttpError(409, `payroll for ${month.slice(0, 7)} is already ${ex.status}`, 'conflict');
    const id = (ex?.id as string) ?? ulid();
    if (!ex) await this.db.insert('payroll_runs', { id, school_id: schoolId, period_month: month, campus_id: p.campusId ?? null, status: 'draft', staff_count: 0, total_gross: 0, total_deductions: 0, total_net: 0, total_mpo: 0, created_by: p.createdBy ?? null });
    else await this.db.update('payroll_runs', { status: 'draft', updated_at: nowSql() }, { id });
    await this.adapters.queue.push({ name: 'payroll.calculate', queue: 'batch', schoolId, payload: { runId: id }, triggeredBy: 'hr.payroll' });
    return { id, month, queued: true };
  }

  /** Chunked: 25 staff per pass, so a shared-hosting request never runs long. */
  async calculateRun(payload: Record<string, unknown>, ctx: JobContext) {
    const runId = String(payload.runId);
    const run = await this.db.findOne<Row>('payroll_runs', { id: runId });
    if (!run) throw notFound('payroll run');
    const schoolId = String(run.school_id);
    const month = String(run.period_month).slice(0, 10);
    const from = month, to = monthEnd(month);
    const staff = await this.db.query<Row>(`SELECT * FROM staff WHERE school_id = ? AND status IN ('active','probation','on_leave') AND (leave_date IS NULL OR leave_date >= ?) AND join_date <= ?${run.campus_id ? ' AND campus_id = ?' : ''} ORDER BY id`, run.campus_id ? [schoolId, from, to, String(run.campus_id)] : [schoolId, from, to]);
    const workingDays = await this.workingDays(schoolId, from, to);
    const fy = await this.accounting.fiscalYear(schoolId, month);
    const slabs = await this.taxFor(schoolId, String(fy.id));
    const cursor = (ctx.job.cursor as { done?: number } | null) ?? {};
    let done = cursor.done ?? 0;
    const CHUNK = 25;
    while (done < staff.length) {
      for (const st of staff.slice(done, done + CHUNK)) await this.buildPayslip(schoolId, runId, st, { from, to, workingDays, slabs });
      done = Math.min(staff.length, done + CHUNK);
      await ctx.progress(done, staff.length, { done });
      if (Date.now() > ctx.deadline && done < staff.length) return { continue: true as const, cursor: { done } };
    }
    const totals = await this.runTotals(runId);
    await this.db.update('payroll_runs', { status: 'calculated', staff_count: totals.staff, total_gross: totals.gross, total_deductions: totals.deductions, total_net: totals.net, total_mpo: totals.mpo, calculated_at: nowSql(), updated_at: nowSql() }, { id: runId });
    const ap = await this.approvals.request({ schoolId, entityType: 'hr.payroll', entityId: runId, summary: { month: month.slice(0, 7), staff: totals.staff, net: totals.net } });
    await this.outbox.emitNow({ type: 'payroll.calculated', schoolId, aggregateType: 'hr.payroll', aggregateId: runId, payload: { runId, month: month.slice(0, 7), staff: totals.staff, gross: totals.gross, net: totals.net, approvalStatus: ap.status } });
    if (ap.status === 'approved') await this.approveRun(schoolId, runId);
    return { result: { staff: totals.staff, net: totals.net } };
  }

  /** One frozen payslip: attendance → LOP, structure → earnings, loans and tax → deductions. */
  private async buildPayslip(schoolId: string, runId: string, st: Row, ctx: { from: string; to: string; workingDays: number; slabs: TaxSlab[] }) {
    const staffId = String(st.id);
    const structure = await this.structureFor(schoolId, staffId, ctx.to);
    if (!structure) return null;              // nobody is paid without an approved structure
    const att = await this.db.query<{ status: string; n: number; late: number; ot: number }>(
      `SELECT status, COUNT(*) AS n, COALESCE(SUM(late_minutes), 0) AS late, COALESCE(SUM(overtime_minutes), 0) AS ot FROM staff_attendance WHERE staff_id = ? AND on_date BETWEEN ? AND ? GROUP BY status`, [staffId, ctx.from, ctx.to]);
    const by = (s: string) => Number(att.find(a => a.status === s)?.n ?? 0);
    const present = by('present') + by('late') + by('wfh') + by('half_day') * 0.5;
    const lateCount = by('late');
    const overtimeHours = round(att.reduce((a, r) => a + Number(r.ot ?? 0), 0) / 60);
    // approved leave inside the month, split into paid and unpaid by leave type
    const leaves = await this.db.query<{ days: number; is_paid: number | boolean }>(
      `SELECT l.days, t.is_paid FROM leave_applications l JOIN leave_types t ON t.id = l.leave_type_id WHERE l.school_id = ? AND l.applicant_type = 'staff' AND l.staff_id = ? AND l.status = 'approved' AND l.from_date <= ? AND l.to_date >= ?`, [schoolId, staffId, ctx.to, ctx.from]);
    const paidLeave = round(leaves.filter(l => truthy(l.is_paid)).reduce((a, l) => a + Number(l.days), 0));
    const unpaidLeave = round(leaves.filter(l => !truthy(l.is_paid)).reduce((a, l) => a + Number(l.days), 0));
    const policy = await this.db.findOne<Row>('attendance_policies', { school_id: schoolId, audience: 'staff', is_active: true });
    const lateToLop = Number(policy?.late_count_to_lop ?? 0);
    const lateLop = lateToLop > 0 ? Math.floor(lateCount / lateToLop) : 0;
    const joinedThisMonth = String(st.join_date) > ctx.from ? daysBetween(ctx.from, String(st.join_date)) : 0;
    const accounted = present + paidLeave + unpaidLeave;
    // days neither worked nor covered by leave are loss of pay; a mid-month joiner is not charged for
    // the days before joining, and attendance that was never marked is treated as worked.
    const lop = round(Math.max(0, Math.min(ctx.workingDays - joinedThisMonth, unpaidLeave + lateLop + (accounted > 0 ? Math.max(0, ctx.workingDays - joinedThisMonth - accounted) : 0))));
    const payableRatio = ctx.workingDays > 0 ? Math.max(0, (ctx.workingDays - lop - joinedThisMonth)) / ctx.workingDays : 1;

    const basic = round(Number(structure.basic) * payableRatio);
    const items = structure.items;
    const earnings: { code: string; name: string; amount: number; taxable: boolean }[] = [{ code: 'BASIC', name: 'Basic pay', amount: basic, taxable: true }];
    const deductions: { code: string; name: string; amount: number }[] = [];
    let employerPf = 0;
    for (const i of items) {
      const value = Number(i.value ?? 0);
      const amount = round(i.calc_type === 'percent_of_basic' ? (basic * value) / 100 : value * payableRatio);
      if (!amount) continue;
      if (i.component_type === 'earning') earnings.push({ code: String(i.code), name: String(i.name), amount, taxable: truthy(i.is_taxable) });
      else if (i.component_type === 'deduction') deductions.push({ code: String(i.code), name: String(i.name), amount });
      else employerPf = round(employerPf + amount);
    }
    const overtimeRate = ctx.workingDays > 0 ? round(Number(structure.basic) / (ctx.workingDays * 8)) : 0;
    if (overtimeHours > 0 && overtimeRate > 0) earnings.push({ code: 'OT', name: 'Overtime', amount: round(overtimeHours * overtimeRate * 2), taxable: true });
    const gross = round(earnings.reduce((a, e) => a + e.amount, 0));
    const taxable = round(earnings.filter(e => e.taxable).reduce((a, e) => a + e.amount, 0));
    const tax = round(HrService.annualTax(taxable * 12, ctx.slabs) / 12);
    if (tax > 0) deductions.push({ code: 'TAX', name: 'Income tax', amount: tax });
    // loan instalment: never more than what is still owed
    const loan = await this.db.findOne<Row>('staff_loans', { school_id: schoolId, staff_id: staffId, status: 'active' });
    const loanCut = loan ? round(Math.min(Number(loan.monthly_deduction), Number(loan.balance))) : 0;
    if (loanCut > 0) deductions.push({ code: 'LOAN', name: 'Loan instalment', amount: loanCut });
    const totalDeductions = round(deductions.reduce((a, d) => a + d.amount, 0));
    const net = round(gross - totalDeductions);
    const mpo = round(Math.min(Number(structure.mpo_portion ?? 0) * payableRatio, net));

    const breakdown = { earnings, deductions, employerPf, mpo, loanId: loan ? String(loan.id) : null, employeePf: deductions.find(d => d.code === 'PF_EMP')?.amount ?? 0, payableRatio: round(payableRatio * 100) };
    const row = {
      school_id: schoolId, payroll_run_id: runId, staff_id: staffId, structure_id: String(structure.id),
      working_days: ctx.workingDays, present_days: round(present), paid_leave_days: paidLeave, lop_days: lop, late_count: lateCount, overtime_hours: overtimeHours,
      gross, total_deductions: totalDeductions, tax, net_pay: net, breakdown: breakdown as never, payslip_file_id: null, paid_at: null, payment_ref: null, status: 'draft', hold_reason: null,
    };
    const ex = await this.db.findOne<Row>('payslips', { payroll_run_id: runId, staff_id: staffId });
    if (ex) { await this.db.update('payslips', { ...row, updated_at: nowSql() }, { id: String(ex.id) }); return String(ex.id); }
    const id = ulid();
    await this.db.insert('payslips', { id, ...row });
    return id;
  }

  private async runTotals(runId: string) {
    const rows = await this.db.query<Row>(`SELECT * FROM payslips WHERE payroll_run_id = ?`, [runId]);
    let gross = 0, deductions = 0, net = 0, mpo = 0, tax = 0, employerPf = 0, employeePf = 0, loans = 0;
    for (const r of rows) {
      const b = json<{ employerPf?: number; employeePf?: number; mpo?: number; deductions?: { code: string; amount: number }[] }>(r.breakdown) ?? {};
      gross = round(gross + Number(r.gross)); deductions = round(deductions + Number(r.total_deductions)); net = round(net + Number(r.net_pay));
      tax = round(tax + Number(r.tax)); mpo = round(mpo + Number(b.mpo ?? 0));
      employerPf = round(employerPf + Number(b.employerPf ?? 0)); employeePf = round(employeePf + Number(b.employeePf ?? 0));
      loans = round(loans + Number(b.deductions?.find(d => d.code === 'LOAN')?.amount ?? 0));
    }
    return { staff: rows.length, gross, deductions, net, mpo, tax, employerPf, employeePf, loans, rows };
  }

  /** H2: approve → payslip PDFs, bank file, journal, loan and PF updates, one message per member of staff. */
  async approveRun(schoolId: string, runId: string, approvedBy?: string | null) {
    const run = await this.db.findOne<Row>('payroll_runs', { id: runId, school_id: schoolId });
    if (!run) throw notFound('payroll run');
    if (run.status === 'draft') throw new HttpError(409, 'calculate the run first', 'not_calculated');
    if (['approved', 'paid', 'locked'].includes(String(run.status))) return { id: runId, status: String(run.status) };
    await this.db.update('payroll_runs', { status: 'approved', approved_by: approvedBy ?? null, approved_at: nowSql(), updated_at: nowSql() }, { id: runId });
    await this.db.execute(`UPDATE payslips SET status = 'approved', updated_at = ? WHERE payroll_run_id = ? AND status = 'draft'`, [nowSql(), runId]);
    await this.adapters.queue.push({ name: 'payroll.payslips', queue: 'batch', schoolId, payload: { runId }, triggeredBy: 'hr.payroll' });
    await this.outbox.emitNow({ type: 'payroll.approved', schoolId, aggregateType: 'hr.payroll', aggregateId: runId, payload: { runId, month: String(run.period_month).slice(0, 7) } });
    return { id: runId, status: 'approved' };
  }

  /** Chunked payslip rendering; the journal, the bank file and the notifications follow the last chunk. */
  async renderPayslips(payload: Record<string, unknown>, ctx: JobContext) {
    const runId = String(payload.runId);
    const run = await this.db.findOne<Row>('payroll_runs', { id: runId });
    if (!run) throw notFound('payroll run');
    const schoolId = String(run.school_id);
    const school = await this.db.findOne<Row>('schools', { id: schoolId });
    const slips = await this.db.query<Row>(`SELECT p.*, s.first_name, s.last_name, s.employee_no, s.designation_id, s.user_id, s.phone FROM payslips p JOIN staff s ON s.id = p.staff_id WHERE p.payroll_run_id = ? ORDER BY p.id`, [runId]);
    const cursor = (ctx.job.cursor as { done?: number } | null) ?? {};
    let done = cursor.done ?? 0;
    const CHUNK = 25;
    while (done < slips.length) {
      for (const s of slips.slice(done, done + CHUNK)) {
        if (s.payslip_file_id) continue;
        const pdf = await this.adapters.pdf.render(this.payslipDoc(school, run, s));
        const f = await this.files.store({ schoolId, data: pdf, fileName: `payslip-${s.employee_no}-${String(run.period_month).slice(0, 7)}.pdf`, mimeType: 'application/pdf', purpose: 'payslip', entityType: 'hr.payslip', entityId: String(s.id) });
        await this.db.update('payslips', { payslip_file_id: f.id, updated_at: nowSql() }, { id: String(s.id) });
      }
      done = Math.min(slips.length, done + CHUNK);
      await ctx.progress(done, slips.length, { done });
      if (Date.now() > ctx.deadline && done < slips.length) return { continue: true as const, cursor: { done } };
    }
    if (!run.journal_entry_id) await this.postPayrollJournal(schoolId, runId);
    if (!run.bank_file_id) await this.buildBankFile(schoolId, runId);
    for (const s of slips) {
      await this.notifications.notify({ schoolId, userId: (s.user_id as string) ?? null, address: (s.phone as string) ?? null, channels: ['in_app', 'push', 'sms'], eventKey: 'payroll.payslip_ready', data: { month: String(run.period_month).slice(0, 7), net: Number(s.net_pay) }, title: 'Payslip ready', body: `Your payslip for ${String(run.period_month).slice(0, 7)} is ready. Net pay ${Number(s.net_pay)}.`, entityType: 'hr.payslip', entityId: String(s.id) });
    }
    return { result: { payslips: slips.length } };
  }

  /** One balanced entry for the whole run (see the class comment for the shape). */
  private async postPayrollJournal(schoolId: string, runId: string) {
    const t = await this.runTotals(runId);
    if (!t.staff) return null;
    const salaryPayable = round(t.net - t.mpo);
    const j = await this.accounting.post(schoolId, {
      entryDate: monthEnd(String((await this.db.findOne<Row>('payroll_runs', { id: runId }))!.period_month).slice(0, 10)),
      memo: `Payroll ${runId}`, sourceType: 'hr.payroll', sourceId: runId,
      lines: [
        { accountCode: '5100', debit: t.gross, description: 'Salaries & allowances' },
        { accountCode: '5110', debit: t.employerPf, description: 'Employer PF contribution' },
        { accountCode: '2300', credit: round(t.employeePf + t.employerPf), description: 'Provident fund payable' },
        { accountCode: '2400', credit: t.tax, description: 'Tax deducted at source' },
        { accountCode: '1400', credit: t.loans, description: 'Staff loan recovery' },
        { accountCode: '4200', credit: t.mpo, description: 'MPO government grant' },
        { accountCode: '2200', credit: salaryPayable, description: 'Salary payable' },
      ],
    });
    await this.db.update('payroll_runs', { journal_entry_id: j.id, updated_at: nowSql() }, { id: runId });
    // the money side of the deductions: loan balances down, PF balances up
    for (const r of t.rows) {
      const b = json<{ employerPf?: number; employeePf?: number; loanId?: string | null; deductions?: { code: string; amount: number }[] }>(r.breakdown) ?? {};
      const cut = Number(b.deductions?.find(d => d.code === 'LOAN')?.amount ?? 0);
      if (b.loanId && cut > 0) {
        const loan = await this.db.findOne<Row>('staff_loans', { id: b.loanId });
        if (loan) {
          const balance = round(Math.max(0, Number(loan.balance) - cut));
          await this.db.update('staff_loans', { balance, status: balance <= 0 ? 'closed' : 'active', updated_at: nowSql() }, { id: String(loan.id) });
        }
      }
      const emp = Number(b.employeePf ?? 0), er = Number(b.employerPf ?? 0);
      if (emp || er) {
        const acc = await this.db.findOne<Row>('provident_fund_accounts', { school_id: schoolId, staff_id: String(r.staff_id) });
        if (acc) await this.db.update('provident_fund_accounts', { employee_total: round(Number(acc.employee_total) + emp), employer_total: round(Number(acc.employer_total) + er), updated_at: nowSql() }, { id: String(acc.id) });
        else await this.db.insert('provident_fund_accounts', { id: ulid(), school_id: schoolId, staff_id: String(r.staff_id), employee_total: emp, employer_total: er, interest_total: 0, withdrawn_total: 0 });
      }
    }
    return j.id;
  }

  /** A bank bulk-transfer file (CSV): account, name, amount, reference. */
  private async buildBankFile(schoolId: string, runId: string) {
    const run = await this.db.findOne<Row>('payroll_runs', { id: runId });
    const rows = await this.db.query<Row>(`SELECT p.*, s.first_name, s.last_name, s.employee_no, ss.bank_account FROM payslips p JOIN staff s ON s.id = p.staff_id LEFT JOIN salary_structures ss ON ss.id = p.structure_id WHERE p.payroll_run_id = ? ORDER BY s.employee_no`, [runId]);
    const period = String(run?.period_month ?? '').slice(0, 7);
    const lines = ['account_no,account_name,bank,branch,amount,reference'];
    for (const r of rows) {
      const bank = json<{ bankName?: string; accountNo?: string; branch?: string }>(r.bank_account) ?? {};
      const payable = round(Number(r.net_pay) - Number(json<{ mpo?: number }>(r.breakdown)?.mpo ?? 0));
      if (payable <= 0) continue;
      lines.push([bank.accountNo ?? '', `${r.first_name} ${r.last_name ?? ''}`.trim(), bank.bankName ?? '', bank.branch ?? '', payable.toFixed(2), `SAL-${period}-${r.employee_no}`].map(csv).join(','));
    }
    const f = await this.files.store({ schoolId, data: Buffer.from(lines.join('\r\n'), 'utf8'), fileName: `payroll-${period}.csv`, mimeType: 'text/csv', purpose: 'payroll_bank_file', entityType: 'hr.payroll', entityId: runId });
    await this.db.update('payroll_runs', { bank_file_id: f.id, updated_at: nowSql() }, { id: runId });
    return f.id;
  }

  /** Pays an approved run from a bank account: Dr salary payable, Cr bank. */
  async payRun(schoolId: string, runId: string, p: { bankAccountId?: string | null; paidAt?: string; reference?: string | null } = {}) {
    const run = await this.db.findOne<Row>('payroll_runs', { id: runId, school_id: schoolId });
    if (!run) throw notFound('payroll run');
    if (run.status !== 'approved') throw new HttpError(409, `a ${run.status} run cannot be paid`, 'not_approved');
    const t = await this.runTotals(runId);
    const payable = round(t.net - t.mpo);
    const paidAt = p.paidAt ?? nowSql();
    const bank = p.bankAccountId ? await this.db.findOne<Row>('bank_accounts', { id: p.bankAccountId, school_id: schoolId }) : null;
    const cash = bank ? { accountId: String(bank.gl_account_id), credit: payable, description: `Paid from ${bank.bank_name}` } : { accountCode: '1210', credit: payable, description: 'Paid from the collection account' };
    const j = await this.accounting.post(schoolId, { entryDate: paidAt.slice(0, 10), memo: `Payroll payment ${runId}`, sourceType: 'hr.payroll_payment', sourceId: runId, lines: [{ accountCode: '2200', debit: payable, description: 'Salary payable cleared' }, cash] });
    await this.db.update('payroll_runs', { status: 'paid', paid_from_id: p.bankAccountId ?? null, paid_at: paidAt, updated_at: nowSql() }, { id: runId });
    await this.db.execute(`UPDATE payslips SET status = 'paid', paid_at = ?, payment_ref = ?, updated_at = ? WHERE payroll_run_id = ?`, [paidAt, p.reference ?? `SAL-${String(run.period_month).slice(0, 7)}`, nowSql(), runId]);
    await this.outbox.emitNow({ type: 'payroll.paid', schoolId, aggregateType: 'hr.payroll', aggregateId: runId, payload: { runId, amount: payable, journalEntryId: j.id } });
    return { id: runId, status: 'paid', amount: payable, journalEntryId: j.id };
  }

  async runs(schoolId: string, limit = 24) { return this.db.findMany<Row>('payroll_runs', { school_id: schoolId }, { orderBy: 'period_month DESC', limit }); }
  async run(schoolId: string, runId: string) {
    const run = await this.db.findOne<Row>('payroll_runs', { id: runId, school_id: schoolId });
    if (!run) throw notFound('payroll run');
    const payslips = await this.db.query<Row>(`SELECT p.*, s.first_name, s.last_name, s.employee_no, s.staff_category FROM payslips p JOIN staff s ON s.id = p.staff_id WHERE p.payroll_run_id = ? ORDER BY s.employee_no LIMIT 2000`, [runId]);
    return { run, payslips };
  }
  async payslip(schoolId: string, id: string) {
    const rows = await this.db.query<Row>(`SELECT p.*, s.first_name, s.last_name, s.employee_no, r.period_month FROM payslips p JOIN staff s ON s.id = p.staff_id JOIN payroll_runs r ON r.id = p.payroll_run_id WHERE p.id = ? AND p.school_id = ?`, [id, schoolId]);
    if (!rows[0]) throw notFound('payslip');
    return rows[0];
  }
  /** A member of staff sees only their own payslips. */
  async myPayslips(schoolId: string, userId: string) {
    const staff = await this.db.findOne<Row>('staff', { school_id: schoolId, user_id: userId });
    if (!staff) throw new HttpError(403, 'no staff record for this account', 'forbidden');
    return this.db.query<Row>(`SELECT p.id, p.gross, p.total_deductions, p.net_pay, p.status, p.payslip_file_id, r.period_month FROM payslips p JOIN payroll_runs r ON r.id = p.payroll_run_id WHERE p.staff_id = ? AND r.status IN ('approved','paid','locked') ORDER BY r.period_month DESC LIMIT 36`, [String(staff.id)]);
  }
  async holdPayslip(schoolId: string, id: string, reason: string) {
    return this.db.update('payslips', { status: 'held', hold_reason: reason.slice(0, 160), updated_at: nowSql() }, { id, school_id: schoolId });
  }

  // ---------- appraisals ----------
  async openCycle(schoolId: string, c: { academicYearId?: string | null; name: string; criteria?: Record<string, number>; opensAt: string; closesAt: string }) {
    const year = await this.academic.requireYear(schoolId, c.academicYearId);
    const id = ulid();
    const criteria = c.criteria ?? { teaching: 40, attendance: 20, results: 20, conduct: 20 };
    await this.db.insert('appraisal_cycles', { id, school_id: schoolId, academic_year_id: String(year.id), name: c.name, criteria: criteria as never, opens_at: c.opensAt, closes_at: c.closesAt });
    // H7: every teacher gets a row with the metrics we can compute ourselves
    const staff = await this.db.query<Row>(`SELECT * FROM staff WHERE school_id = ? AND status IN ('active','probation') ORDER BY id`, [schoolId]);
    for (const st of staff) {
      const metrics = await this.autoMetrics(schoolId, String(st.id), String(year.id));
      await this.db.insert('staff_appraisals', { id: ulid(), school_id: schoolId, cycle_id: id, staff_id: String(st.id), reviewer_id: (st.reports_to_id as string) ?? String(st.id), self_scores: null, reviewer_scores: null, auto_metrics: metrics as never, overall_score: null, comments: null, status: 'pending', finalised_at: null });
    }
    return { id, staff: staff.length };
  }
  /** Attendance percentage, syllabus completion and the average result of the classes they teach. */
  async autoMetrics(schoolId: string, staffId: string, yearId: string) {
    const att = await this.db.query<{ present: number; total: number }>(`SELECT SUM(CASE WHEN status IN ('present','late','wfh') THEN 1 ELSE 0 END) AS present, COUNT(*) AS total FROM staff_attendance WHERE staff_id = ?`, [staffId]);
    const attendancePct = Number(att[0]?.total) ? round((Number(att[0]!.present) * 100) / Number(att[0]!.total)) : null;
    // what they teach: section × class-subject, from the teaching allocation
    const syl = await this.db.query<{ pct: number }>(`SELECT AVG(sp.pct) AS pct FROM syllabus_progress sp JOIN syllabi sy ON sy.id = sp.syllabus_id JOIN section_subject_teachers sst ON sst.class_subject_id = sy.class_subject_id AND sst.section_id = sp.section_id WHERE sst.school_id = ? AND sst.teacher_id = ?`, [schoolId, staffId]);
    const results = await this.db.query<{ pct: number }>(`SELECT AVG(m.total_obtained * 100.0 / NULLIF(sch.full_marks, 0)) AS pct FROM marks m JOIN exam_schedules sch ON sch.id = m.schedule_id JOIN students st ON st.id = m.student_id JOIN section_subject_teachers sst ON sst.class_subject_id = sch.class_subject_id AND sst.section_id = st.current_section_id WHERE sst.school_id = ? AND sst.teacher_id = ? AND m.is_absent = FALSE`, [schoolId, staffId]);
    return { attendancePct, syllabusPct: syl[0]?.pct == null ? null : round(Number(syl[0].pct)), resultAvgPct: results[0]?.pct == null ? null : round(Number(results[0].pct)), yearId };
  }
  async scoreAppraisal(schoolId: string, id: string, input: { selfScores?: Record<string, number>; reviewerScores?: Record<string, number>; comments?: string | null }) {
    const a = await this.db.findOne<Row>('staff_appraisals', { id, school_id: schoolId });
    if (!a) throw notFound('appraisal');
    const cycle = await this.db.findOne<Row>('appraisal_cycles', { id: String(a.cycle_id) });
    const criteria = json<Record<string, number>>(cycle?.criteria) ?? {};
    const reviewer = input.reviewerScores ?? json<Record<string, number>>(a.reviewer_scores) ?? null;
    let overall: number | null = null;
    if (reviewer) {
      const weight = Object.values(criteria).reduce((x, y) => x + Number(y), 0) || 100;
      overall = round(Object.entries(criteria).reduce((sum, [k, w]) => sum + (Number(reviewer[k] ?? 0) * Number(w)) / weight, 0));
    }
    const status = reviewer ? 'reviewed' : input.selfScores ? 'self_done' : String(a.status);
    await this.db.update('staff_appraisals', { self_scores: (input.selfScores ?? a.self_scores) as never, reviewer_scores: (reviewer ?? null) as never, overall_score: overall, comments: input.comments ?? a.comments, status, updated_at: nowSql() }, { id });
    return { id, overall, status };
  }
  async finaliseAppraisal(schoolId: string, id: string) {
    const a = await this.db.findOne<Row>('staff_appraisals', { id, school_id: schoolId });
    if (!a) throw notFound('appraisal');
    if (a.overall_score == null) throw new HttpError(409, 'the reviewer has not scored this appraisal yet', 'not_reviewed');
    await this.db.update('staff_appraisals', { status: 'finalised', finalised_at: nowSql(), updated_at: nowSql() }, { id });
    return { id, overall: Number(a.overall_score) };
  }
  async appraisals(schoolId: string, cycleId?: string) {
    const where: Row = { school_id: schoolId };
    if (cycleId) where.cycle_id = cycleId;
    return this.db.query<Row>(`SELECT a.*, s.first_name, s.last_name, s.employee_no FROM staff_appraisals a JOIN staff s ON s.id = a.staff_id WHERE a.school_id = ?${cycleId ? ' AND a.cycle_id = ?' : ''} ORDER BY a.overall_score DESC, s.employee_no LIMIT 500`, cycleId ? [schoolId, cycleId] : [schoolId]);
  }

  // ---------- training ----------
  async addTraining(schoolId: string, t: { staffId: string; title: string; provider?: string | null; startDate?: string | null; endDate?: string | null; hours?: number | null; certificateFileId?: string | null }) {
    const id = ulid();
    await this.db.insert('staff_trainings', { id, school_id: schoolId, staff_id: t.staffId, title: t.title, provider: t.provider ?? null, start_date: t.startDate ?? null, end_date: t.endDate ?? null, hours: t.hours ?? null, certificate_file_id: t.certificateFileId ?? null });
    return id;
  }
  async trainings(schoolId: string, staffId?: string) {
    const where: Row = { school_id: schoolId };
    if (staffId) where.staff_id = staffId;
    return this.db.findMany<Row>('staff_trainings', where, { orderBy: 'start_date DESC', limit: 200 });
  }

  // ---------- exit ----------
  async initiateExit(schoolId: string, e: ExitInput) {
    const staff = await this.db.findOne<Row>('staff', { id: e.staffId, school_id: schoolId });
    if (!staff) throw notFound('staff');
    const ex = await this.db.findOne<Row>('staff_exits', { staff_id: e.staffId });
    const clearance = e.clearance ?? { library: false, inventory: false, accounts: false, hostel: false, it: false };
    const id = (ex?.id as string) ?? ulid();
    if (ex) await this.db.update('staff_exits', { exit_type: e.exitType, notice_date: e.noticeDate ?? null, last_working_day: e.lastWorkingDay, clearance: clearance as never, status: 'initiated', updated_at: nowSql() }, { id });
    else await this.db.insert('staff_exits', { id, school_id: schoolId, staff_id: e.staffId, exit_type: e.exitType, notice_date: e.noticeDate ?? null, last_working_day: e.lastWorkingDay, clearance: clearance as never, settlement: null, settlement_journal_id: null, status: 'initiated' });
    await this.tasks.create({ schoolId, title: `Clearance for ${staff.first_name} ${staff.last_name ?? ''}`.trim(), taskType: 'hr.exit', assignedRole: 'admin', entityType: 'hr.exit', entityId: id, dueAt: e.lastWorkingDay, priority: 'high' });
    return id;
  }
  /** Final settlement: encashable leave paid, the loan balance recovered, then the account is closed. */
  async settleExit(schoolId: string, id: string, opts: { encashDays?: number } = {}) {
    const ex = await this.db.findOne<Row>('staff_exits', { id, school_id: schoolId });
    if (!ex) throw notFound('exit');
    if (ex.status === 'settled') return { ...(json<Record<string, unknown>>(ex.settlement) ?? {}), alreadySettled: true };
    const staffId = String(ex.staff_id);
    const structure = await this.structureFor(schoolId, staffId, String(ex.last_working_day));
    const basic = Number(structure?.basic ?? 0);
    const year = await this.academic.requireYear(schoolId, null);
    const balances = await this.db.query<{ remaining: number }>(`SELECT (b.allocated + b.carried_forward - b.used - b.encashed) AS remaining FROM leave_balances b JOIN leave_types t ON t.id = b.leave_type_id WHERE b.staff_id = ? AND b.academic_year_id = ? AND t.encashable = TRUE`, [staffId, String(year.id)]);
    const encashDays = round(opts.encashDays ?? balances.reduce((a, b) => a + Math.max(0, Number(b.remaining)), 0));
    const encashment = round((basic / 30) * encashDays);
    const loan = await this.db.findOne<Row>('staff_loans', { school_id: schoolId, staff_id: staffId, status: 'active' });
    const loanBalance = loan ? round(Number(loan.balance)) : 0;
    const pf = await this.db.findOne<Row>('provident_fund_accounts', { school_id: schoolId, staff_id: staffId });
    const pfPayable = pf ? round(Number(pf.employee_total) + Number(pf.employer_total) + Number(pf.interest_total) - Number(pf.withdrawn_total)) : 0;
    const net = round(encashment + pfPayable - loanBalance);
    const settlement = { encashDays, encashment, pfPayable, loanRecovered: loanBalance, net };
    const lines = [
      { accountCode: '5100', debit: encashment, description: 'Leave encashment' },
      { accountCode: '2300', debit: pfPayable, description: 'Provident fund paid out' },
      { accountCode: '1400', credit: loanBalance, description: 'Loan recovered from settlement' },
      { accountCode: '1100', credit: net > 0 ? net : 0, description: 'Final settlement paid' },
      { accountCode: '1100', debit: net < 0 ? -net : 0, description: 'Recovered from the leaver' },
    ];
    const j = round(encashment + pfPayable) > 0 || loanBalance > 0 ? await this.accounting.post(schoolId, { entryDate: String(ex.last_working_day), memo: `Final settlement ${staffId}`, sourceType: 'hr.exit', sourceId: id, lines }) : null;
    await this.db.transaction(async tx => {
      await tx.update('staff_exits', { settlement: settlement as never, settlement_journal_id: j?.id ?? null, status: 'settled', updated_at: nowSql() }, { id });
      if (loan) await tx.update('staff_loans', { balance: 0, status: 'closed', updated_at: nowSql() }, { id: String(loan.id) });
      if (pf && pfPayable > 0) await tx.update('provident_fund_accounts', { withdrawn_total: round(Number(pf.withdrawn_total) + pfPayable), updated_at: nowSql() }, { id: String(pf.id) });
      await tx.update('staff', { status: ex.exit_type === 'retirement' ? 'retired' : ex.exit_type === 'termination' ? 'terminated' : 'resigned', leave_date: String(ex.last_working_day), updated_at: nowSql() }, { id: staffId });
    });
    await this.outbox.emitNow({ type: 'staff.left', schoolId, aggregateType: 'people.staff', aggregateId: staffId, payload: { staffId, exitId: id, lastWorkingDay: String(ex.last_working_day), settlement } as never });
    return settlement;
  }

  // ---------- helpers ----------
  /** Days in the range that are neither a weekly off nor a holiday. */
  async workingDays(schoolId: string, from: string, to: string) {
    const offs = new Set(await this.academic.weeklyOffs(schoolId));
    const holidays = await this.db.query<Row>(`SELECT start_date, end_date FROM calendar_events WHERE school_id = ? AND is_holiday = TRUE AND start_date <= ? AND end_date >= ?`, [schoolId, to, from]);
    let n = 0;
    for (let d = from; d <= to; d = isoDay(d, 1)) {
      if (offs.has(new Date(`${d}T00:00:00Z`).getUTCDay())) continue;
      if (holidays.some(h => String(h.start_date).slice(0, 10) <= d && String(h.end_date).slice(0, 10) >= d)) continue;
      n++;
    }
    return n;
  }

  private payslipDoc(school: Row | null, run: Row, s: Row) {
    const b = json<{ earnings?: { name: string; amount: number }[]; deductions?: { name: string; amount: number }[]; employerPf?: number; mpo?: number }>(s.breakdown) ?? {};
    const earnings = b.earnings ?? [];
    const deductions = b.deductions ?? [];
    const rows = Math.max(earnings.length, deductions.length);
    const body = [['Earnings', 'Amount', 'Deductions', 'Amount']];
    for (let i = 0; i < rows; i++) body.push([earnings[i]?.name ?? '', earnings[i] ? String(earnings[i]!.amount) : '', deductions[i]?.name ?? '', deductions[i] ? String(deductions[i]!.amount) : '']);
    body.push(['Gross', String(Number(s.gross)), 'Total deductions', String(Number(s.total_deductions))]);
    return {
      pageSize: 'A4', pageMargins: [36, 40, 36, 40],
      content: [
        { text: String(school?.name ?? 'School'), style: 'h1' },
        school?.name_bn ? { text: String(school.name_bn), style: 'h2' } : {},
        { text: `Payslip · ${String(run.period_month).slice(0, 7)}`, style: 'h2', margin: [0, 8, 0, 12] },
        { columns: [
          { width: '*', stack: [{ text: `${s.first_name} ${s.last_name ?? ''}`.trim(), style: 'name' }, { text: `Employee ${s.employee_no}` }] },
          { width: 'auto', stack: [{ text: `Working days ${Number(s.working_days)} · Present ${Number(s.present_days)}` }, { text: `Leave without pay ${Number(s.lop_days)} day(s)` }, { text: `Net pay ${Number(s.net_pay)}`, style: 'net' }] },
        ], margin: [0, 0, 0, 12] },
        { table: { headerRows: 1, widths: ['*', 70, '*', 70], body }, layout: 'lightHorizontalLines' },
        { text: `Employer provident fund contribution ${Number(b.employerPf ?? 0)}${b.mpo ? ` · paid by MPO grant ${Number(b.mpo)}` : ''}`, margin: [0, 10, 0, 0] },
        { text: 'Computer generated; no signature required.', style: 'small', margin: [0, 16, 0, 0] },
      ],
      styles: { h1: { fontSize: 18, bold: true }, h2: { fontSize: 12 }, name: { fontSize: 14, bold: true }, net: { fontSize: 14, bold: true }, small: { fontSize: 8, color: '#666' } },
    } as Record<string, unknown>;
  }

  // ---------- scheduled jobs ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // H1: draft the month's payroll on the configured day
      'payroll.draft_run': async ({ schoolId }) => {
        const month = `${nowSql().slice(0, 7)}-01`;
        const ex = await this.db.findOne<Row>('payroll_runs', { school_id: schoolId, period_month: month, campus_id: null });
        if (ex && String(ex.status) !== 'draft') return { skipped: String(ex.status) };
        return this.draftRun(schoolId, { periodMonth: month });
      },
      // H3/H4: contracts ending, probation finishing
      'hr.expiry_alerts': async ({ schoolId }) => {
        const soon = isoDay(nowSql().slice(0, 10), 30);
        const today = nowSql().slice(0, 10);
        const contracts = await this.db.query<Row>(`SELECT c.*, s.first_name, s.last_name FROM staff_contracts c JOIN staff s ON s.id = c.staff_id WHERE c.school_id = ? AND c.end_date IS NOT NULL AND c.end_date BETWEEN ? AND ? AND s.status IN ('active','probation')`, [schoolId, today, soon]);
        const probations = await this.db.query<Row>(`SELECT * FROM staff WHERE school_id = ? AND status = 'probation' AND probation_end IS NOT NULL AND probation_end BETWEEN ? AND ?`, [schoolId, today, soon]);
        for (const c of contracts) {
          await this.notifications.notifyRole(schoolId, 'admin', { channels: ['in_app', 'push'], eventKey: 'hr.contract_expiring', title: 'Contract ending soon', body: `${c.first_name} ${c.last_name ?? ''}: contract ends on ${String(c.end_date).slice(0, 10)}.`, entityType: 'hr.contract', entityId: String(c.id) });
          await this.tasks.create({ schoolId, title: `Renew or close the contract of ${c.first_name}`, taskType: 'hr.contract', assignedRole: 'admin', entityType: 'hr.contract', entityId: String(c.id), dueAt: String(c.end_date).slice(0, 10) });
        }
        for (const s of probations) {
          await this.tasks.create({ schoolId, title: `Probation review for ${s.first_name}`, taskType: 'hr.probation', assignedRole: 'admin', entityType: 'hr.staff', entityId: String(s.id), dueAt: String(s.probation_end).slice(0, 10) });
        }
        return { contracts: contracts.length, probations: probations.length };
      },
      // leave accrual: top the balances up for the current year
      'leave.accrue': async ({ schoolId }) => {
        const year = await this.academic.requireYear(schoolId, null);
        const types = await this.db.findMany<Row>('leave_types', { school_id: schoolId, audience: 'staff' });
        const staff = await this.db.query<Row>(`SELECT id FROM staff WHERE school_id = ? AND status IN ('active','probation')`, [schoolId]);
        let made = 0;
        for (const st of staff) {
          for (const t of types) {
            const allocated = Number(t.days_per_year ?? 0);
            if (!allocated) continue;
            const monthly = String(t.accrual) === 'monthly' ? round((allocated * (new Date().getUTCMonth() + 1)) / 12) : allocated;
            const ex = await this.db.findOne<Row>('leave_balances', { staff_id: String(st.id), leave_type_id: String(t.id), academic_year_id: String(year.id) });
            if (ex) { if (Number(ex.allocated) < monthly) { await this.db.update('leave_balances', { allocated: monthly, updated_at: nowSql() }, { id: String(ex.id) }); made++; } continue; }
            await this.db.insert('leave_balances', { id: ulid(), school_id: schoolId, staff_id: String(st.id), leave_type_id: String(t.id), academic_year_id: String(year.id), allocated: monthly, carried_forward: 0, used: 0, encashed: 0 });
            made++;
          }
        }
        return { balances: made };
      },
    };
  }
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** `date` shifted by `days`, still as YYYY-MM-DD. */
function isoDay(date: string, days: number) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function monthEnd(month: string) {
  const d = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
function daysBetween(from: string, to: string) {
  return Math.max(0, Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000));
}
