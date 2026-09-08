import type { Request, Response, Router } from 'express';
import { HttpError, type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const money = z.coerce.number().min(0).max(100_000_000);
export const structureSchema = z.object({ staffId: z.string(), effectiveFrom: dateSchema, effectiveTo: dateSchema.optional().nullable(), basic: money, mpoPortion: money.optional(), payFrequency: z.enum(['monthly', 'weekly']).optional(), bankAccount: z.object({ bankName: z.string().max(120).optional(), accountNo: z.string().max(60).optional(), branch: z.string().max(120).optional(), routingNo: z.string().max(30).optional() }).optional().nullable(), items: z.array(z.object({ componentId: z.string(), value: money })).optional() });
export const loanSchema = z.object({ staffId: z.string(), loanType: z.enum(['advance', 'loan', 'pf_loan']).optional(), principal: money, monthlyDeduction: money, startsFrom: dateSchema });
export const applicationSchema = z.object({ postingId: z.string(), fullName: z.string().min(2).max(160), phone: z.string().min(6).max(20), email: z.string().email().max(160).optional().nullable(), cvFileId: z.string().optional().nullable(), notes: z.string().max(1000).optional().nullable() });

/** Phase 5 API: recruitment, onboarding, contracts and shifts, salary structures, loans, payroll, appraisals, exits. */
export function mountPhase5(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User, requireUser: (req: Request) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);

  // ---------- recruitment ----------
  api.get('/hr/postings', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.postings(u.school_id); }));
  api.post('/hr/postings', wrap(async req => { const u = requirePerm(req, 'hr.create'); const b = z.object({ title: z.string().min(2).max(160), departmentId: z.string().optional().nullable(), designationId: z.string().optional().nullable(), description: z.string().max(20000).optional().nullable(), vacancies: z.coerce.number().int().min(1).max(500).optional(), salaryRange: z.string().max(80).optional().nullable(), closesAt: dateSchema.optional().nullable(), status: z.enum(['draft', 'open', 'closed']).optional() }).parse(req.body); return { id: await app.hr.createPosting(u.school_id, b) }; }));
  api.patch('/hr/postings/:id', wrap(async req => { const u = requirePerm(req, 'hr.edit'); const b = z.object({ status: z.enum(['draft', 'open', 'closed']) }).parse(req.body); return { updated: await app.hr.setPostingStatus(u.school_id, req.params.id as string, b.status) }; }));
  api.get('/hr/applicants', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.applicants(u.school_id, q(req, 'postingId')); }));
  api.post('/hr/applicants/:id/stage', wrap(async req => {
    const u = requirePerm(req, 'hr.edit');
    const b = z.object({ stage: z.enum(['applied', 'shortlisted', 'interview', 'offered', 'hired', 'rejected']), interviewAt: z.string().optional().nullable(), score: z.coerce.number().min(0).max(100).optional().nullable(), notes: z.string().max(2000).optional().nullable(), joinDate: dateSchema.optional(), staffCategory: z.enum(['teaching', 'non_teaching', 'admin', 'support']).optional(), designationId: z.string().optional().nullable(), departmentId: z.string().optional().nullable() }).parse(req.body);
    const r = await app.hr.moveApplicant(u.school_id, req.params.id as string, b.stage, b);
    await app.audit.log({ action: 'update', entityType: 'hr.applicant', entityId: req.params.id as string, after: r });
    return r;
  }));

  // ---------- onboarding, contracts, shifts ----------
  api.get('/hr/onboarding/:staffId', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.onboarding(u.school_id, req.params.staffId as string); }));
  api.post('/hr/onboarding/:staffId', wrap(async req => { const u = requirePerm(req, 'hr.edit'); const b = z.object({ key: z.string().max(40) }).parse(req.body); return app.hr.completeOnboardingItem(u.school_id, req.params.staffId as string, b.key); }));
  api.get('/hr/contracts', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.contracts(u.school_id, q(req, 'staffId')); }));
  api.post('/hr/contracts', wrap(async req => { const u = requirePerm(req, 'hr.create'); const b = z.object({ staffId: z.string(), contractType: z.enum(['permanent', 'contract', 'part_time', 'intern', 'volunteer', 'mpo']), startDate: dateSchema, endDate: dateSchema.optional().nullable(), fileId: z.string().optional().nullable(), notes: z.string().max(2000).optional().nullable() }).parse(req.body); return { id: await app.hr.addContract(u.school_id, b) }; }));
  // what the nightly hr.expiry_alerts pass is already raising tasks about, as a list somebody can read
  api.get('/hr/expiries', wrap(async req => { const u = requirePerm(req, 'hr.view'); const days = Number(q(req, 'days') ?? 60); return app.hr.expiries(u.school_id, Number.isFinite(days) ? Math.min(365, Math.max(1, days)) : 60); }));
  api.get('/hr/leave-balances', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.leaveBalances(u.school_id, { staffId: q(req, 'staffId'), academicYearId: q(req, 'yearId') }); }));
  api.get('/hr/shifts', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.shifts(u.school_id); }));
  api.post('/hr/shifts', wrap(async req => { const u = requirePerm(req, 'hr.create'); const b = z.object({ name: z.string().min(1).max(60), startTime: z.string(), endTime: z.string(), days: z.array(z.coerce.number().int().min(0).max(6)).optional() }).parse(req.body); return { id: await app.hr.createShift(u.school_id, b) }; }));
  api.post('/hr/shifts/assign', wrap(async req => { const u = requirePerm(req, 'hr.edit'); const b = z.object({ staffId: z.string(), shiftId: z.string(), fromDate: dateSchema, toDate: dateSchema.optional().nullable() }).parse(req.body); return { id: await app.hr.assignShift(u.school_id, b) }; }));

  // ---------- salary structures ----------
  api.get('/hr/components', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.components(u.school_id); }));
  api.post('/hr/components', wrap(async req => { const u = requirePerm(req, 'hr.create'); const b = z.object({ name: z.string().min(1).max(80), code: z.string().min(1).max(20), componentType: z.enum(['earning', 'deduction', 'employer_contribution']), calcType: z.enum(['fixed', 'percent_of_basic', 'percent_of_gross', 'formula', 'attendance_based', 'slab']).optional(), defaultValue: money.optional(), isTaxable: z.coerce.boolean().optional(), isStatutory: z.coerce.boolean().optional(), sortOrder: z.coerce.number().int().optional() }).parse(req.body); return { id: await app.hr.addComponent(u.school_id, b) }; }));
  api.get('/hr/structures/:staffId', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.structureFor(u.school_id, req.params.staffId as string, q(req, 'on')); }));
  api.post('/hr/structures', wrap(async req => {
    const u = requirePerm(req, 'hr.approve');
    const b = structureSchema.parse(req.body);
    const id = await app.hr.setStructure(u.school_id, b, u.id);
    await app.audit.log({ action: 'create', entityType: 'hr.salary_structure', entityId: id, after: { staffId: b.staffId, basic: b.basic } });
    return { id };
  }));
  api.get('/hr/tax-slabs', wrap(async req => { const u = requirePerm(req, 'hr.view'); const fy = await app.accounting.fiscalYear(u.school_id); return { fiscalYear: fy, slabs: await app.hr.taxFor(u.school_id, String(fy.id), q(req, 'category') ?? 'general') }; }));

  // ---------- loans ----------
  api.get('/hr/loans', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.loans(u.school_id, q(req, 'staffId')); }));
  api.post('/hr/loans', wrap(async req => { const u = requirePerm(req, 'hr.create'); return app.hr.requestLoan(u.school_id, loanSchema.parse(req.body), u.id); }));
  api.post('/hr/loans/:id/approve', wrap(async req => { const u = requirePerm(req, 'hr.approve'); return app.hr.approveLoan(u.school_id, req.params.id as string, u.id); }));

  // ---------- payroll ----------
  api.get('/hr/payroll', wrap(async req => { const u = requirePerm(req, 'hr.view'); return { runs: await app.hr.runs(u.school_id) }; }));
  api.post('/hr/payroll', wrap(async req => { const u = requirePerm(req, 'hr.create'); const b = z.object({ periodMonth: z.string().regex(/^\d{4}-\d{2}/, 'YYYY-MM'), campusId: z.string().optional().nullable() }).parse(req.body); return app.hr.draftRun(u.school_id, { ...b, periodMonth: `${b.periodMonth.slice(0, 7)}-01`, createdBy: u.id }); }));
  api.get('/hr/payroll/:id', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.run(u.school_id, req.params.id as string); }));
  api.post('/hr/payroll/:id/approve', wrap(async req => { const u = requirePerm(req, 'hr.approve'); const r = await app.hr.approveRun(u.school_id, req.params.id as string, u.id); await app.audit.log({ action: 'approve', entityType: 'hr.payroll', entityId: req.params.id as string, after: r }); return r; }));
  api.get('/hr/payroll/:id/mpo', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.mpoSheet(u.school_id, req.params.id as string); }));
  api.get('/hr/payroll/:id/bank-files', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.bankFiles(u.school_id, req.params.id as string); }));
  api.post('/hr/payroll/:id/mpo-reconcile', wrap(async req => { const u = requirePerm(req, 'hr.approve'); const b = z.object({ released: z.coerce.number().min(0), releasedOn: z.string().optional(), note: z.string().max(255).optional().nullable() }).parse(req.body); const r = await app.hr.reconcileMpo(u.school_id, req.params.id as string, b.released, b); await app.audit.log({ action: 'update', entityType: 'hr.payroll', entityId: req.params.id as string, after: r }); return r; }));
  api.post('/hr/payroll/:id/pay', wrap(async req => { const u = requirePerm(req, 'hr.approve'); const b = z.object({ bankAccountId: z.string().optional().nullable(), paidAt: z.string().optional(), reference: z.string().max(120).optional().nullable() }).parse(req.body ?? {}); const r = await app.hr.payRun(u.school_id, req.params.id as string, b); await app.audit.log({ action: 'pay', entityType: 'hr.payroll', entityId: req.params.id as string, after: r }); return r; }));
  api.get('/hr/payslips/:id', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.payslip(u.school_id, req.params.id as string); }));
  api.post('/hr/payslips/:id/hold', wrap(async req => { const u = requirePerm(req, 'hr.approve'); const b = z.object({ reason: z.string().min(2).max(160) }).parse(req.body); return { updated: await app.hr.holdPayslip(u.school_id, req.params.id as string, b.reason) }; }));

  // ---------- appraisals, training ----------
  api.get('/hr/appraisals', wrap(async req => { const u = requirePerm(req, 'hr.view'); return { cycles: await app.db.findMany('appraisal_cycles', { school_id: u.school_id } as never, { orderBy: 'opens_at DESC', limit: 20 }), appraisals: await app.hr.appraisals(u.school_id, q(req, 'cycleId')) }; }));
  api.post('/hr/appraisals/cycles', wrap(async req => { const u = requirePerm(req, 'hr.create'); const b = z.object({ academicYearId: z.string().optional().nullable(), name: z.string().min(1).max(120), criteria: z.record(z.string(), z.coerce.number().min(0).max(100)).optional(), opensAt: dateSchema, closesAt: dateSchema }).parse(req.body); return app.hr.openCycle(u.school_id, b); }));
  api.post('/hr/appraisals/:id', wrap(async req => { const u = requirePerm(req, 'hr.edit'); const b = z.object({ selfScores: z.record(z.string(), z.coerce.number().min(0).max(100)).optional(), reviewerScores: z.record(z.string(), z.coerce.number().min(0).max(100)).optional(), comments: z.string().max(4000).optional().nullable() }).parse(req.body); return app.hr.scoreAppraisal(u.school_id, req.params.id as string, b); }));
  api.post('/hr/appraisals/:id/finalise', wrap(async req => { const u = requirePerm(req, 'hr.approve'); return app.hr.finaliseAppraisal(u.school_id, req.params.id as string); }));
  api.get('/hr/trainings', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.hr.trainings(u.school_id, q(req, 'staffId')); }));
  api.post('/hr/trainings', wrap(async req => { const u = requirePerm(req, 'hr.create'); const b = z.object({ staffId: z.string(), title: z.string().min(1).max(160), provider: z.string().max(160).optional().nullable(), startDate: dateSchema.optional().nullable(), endDate: dateSchema.optional().nullable(), hours: z.coerce.number().min(0).max(2000).optional().nullable(), certificateFileId: z.string().optional().nullable() }).parse(req.body); return { id: await app.hr.addTraining(u.school_id, b) }; }));

  // ---------- exit ----------
  api.post('/hr/exits', wrap(async req => { const u = requirePerm(req, 'hr.approve'); const b = z.object({ staffId: z.string(), exitType: z.enum(['resignation', 'termination', 'retirement', 'end_of_contract', 'death']), noticeDate: dateSchema.optional().nullable(), lastWorkingDay: dateSchema, clearance: z.record(z.string(), z.unknown()).optional().nullable() }).parse(req.body); return { id: await app.hr.initiateExit(u.school_id, b) }; }));
  api.post('/hr/exits/:id/settle', wrap(async req => { const u = requirePerm(req, 'hr.approve'); const b = z.object({ encashDays: z.coerce.number().min(0).max(400).optional() }).parse(req.body ?? {}); const r = await app.hr.settleExit(u.school_id, req.params.id as string, b); await app.audit.log({ action: 'settle', entityType: 'hr.exit', entityId: req.params.id as string, after: r }); return r; }));
  api.get('/hr/exits', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.db.query(`SELECT e.*, s.first_name, s.last_name, s.employee_no FROM staff_exits e JOIN staff s ON s.id = e.staff_id WHERE e.school_id = ? ORDER BY e.last_working_day DESC LIMIT 200`, [u.school_id]); }));

  // ---------- staff self-service (a teacher's own payslips, no hr.* permission) ----------
  api.get('/teach/payslips', wrap(async req => {
    const u = requireUser(req);
    const slips = await app.hr.myPayslips(u.school_id, u.id);
    return { payslips: slips };
  }));
  api.get('/teach/payslips/:id', wrap(async req => {
    const u = requireUser(req);
    const staff = await app.db.findOne<{ id: string }>('staff', { school_id: u.school_id, user_id: u.id });
    if (!staff) throw new HttpError(403, 'no staff record for this account');
    const slip = await app.db.findOne<Record<string, unknown>>('payslips', { id: req.params.id as string, staff_id: staff.id });
    if (!slip) throw new HttpError(403, 'not your payslip');
    const run = await app.db.findOne<{ status: string }>('payroll_runs', { id: String(slip.payroll_run_id) });
    if (!run || !['approved', 'paid', 'locked'].includes(String(run.status))) throw new HttpError(403, 'that payslip is not released yet');
    return { payslip: slip, payslipUrl: slip.payslip_file_id ? await app.files.url(String(slip.payslip_file_id), u.school_id, 900) : null };
  }));
}

/** The website's careers page: open vacancies and the application form. */
export function mountPublicHr(pub: Router, app: App, wrap: Wrap, verifyTurnstile: (token: string | undefined, ip?: string) => Promise<void>) {
  const schoolOf = async (req: Request) => { const s = await app.cms.resolveSchool(req.headers.host ?? null); if (!s) throw new HttpError(404, 'no school configured yet'); return s; };
  pub.get('/vacancies', wrap(async req => { const s = await schoolOf(req); return app.hr.postings(String(s.id), { publicOnly: true }); }));
  pub.post('/vacancies/apply', wrap(async req => {
    const s = await schoolOf(req);
    const b = applicationSchema.parse(req.body);
    await verifyTurnstile((req.body as { turnstile?: string })?.turnstile, req.ip);
    return { id: await app.hr.apply(String(s.id), b) };
  }));
}
