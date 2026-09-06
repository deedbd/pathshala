import type { Request, Response, Router } from 'express';
import { HttpError, type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const money = z.coerce.number().min(0).max(100_000_000);
export const paymentSchema = z.object({ studentId: z.string().optional().nullable(), amount: money, method: z.enum(['cash', 'bank_transfer', 'cheque', 'card', 'bkash', 'nagad', 'rocket', 'upay', 'sslcommerz', 'wallet', 'adjustment', 'other']), invoiceIds: z.array(z.string()).optional(), reference: z.string().max(120).optional().nullable(), paidAt: z.string().optional(), bankAccountId: z.string().optional().nullable(), notes: z.string().max(255).optional().nullable() });
export const structureSchema = z.object({ academicYearId: z.string().optional(), classId: z.string(), name: z.string().min(1).max(120), items: z.array(z.object({ feeHeadId: z.string(), amount: money, frequency: z.enum(['one_time', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'per_term']).optional(), dueDay: z.coerce.number().int().min(1).max(28).optional(), applicableMonths: z.array(z.coerce.number().int().min(1).max(12)).optional().nullable() })).min(1) });
export const journalSchema = z.object({ entryDate: dateSchema.optional(), memo: z.string().max(255).optional(), lines: z.array(z.object({ accountId: z.string().optional(), accountCode: z.string().optional(), debit: money.optional(), credit: money.optional(), description: z.string().max(200).optional() })).min(2) });

/** Phase 3 API: fee structures and discounts, invoice batches, payments and IPN, ledger, accounting. */
export function mountPhase3(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User, requireUser: (req: Request) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);
  const today = () => new Date().toISOString().slice(0, 10);
  const yearOf = async (req: Request, schoolId: string) => String((await app.academic.requireYear(schoolId, q(req, 'yearId') ?? (req.body?.academicYearId as string | undefined))).id);

  // ---------- structures, heads, discounts ----------
  api.get('/fees/overview', wrap(async req => {
    const u = requirePerm(req, 'fees.view'); const yearId = await yearOf(req, u.school_id);
    const month = q(req, 'period') ?? today();
    const [heads, structures, batches, dues, collection, gateways] = await Promise.all([
      app.fees.heads(u.school_id), app.fees.structures(u.school_id, yearId), app.fees.batches(u.school_id), app.fees.dues(u.school_id), app.fees.collectionSummary(u.school_id, month.slice(0, 8) + '01', today()), app.fees.gateways(u.school_id),
    ]);
    const outstanding = dues.reduce((a, d) => a + Number(d.due), 0);
    return { yearId, heads, structures, batches, dues, collection, gateways, outstanding };
  }));
  api.post('/fees/structures', wrap(async req => { const u = requirePerm(req, 'fees.create'); const b = structureSchema.parse(req.body); return { id: await app.fees.createStructure(u.school_id, { ...b, academicYearId: await yearOf(req, u.school_id) }) }; }));
  api.get('/fees/structures/:id/items', wrap(async req => { const u = requirePerm(req, 'fees.view'); return app.fees.structureItems(u.school_id, req.params.id as string); }));
  api.post('/fees/heads', wrap(async req => {
    const u = requirePerm(req, 'fees.create');
    const b = z.object({ name: z.string().min(1).max(80), code: z.string().min(1).max(20), headKind: z.enum(['academic', 'transport', 'hostel', 'fine', 'misc', 'course', 'shop', 'canteen']).optional(), glAccountCode: z.string().optional() }).parse(req.body);
    const { ulid } = await import('@pathshala/db');
    const gl = b.glAccountCode ? await app.accounting.accountByCode(u.school_id, b.glAccountCode) : null;
    const id = ulid();
    await app.db.insert('fee_heads', { id, school_id: u.school_id, name: b.name, code: b.code.toUpperCase(), head_kind: b.headKind ?? 'academic', gl_account_id: gl ? String(gl.id) : null, is_refundable: false, tax_pct: 0, status: 'active' });
    return { id };
  }));
  api.get('/fees/discounts', wrap(async req => { const u = requirePerm(req, 'fees.view'); return app.db.query(`SELECT sd.*, ds.name, ds.discount_kind, ds.value_type, ds.value, s.first_name, s.last_name, s.admission_no FROM student_discounts sd JOIN discount_schemes ds ON ds.id = sd.discount_scheme_id JOIN students s ON s.id = sd.student_id WHERE sd.school_id = ? ORDER BY sd.created_at DESC LIMIT 200`, [u.school_id]); }));
  api.post('/fees/discounts', wrap(async req => {
    const u = requirePerm(req, 'fees.create');
    const b = z.object({ studentId: z.string(), name: z.string().min(1).max(120), kind: z.enum(['sibling', 'merit', 'staff_child', 'need_based', 'early_payment', 'scholarship', 'custom']), valueType: z.enum(['percent', 'flat']), value: money, status: z.enum(['pending', 'approved']).optional() }).parse(req.body);
    const scheme = await app.fees.createDiscountScheme(u.school_id, { name: b.name, kind: b.kind, valueType: b.valueType, value: b.value });
    return { id: await app.fees.grantDiscount(u.school_id, b.studentId, scheme, await yearOf(req, u.school_id), { status: b.status ?? 'pending' }) };
  }));
  api.post('/fees/discounts/:id/decide', wrap(async req => { const u = requirePerm(req, 'fees.approve'); const b = z.object({ decision: z.enum(['approved', 'rejected']) }).parse(req.body); return app.fees.decideDiscount(u.school_id, req.params.id as string, b.decision, u.id); }));

  // ---------- invoices ----------
  api.post('/fees/batches', wrap(async req => { const u = requirePerm(req, 'fees.create'); const b = z.object({ billingPeriod: z.string().optional(), classIds: z.array(z.string()).optional() }).parse(req.body ?? {}); return app.fees.generateBatch(u.school_id, { ...b, academicYearId: await yearOf(req, u.school_id), generatedBy: u.id }); }));
  api.get('/fees/batches/:id', wrap(async req => { const u = requirePerm(req, 'fees.view'); const b = await app.db.findOne('invoice_batches', { id: req.params.id as string, school_id: u.school_id }); if (!b) throw new HttpError(404, 'batch not found'); return b; }));
  api.get('/fees/invoices', wrap(async req => { const u = requirePerm(req, 'fees.view'); return app.fees.invoices(u.school_id, { studentId: q(req, 'studentId'), status: q(req, 'status'), period: q(req, 'period'), overdueOnly: q(req, 'overdue') === '1' }); }));
  api.get('/fees/invoices/:id', wrap(async req => { const u = requirePerm(req, 'fees.view'); return app.fees.invoice(u.school_id, req.params.id as string); }));
  api.post('/fees/invoices', wrap(async req => {
    const u = requirePerm(req, 'fees.create');
    const b = z.object({ studentId: z.string(), items: z.array(z.object({ feeHeadId: z.string().optional().nullable(), description: z.string().min(1).max(200), amount: money, quantity: z.coerce.number().optional(), itemKind: z.enum(['fee', 'fine', 'adjustment', 'previous_due']).optional() })).min(1), dueDay: z.coerce.number().int().optional(), notes: z.string().max(255).optional().nullable() }).parse(req.body);
    return app.fees.createInvoice(u.school_id, { ...b, academicYearId: await yearOf(req, u.school_id) });
  }));
  api.post('/fees/reminders/run', wrap(async req => { const u = requirePerm(req, 'fees.edit'); return app.fees.runReminders(u.school_id, q(req, 'date') ?? today()); }));
  api.post('/fees/fines/run', wrap(async req => { const u = requirePerm(req, 'fees.edit'); return app.fees.applyOverdueAndFines(u.school_id, q(req, 'date') ?? today()); }));

  // ---------- payments ----------
  api.post('/fees/payments', wrap(async req => {
    const u = requirePerm(req, 'fees.create'); const b = paymentSchema.parse(req.body);
    const session = b.method === 'cash' ? await app.fees.openSessionFor(u.school_id, u.id) : null;
    const r = await app.fees.recordPayment(u.school_id, { ...b, receivedBy: u.id, cashSessionId: session ? String(session.id) : null } as never);
    await app.audit.log({ action: 'create', entityType: 'payment', entityId: r.id, after: { amount: b.amount, method: b.method } });
    return r;
  }));
  api.get('/fees/payments', wrap(async req => { const u = requirePerm(req, 'fees.view'); return app.db.query(`SELECT p.*, s.first_name, s.last_name, s.admission_no FROM payments p LEFT JOIN students s ON s.id = p.student_id WHERE p.school_id = ? ORDER BY p.paid_at DESC LIMIT 200`, [u.school_id]); }));
  api.post('/fees/payments/:id/refund', wrap(async req => { const u = requirePerm(req, 'fees.approve'); const b = z.object({ amount: money, reason: z.string().min(3).max(255) }).parse(req.body); return app.fees.refund(u.school_id, req.params.id as string, b.amount, b.reason, u.id); }));
  api.get('/fees/students/:id/ledger', wrap(async req => { const u = requirePerm(req, 'fees.view'); return app.fees.studentLedger(u.school_id, req.params.id as string); }));

  // ---------- counter cash ----------
  api.post('/fees/cash/open', wrap(async req => { const u = requirePerm(req, 'fees.create'); const b = z.object({ openingCash: money.optional() }).parse(req.body ?? {}); return app.fees.openCashSession(u.school_id, u.id, b.openingCash ?? 0); }));
  api.post('/fees/cash/close', wrap(async req => { const u = requirePerm(req, 'fees.create'); const b = z.object({ sessionId: z.string(), countedCash: money }).parse(req.body); return app.fees.closeCashSession(u.school_id, b.sessionId, b.countedCash); }));
  api.get('/fees/cash/open', wrap(async req => { const u = requirePerm(req, 'fees.view'); return app.fees.openSessionFor(u.school_id, u.id); }));

  // ---------- gateways and IPN ----------
  api.post('/fees/gateways', wrap(async req => { const u = requirePerm(req, 'fees.approve'); const b = z.object({ provider: z.enum(['sslcommerz', 'bkash', 'nagad', 'rocket', 'upay', 'aamarpay', 'shurjopay']), displayName: z.string().min(1).max(80), credentials: z.record(z.string(), z.string()), isSandbox: z.coerce.boolean().optional(), feePct: z.coerce.number().optional() }).parse(req.body); return { id: await app.fees.saveGateway(u.school_id, b) }; }));
  /**
   * Gateway callback. Signed with the app key (`sig`) so a forged POST cannot mark an invoice paid,
   * and idempotent on the gateway transaction id, so retried IPNs never double-credit.
   */
  api.post('/fees/ipn/:gatewayId', wrap(async (req, res) => {
    const b = z.object({ txnId: z.string().min(3).max(120), amount: money, status: z.enum(['success', 'failed']), studentId: z.string().optional().nullable(), invoiceIds: z.array(z.string()).optional(), sig: z.string().min(16), payload: z.unknown().optional() }).parse(req.body);
    const gatewayId = req.params.gatewayId as string;
    const gateway = await app.db.findOne<{ school_id: string }>('payment_gateways', { id: gatewayId });
    if (!gateway) { res.status(404); return { error: 'unknown gateway' }; }
    if (!app.fees.verifyIpnSignature(gatewayId, b.txnId, b.amount, b.sig)) { res.status(403); return { error: 'bad signature' }; }
    return app.fees.handleIpn(String(gateway.school_id), { gatewayId, txnId: b.txnId, amount: b.amount, status: b.status, studentId: b.studentId, invoiceIds: b.invoiceIds, payload: b.payload });
  }));

  // ---------- accounting ----------
  api.get('/accounting/overview', wrap(async req => {
    const u = requirePerm(req, 'accounting.view');
    const from = q(req, 'from') ?? today().slice(0, 8) + '01'; const to = q(req, 'to') ?? today();
    const [statements, entries, expenses, banks, budgets] = await Promise.all([
      app.accounting.statements(u.school_id, from, to), app.accounting.entries(u.school_id, { from, to, limit: 50 }), app.accounting.expenses(u.school_id, {}), app.accounting.bankAccounts(u.school_id), app.accounting.budgetStatus(u.school_id, String((await app.accounting.fiscalYear(u.school_id)).id)),
    ]);
    return { from, to, statements, entries, expenses, banks, budgets };
  }));
  api.get('/accounting/trial-balance', wrap(async req => { const u = requirePerm(req, 'accounting.view'); return app.accounting.trialBalance(u.school_id, q(req, 'from') ?? today().slice(0, 8) + '01', q(req, 'to') ?? today()); }));
  api.get('/accounting/accounts', wrap(async req => { const u = requirePerm(req, 'accounting.view'); return app.accounting.accounts(u.school_id); }));
  api.get('/accounting/entries/:id', wrap(async req => { const u = requirePerm(req, 'accounting.view'); return app.accounting.entry(u.school_id, req.params.id as string); }));
  api.post('/accounting/entries', wrap(async req => { const u = requirePerm(req, 'accounting.create'); const b = journalSchema.parse(req.body); return app.accounting.post(u.school_id, { ...b, isAuto: false, postedBy: u.id }); }));
  api.post('/accounting/entries/:id/reverse', wrap(async req => { const u = requirePerm(req, 'accounting.approve'); return app.accounting.reverse(u.school_id, req.params.id as string, z.object({ memo: z.string().max(255).optional() }).parse(req.body ?? {}).memo); }));
  api.post('/accounting/expenses', wrap(async req => { const u = requirePerm(req, 'accounting.create'); const b = z.object({ categoryId: z.string(), vendorId: z.string().optional().nullable(), expenseDate: dateSchema.optional(), amount: money, description: z.string().max(255).optional(), paidFromId: z.string().optional().nullable(), paymentMethod: z.string().max(20).optional() }).parse(req.body); const r = await app.accounting.createExpense(u.school_id, { ...b, requestedBy: u.id }); await app.outbox.emitNow({ type: 'expense.created', schoolId: u.school_id, aggregateType: 'accounting.expense', aggregateId: r.id, payload: { expenseId: r.id, amount: b.amount, category: b.categoryId, status: r.status } }); return r; }));
  api.get('/accounting/expense-categories', wrap(async req => { const u = requirePerm(req, 'accounting.view'); return app.db.findMany('expense_categories', { school_id: u.school_id }, { orderBy: 'name ASC' }); }));
  api.post('/accounting/bank/import', wrap(async req => { const u = requirePerm(req, 'accounting.create'); const b = z.object({ bankAccountId: z.string(), lines: z.array(z.object({ txnDate: dateSchema, description: z.string().max(255).optional(), reference: z.string().max(120).optional(), debit: money.optional(), credit: money.optional() })).min(1).max(2000) }).parse(req.body); return app.accounting.importStatement(u.school_id, b.bankAccountId, b.lines); }));
  api.post('/accounting/budgets', wrap(async req => { const u = requirePerm(req, 'accounting.create'); const b = z.object({ glAccountId: z.string(), amount: money, alertAtPct: z.coerce.number().optional() }).parse(req.body); const fy = await app.accounting.fiscalYear(u.school_id); return { id: await app.accounting.setBudget(u.school_id, String(fy.id), b.glAccountId, b.amount, b.alertAtPct) }; }));

  // ---------- guardian pay flow (portal) ----------
  api.get('/portal/fees/:studentId', wrap(async req => {
    const u = requireUser(req);
    const guardian = await app.db.findOne<{ id: string }>('guardians', { school_id: u.school_id, user_id: u.id });
    if (!guardian) throw new HttpError(403, 'only a guardian can see fees here');
    const link = await app.db.findOne('student_guardians', { student_id: req.params.studentId as string, guardian_id: guardian.id });
    if (!link) throw new HttpError(403, 'not your child');
    const [ledger, invoices, gateways] = await Promise.all([app.fees.studentLedger(u.school_id, req.params.studentId as string), app.fees.invoices(u.school_id, { studentId: req.params.studentId as string, limit: 24 }), app.fees.gateways(u.school_id)]);
    return { ...ledger, invoices, gateways };
  }));
  /**
   * Starts an online payment: returns the amount, the gateway and the signature the gateway's IPN
   * must carry back. The redirect URL itself is built by the provider SDK in the school's account.
   */
  api.post('/portal/fees/:studentId/pay', wrap(async req => {
    const u = requireUser(req);
    const guardian = await app.db.findOne<{ id: string }>('guardians', { school_id: u.school_id, user_id: u.id });
    if (!guardian) throw new HttpError(403, 'only a guardian can pay here');
    const link = await app.db.findOne('student_guardians', { student_id: req.params.studentId as string, guardian_id: guardian.id });
    if (!link) throw new HttpError(403, 'not your child');
    const b = z.object({ gatewayId: z.string(), amount: money, invoiceIds: z.array(z.string()).optional() }).parse(req.body);
    const gateway = await app.db.findOne<{ id: string; provider: string }>('payment_gateways', { id: b.gatewayId, school_id: u.school_id, is_active: true });
    if (!gateway) throw new HttpError(404, 'gateway not available');
    const txnId = `PS${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    return { txnId, amount: b.amount, provider: gateway.provider, ipnUrl: `${app.config.appUrl}/api/fees/ipn/${gateway.id}`, signature: app.fees.ipnSignature(String(gateway.id), txnId, b.amount), invoiceIds: b.invoiceIds ?? [] };
  }));
}
