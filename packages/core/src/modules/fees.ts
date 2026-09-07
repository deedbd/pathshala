import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters, JobContext, ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { NumberingService } from './numbering.js';
import type { AcademicService } from './academic.js';
import type { AccountingService } from './accounting.js';
import type { DocumentService } from './documents.js';
import { round } from './accounting.js';
import { HttpError, badRequest, notFound } from '../context.js';
import { decryptSecret, encryptSecret } from '../util.js';

export type Frequency = 'one_time' | 'monthly' | 'quarterly' | 'half_yearly' | 'yearly' | 'per_term';
export interface StructureItemInput { feeHeadId: string; amount: number; frequency?: Frequency; dueDay?: number; applicableMonths?: number[] | null; lateFineRuleId?: string | null }
export interface PaymentInput { studentId?: string | null; amount: number; method: 'cash' | 'bank_transfer' | 'cheque' | 'card' | 'bkash' | 'nagad' | 'rocket' | 'upay' | 'sslcommerz' | 'wallet' | 'adjustment' | 'other'; invoiceIds?: string[]; reference?: string | null; paidAt?: string; receivedBy?: string | null; bankAccountId?: string | null; gatewayId?: string | null; gatewayTxnId?: string | null; gatewayPayload?: unknown; cashSessionId?: string | null; notes?: string | null; clearedNow?: boolean; existingId?: string }

const REMINDER_LADDER: { stage: string; offsetDays: number }[] = [
  { stage: 'due_in_3', offsetDays: -3 }, { stage: 'due_today', offsetDays: 0 }, { stage: 'overdue_3', offsetDays: 3 }, { stage: 'overdue_7', offsetDays: 7 }, { stage: 'overdue_15', offsetDays: 15 },
];

/**
 * Fees: heads and structures per class, per-student overrides and discounts, the monthly invoice
 * batch (chunked, pro-rata for mid-month admissions), payments with allocation oldest-first, the
 * student ledger, the reminder ladder, late fines, refunds, counter cash sessions, and gateway IPN
 * for bKash / Nagad / SSLCommerz. Every money movement posts a journal entry through AccountingService,
 * so the trial balance is produced from the same rows — "zero manual fee journals".
 */
export class FeesService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService, private numbering: NumberingService, private academic: AcademicService, private accounting: AccountingService, private documents: DocumentService, private adapters: Adapters, private appKey: string) {}

  // ---------- structures ----------
  async heads(schoolId: string) { return this.db.findMany<Row>('fee_heads', { school_id: schoolId, status: 'active' }, { orderBy: 'name ASC' }); }
  async createStructure(schoolId: string, s: { academicYearId: string; classId: string; name: string; items: StructureItemInput[] }) {
    const ex = await this.db.findOne<{ id: string }>('fee_structures', { school_id: schoolId, academic_year_id: s.academicYearId, class_id: s.classId, campus_id: null, shift_id: null, program_id: null });
    const id = ex?.id ?? ulid();
    await this.db.transaction(async tx => {
      if (!ex) await tx.insert('fee_structures', { id, school_id: schoolId, academic_year_id: s.academicYearId, class_id: s.classId, campus_id: null, shift_id: null, program_id: null, name: s.name, status: 'active' });
      for (const it of s.items) {
        const row = { amount: it.amount, frequency: it.frequency ?? 'monthly', due_day: it.dueDay ?? 10, applicable_months: (it.applicableMonths ?? null) as never, late_fine_rule_id: it.lateFineRuleId ?? null };
        const item = await tx.findOne<{ id: string }>('fee_structure_items', { fee_structure_id: id, fee_head_id: it.feeHeadId });
        if (item) await tx.update('fee_structure_items', { ...row, updated_at: nowSql() }, { id: item.id });
        else await tx.insert('fee_structure_items', { id: ulid(), school_id: schoolId, fee_structure_id: id, fee_head_id: it.feeHeadId, ...row });
      }
    });
    return id;
  }
  async structures(schoolId: string, yearId: string) {
    return this.db.query<Row>(`SELECT fs.*, c.name AS class_name, c.numeric_level, (SELECT COUNT(*) FROM fee_structure_items i WHERE i.fee_structure_id = fs.id) AS items,
      (SELECT SUM(i.amount) FROM fee_structure_items i WHERE i.fee_structure_id = fs.id AND i.frequency = 'monthly') AS monthly_total
      FROM fee_structures fs JOIN classes c ON c.id = fs.class_id WHERE fs.school_id = ? AND fs.academic_year_id = ? AND fs.status = 'active' ORDER BY c.numeric_level`, [schoolId, yearId]);
  }
  async structureItems(schoolId: string, structureId: string) {
    return this.db.query<Row>(`SELECT i.*, h.name AS head_name, h.code AS head_code, h.head_kind FROM fee_structure_items i JOIN fee_heads h ON h.id = i.fee_head_id WHERE i.school_id = ? AND i.fee_structure_id = ? ORDER BY h.name`, [schoolId, structureId]);
  }
  /** A starter structure per class so a pilot school can bill on day one. */
  async ensureDefaultStructures(schoolId: string, yearId: string, monthlyTuition = 800) {
    if (await this.db.count('fee_structures', { school_id: schoolId, academic_year_id: yearId })) return 0;
    const heads = await this.heads(schoolId);
    const tuition = heads.find(h => h.code === 'TUITION'), session = heads.find(h => h.code === 'SESSION'), exam = heads.find(h => h.code === 'EXAM');
    const classes = await this.academic.classes(schoolId);
    for (const c of classes) {
      const level = Math.max(0, Number(c.numeric_level));
      const items: StructureItemInput[] = [];
      if (tuition) items.push({ feeHeadId: String(tuition.id), amount: round(monthlyTuition + level * 50), frequency: 'monthly', dueDay: 10 });
      if (session) items.push({ feeHeadId: String(session.id), amount: 2000, frequency: 'yearly', dueDay: 15, applicableMonths: [1] });
      if (exam) items.push({ feeHeadId: String(exam.id), amount: 500, frequency: 'half_yearly', dueDay: 15, applicableMonths: [6, 12] });
      await this.createStructure(schoolId, { academicYearId: yearId, classId: String(c.id), name: `${c.name} fees`, items });
    }
    return classes.length;
  }

  // ---------- discounts ----------
  async createDiscountScheme(schoolId: string, d: { name: string; kind: 'sibling' | 'merit' | 'staff_child' | 'need_based' | 'early_payment' | 'scholarship' | 'custom'; valueType: 'percent' | 'flat'; value: number; appliesToHeads?: string[] | null; requiresApproval?: boolean }) {
    const ex = await this.db.findOne<{ id: string }>('discount_schemes', { school_id: schoolId, name: d.name });
    if (ex) return ex.id;
    const id = ulid();
    await this.db.insert('discount_schemes', { id, school_id: schoolId, name: d.name, discount_kind: d.kind, value_type: d.valueType, value: d.value, applies_to_heads: (d.appliesToHeads ?? null) as never, auto_rule: null, requires_approval: d.requiresApproval ?? true, budget_cap: null, status: 'active' });
    return id;
  }
  async grantDiscount(schoolId: string, studentId: string, schemeId: string, yearId: string, opts: { valueOverride?: number | null; isAuto?: boolean; status?: 'pending' | 'approved' } = {}) {
    const ex = await this.db.findOne<{ id: string }>('student_discounts', { student_id: studentId, discount_scheme_id: schemeId, academic_year_id: yearId });
    if (ex) return ex.id;
    const id = ulid();
    await this.db.insert('student_discounts', { id, school_id: schoolId, student_id: studentId, discount_scheme_id: schemeId, academic_year_id: yearId, value_override: opts.valueOverride ?? null, valid_from: null, valid_to: null, is_auto: opts.isAuto ?? false, status: opts.status ?? 'pending' });
    return id;
  }
  /** A9: a sibling sharing a guardian phone with an active student gets a sibling discount proposed. */
  async proposeSiblingDiscount(schoolId: string, studentId: string, yearId: string) {
    const siblings = await this.db.query<{ n: number }>(`SELECT COUNT(DISTINCT b.student_id) AS n FROM student_guardians a JOIN student_guardians b ON b.guardian_id = a.guardian_id AND b.student_id <> a.student_id JOIN students s ON s.id = b.student_id AND s.status = 'active' WHERE a.student_id = ?`, [studentId]);
    if (!Number(siblings[0]?.n)) return null;
    const scheme = await this.createDiscountScheme(schoolId, { name: 'Sibling discount', kind: 'sibling', valueType: 'percent', value: 10 });
    return this.grantDiscount(schoolId, studentId, scheme, yearId, { isAuto: true, status: 'pending' });
  }
  async discountsFor(schoolId: string, studentId: string, yearId: string) {
    return this.db.query<Row>(`SELECT sd.*, ds.name, ds.discount_kind, ds.value_type, ds.value, ds.applies_to_heads FROM student_discounts sd JOIN discount_schemes ds ON ds.id = sd.discount_scheme_id WHERE sd.school_id = ? AND sd.student_id = ? AND sd.academic_year_id = ? AND sd.status = 'approved'`, [schoolId, studentId, yearId]);
  }
  async decideDiscount(schoolId: string, id: string, status: 'approved' | 'rejected', approvedBy?: string | null) {
    const n = await this.db.update('student_discounts', { status, approved_by: approvedBy ?? null, updated_at: nowSql() }, { id, school_id: schoolId });
    if (!n) throw notFound('discount');
    return { status };
  }

  // ---------- invoices ----------
  /** What a student owes for one billing month, before discounts: structure items whose frequency hits that month. */
  private itemsForMonth(items: Row[], month: number, admissionDate: string, billingPeriod: string) {
    const out: { item: Row; amount: number; description: string }[] = [];
    for (const it of items) {
      const freq = String(it.frequency) as Frequency;
      const months = json<number[]>(it.applicable_months);
      let due = false;
      if (freq === 'monthly') due = !months?.length || months.includes(month);
      else if (freq === 'quarterly') due = [1, 4, 7, 10].includes(month);
      else if (freq === 'half_yearly') due = months?.length ? months.includes(month) : [1, 7].includes(month);
      else if (freq === 'yearly' || freq === 'one_time') due = months?.length ? months.includes(month) : month === 1;
      else if (freq === 'per_term') due = [1, 5, 9].includes(month);
      if (!due) continue;
      let amount = Number(it.amount);
      // pro-rata: a student admitted mid-month pays for the days they were enrolled
      if (freq === 'monthly' && admissionDate.slice(0, 7) === billingPeriod.slice(0, 7)) {
        const day = Number(admissionDate.slice(8, 10));
        const daysInMonth = new Date(Date.UTC(Number(billingPeriod.slice(0, 4)), Number(billingPeriod.slice(5, 7)), 0)).getUTCDate();
        if (day > 1) amount = round(amount * ((daysInMonth - day + 1) / daysInMonth));
      }
      out.push({ item: it, amount, description: `${it.head_name}${freq === 'monthly' ? ` · ${billingPeriod.slice(0, 7)}` : ''}` });
    }
    return out;
  }

  /** F1: generates one invoice per active student for a billing month. Chunked and resumable. */
  async generateBatch(schoolId: string, opts: { academicYearId?: string; billingPeriod?: string; classIds?: string[]; generatedBy?: string | null } = {}) {
    const year = await this.academic.requireYear(schoolId, opts.academicYearId);
    const billingPeriod = (opts.billingPeriod ?? nowSql().slice(0, 10)).slice(0, 7) + '-01';
    const ex = await this.db.findOne<Row>('invoice_batches', { school_id: schoolId, academic_year_id: String(year.id), billing_period: billingPeriod });
    if (ex && ex.status === 'success') return { batchId: String(ex.id), already: true, invoices: Number(ex.invoice_count), total: Number(ex.total_amount) };
    const batchId = ex ? String(ex.id) : ulid();
    if (!ex) await this.db.insert('invoice_batches', { id: batchId, school_id: schoolId, academic_year_id: String(year.id), billing_period: billingPeriod, scope: (opts.classIds ? { classIds: opts.classIds } : null) as never, generated_by: opts.generatedBy ?? null, invoice_count: 0, total_amount: 0, status: 'pending', started_at: nowSql() });
    await this.adapters.queue.push({ name: 'fees.generate_invoices', queue: 'batch', schoolId, payload: { batchId }, triggeredBy: 'fees.generate_invoices' });
    return { batchId, already: false, queued: true };
  }

  /** Queue handler for the invoice batch: 50 students per chunk, resumes from the cursor. */
  async runBatch(payload: Record<string, unknown>, ctx: JobContext) {
    const batchId = String(payload.batchId);
    const batch = await this.db.findOne<Row>('invoice_batches', { id: batchId });
    if (!batch) throw notFound('invoice batch');
    const schoolId = String(batch.school_id), yearId = String(batch.academic_year_id), billingPeriod = String(batch.billing_period);
    const month = Number(billingPeriod.slice(5, 7));
    if (batch.status === 'pending') await this.db.update('invoice_batches', { status: 'running', started_at: nowSql(), updated_at: nowSql() }, { id: batchId });
    const scope = json<{ classIds?: string[] }>(batch.scope);
    const cursor = (ctx.job.cursor as { done?: number; count?: number; total?: number } | null) ?? {};
    let done = cursor.done ?? 0, count = cursor.count ?? 0, total = cursor.total ?? 0;

    const students = await this.db.query<Row>(`SELECT s.id, s.admission_date, s.current_class_id, e.class_id FROM student_enrollments e JOIN students s ON s.id = e.student_id
      WHERE e.school_id = ? AND e.academic_year_id = ? AND e.status = 'active' AND s.status = 'active'${scope?.classIds?.length ? ` AND e.class_id IN (${scope.classIds.map(() => '?').join(',')})` : ''} ORDER BY s.id`, scope?.classIds?.length ? [schoolId, yearId, ...scope.classIds] : [schoolId, yearId]);
    const structures = await this.db.query<Row>(`SELECT fs.id, fs.class_id FROM fee_structures fs WHERE fs.school_id = ? AND fs.academic_year_id = ? AND fs.status = 'active'`, [schoolId, yearId]);
    const itemsByStructure = new Map<string, Row[]>();
    for (const s of structures) itemsByStructure.set(String(s.id), await this.db.query<Row>(`SELECT i.*, h.name AS head_name, h.code AS head_code, h.gl_account_id FROM fee_structure_items i JOIN fee_heads h ON h.id = i.fee_head_id WHERE i.fee_structure_id = ?`, [s.id]));
    const structureByClass = new Map(structures.map(s => [String(s.class_id), String(s.id)]));

    const CHUNK = 50;
    while (done < students.length) {
      const slice = students.slice(done, done + CHUNK);
      await this.db.transaction(async tx => {
        for (const st of slice) {
          const structureId = structureByClass.get(String(st.class_id));
          if (!structureId) continue;
          const dueItems = this.itemsForMonth(itemsByStructure.get(structureId) ?? [], month, String(st.admission_date), billingPeriod);
          if (!dueItems.length) continue;
          const existing = await tx.findOne('invoices', { school_id: schoolId, student_id: String(st.id), billing_period: billingPeriod, batch_id: batchId });
          if (existing) continue;
          const r = await this.createInvoice(schoolId, { studentId: String(st.id), academicYearId: yearId, billingPeriod, batchId, dueDay: Number((itemsByStructure.get(structureId) ?? [])[0]?.due_day ?? 10), items: dueItems.map(d => ({ feeHeadId: String(d.item.fee_head_id), description: d.description, amount: d.amount, glAccountId: (d.item.gl_account_id as string) ?? null })) }, tx);
          count++; total = round(total + r.total);
        }
      });
      done += slice.length;
      await ctx.progress(done, students.length, { done, count, total });
      await this.db.update('invoice_batches', { invoice_count: count, total_amount: total, updated_at: nowSql() }, { id: batchId });
      if (Date.now() > ctx.deadline && done < students.length) return { continue: true as const, cursor: { done, count, total } };
    }
    await this.db.update('invoice_batches', { status: 'success', invoice_count: count, total_amount: total, finished_at: nowSql(), updated_at: nowSql() }, { id: batchId });
    return { result: { invoices: count, total } };
  }

  /** Creates one invoice with its items, applies approved discounts, posts the receivable journal. */
  async createInvoice(schoolId: string, inv: { studentId?: string | null; applicationId?: string | null; academicYearId?: string | null; billingPeriod?: string | null; batchId?: string | null; dueDay?: number; issueDate?: string; items: { feeHeadId?: string | null; description: string; amount: number; quantity?: number; itemKind?: 'fee' | 'fine' | 'adjustment' | 'previous_due'; glAccountId?: string | null }[]; notes?: string | null }, tx?: Db) {
    const run = async (t: Db) => {
      if (!inv.items.length) throw badRequest('an invoice needs at least one item');
      const id = ulid();
      const invoiceNo = await this.numbering.next(schoolId, 'invoice_no', { prefix: 'INV-', padding: 6, resetYearly: true }, t);
      const issueDate = inv.issueDate ?? nowSql().slice(0, 10);
      const period = inv.billingPeriod ?? issueDate.slice(0, 7) + '-01';
      const dueDate = `${period.slice(0, 7)}-${String(inv.dueDay ?? 10).padStart(2, '0')}`;
      if (!inv.studentId && !inv.applicationId) throw badRequest('an invoice belongs to a student or to an applicant');
      const discounts = inv.studentId && inv.academicYearId ? await this.discountsFor(schoolId, inv.studentId, inv.academicYearId) : [];
      let subtotal = 0, discountTotal = 0;
      const rows: Row[] = [];
      for (const it of inv.items) {
        const qty = it.quantity ?? 1;
        const gross = round(it.amount * qty);
        let discount = 0; let discountId: string | null = null;
        for (const d of discounts) {
          const heads = json<string[]>(d.applies_to_heads);
          if (heads?.length && (!it.feeHeadId || !heads.includes(it.feeHeadId))) continue;
          if (it.itemKind && it.itemKind !== 'fee') continue;
          const value = Number(d.value_override ?? d.value);
          const amount = d.value_type === 'percent' ? round(gross * value / 100) : Math.min(gross, value);
          if (amount > discount) { discount = amount; discountId = String(d.id); }   // best single discount, never stacked
        }
        subtotal = round(subtotal + gross); discountTotal = round(discountTotal + discount);
        rows.push({ id: ulid(), school_id: schoolId, invoice_id: id, fee_head_id: it.feeHeadId ?? null, description: it.description, quantity: qty, unit_amount: it.amount, discount_amount: discount, discount_id: discountId, tax_amount: 0, amount: round(gross - discount), item_kind: it.itemKind ?? 'fee', source_type: null, source_id: null });
      }
      const total = round(subtotal - discountTotal);
      await t.insert('invoices', { id, school_id: schoolId, invoice_no: invoiceNo, student_id: inv.studentId ?? null, application_id: inv.applicationId ?? null, academic_year_id: inv.academicYearId ?? null, batch_id: inv.batchId ?? null, billing_period: period, issue_date: issueDate, due_date: dueDate, subtotal, discount_total: discountTotal, fine_total: 0, tax_total: 0, total, paid_total: 0, balance: total, status: 'issued', is_auto: !!inv.batchId, notes: inv.notes ?? null });
      await t.insertMany('invoice_items', rows);
      // an applicant has no student ledger yet; theirs starts when they enrol
      if (inv.studentId) await this.ledger(schoolId, inv.studentId, { entryType: 'invoice', refType: 'invoice', refId: id, debit: total, description: `${invoiceNo} ${period.slice(0, 7)}` }, t);
      // Dr fees receivable, Cr the income account of each head (falls back to tuition income)
      const lines: { accountId?: string; accountCode?: string; debit?: number; credit?: number; description?: string }[] = [{ accountCode: '1300', debit: total, description: invoiceNo }];
      const byAccount = new Map<string, number>();
      for (let i = 0; i < inv.items.length; i++) {
        const net = Number(rows[i].amount);
        const acc = inv.items[i].glAccountId ?? String((await this.accountForHead(schoolId, inv.items[i].feeHeadId)).id);
        byAccount.set(acc, round((byAccount.get(acc) ?? 0) + net));
      }
      for (const [accountId, amount] of byAccount) if (amount) lines.push({ accountId, credit: amount });
      const j = await this.accounting.post(schoolId, { entryDate: issueDate, memo: `Fee invoice ${invoiceNo}`, sourceType: 'invoice', sourceId: id, lines }, t);
      await this.outbox.emit(t, { type: 'invoice.created', schoolId, aggregateType: 'fees.invoice', aggregateId: id, payload: { invoiceId: id, studentId: inv.studentId ?? '', total, dueDate } });
      return { id, invoiceNo, total, journalEntryId: j.id };
    };
    return tx ? run(tx) : this.db.transaction(run);
  }
  private async accountForHead(schoolId: string, feeHeadId?: string | null) {
    if (feeHeadId) { const h = await this.db.findOne<Row>('fee_heads', { id: feeHeadId }); if (h?.gl_account_id) return { id: String(h.gl_account_id) }; }
    return { id: String((await this.accounting.accountByCode(schoolId, '4100')).id) };
  }

  async invoices(schoolId: string, f: { studentId?: string; status?: string; period?: string; overdueOnly?: boolean; limit?: number } = {}) {
    const where = ['i.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.studentId) { where.push('i.student_id = ?'); params.push(f.studentId); }
    if (f.status) { where.push('i.status = ?'); params.push(f.status); }
    if (f.period) { where.push('i.billing_period = ?'); params.push(f.period.slice(0, 7) + '-01'); }
    if (f.overdueOnly) { where.push('i.balance > 0 AND i.due_date < ?'); params.push(nowSql().slice(0, 10)); }
    return this.db.query<Row>(`SELECT i.*, s.first_name, s.last_name, s.admission_no, c.name AS class_name FROM invoices i LEFT JOIN students s ON s.id = i.student_id LEFT JOIN classes c ON c.id = s.current_class_id WHERE ${where.join(' AND ')} ORDER BY i.issue_date DESC, i.invoice_no DESC LIMIT ${Math.min(500, f.limit ?? 100)}`, params);
  }
  async invoice(schoolId: string, id: string) {
    const inv = await this.db.findOne<Row>('invoices', { id, school_id: schoolId }); if (!inv) throw notFound('invoice');
    const items = await this.db.findMany<Row>('invoice_items', { invoice_id: id });
    const payments = await this.db.query<Row>(`SELECT p.*, a.amount AS allocated FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = ? ORDER BY p.paid_at`, [id]);
    return { ...inv, items, payments };
  }

  // ---------- payments ----------
  /**
   * Records a payment, allocates it to invoices oldest-first, posts the journal, notifies the guardian.
   * A cheque is the exception: it is held pending and allocates nothing until it clears, because a
   * school that credits a cheque the day it is handed over ends up chasing a fee it marked paid.
   */
  async recordPayment(schoolId: string, p: PaymentInput, tx?: Db) {
    if (p.method === 'cheque' && !p.clearedNow && !p.existingId) return this.recordCheque(schoolId, p);
    const run = async (t: Db) => {
      if (p.amount <= 0) throw badRequest('amount must be positive');
      const id = p.existingId ?? ulid();
      const paymentNo = p.existingId
        ? String((await t.findOne<Row>('payments', { id }))?.payment_no ?? '')
        : await this.numbering.next(schoolId, 'payment_no', { prefix: 'RCPT-', padding: 6, resetYearly: true }, t);
      const paidAt = p.paidAt ?? nowSql();
      const row: Row = { id, school_id: schoolId, payment_no: paymentNo, student_id: p.studentId ?? null, payer_user_id: null, amount: p.amount, method: p.method, gateway_id: p.gatewayId ?? null, gateway_txn_id: p.gatewayTxnId ?? null, gateway_payload: (p.gatewayPayload ?? null) as never, bank_account_id: p.bankAccountId ?? null, reference: p.reference ?? null, paid_at: paidAt, received_by: p.receivedBy ?? null, status: 'success', cash_session_id: p.cashSessionId ?? null, notes: p.notes ?? null };
      if (p.existingId) { const { id: _i, school_id: _s, payment_no: _n, ...rest } = row; await t.update('payments', { ...rest, updated_at: nowSql() }, { id }); }
      else await t.insert('payments', row);

      // allocate: named invoices first, then the oldest unpaid ones
      let left = p.amount; const allocations: { invoiceId: string; amount: number }[] = [];
      const named = p.invoiceIds?.length ? await t.query<Row>(`SELECT * FROM invoices WHERE school_id = ? AND id IN (${p.invoiceIds.map(() => '?').join(',')}) AND balance > 0 ORDER BY due_date`, [schoolId, ...p.invoiceIds]) : [];
      const others = p.studentId ? await t.query<Row>(`SELECT * FROM invoices WHERE school_id = ? AND student_id = ? AND balance > 0${p.invoiceIds?.length ? ` AND id NOT IN (${p.invoiceIds.map(() => '?').join(',')})` : ''} ORDER BY due_date, invoice_no`, p.invoiceIds?.length ? [schoolId, p.studentId, ...p.invoiceIds] : [schoolId, p.studentId]) : [];
      for (const inv of [...named, ...others]) {
        if (left <= 0) break;
        const take = round(Math.min(left, Number(inv.balance)));
        if (take <= 0) continue;
        await t.insert('payment_allocations', { id: ulid(), school_id: schoolId, payment_id: id, invoice_id: String(inv.id), amount: take });
        const paid = round(Number(inv.paid_total) + take), balance = round(Number(inv.total) - paid);
        await t.update('invoices', { paid_total: paid, balance, status: balance <= 0 ? 'paid' : 'partially_paid', updated_at: nowSql() }, { id: String(inv.id) });
        allocations.push({ invoiceId: String(inv.id), amount: take });
        left = round(left - take);
      }
      if (p.studentId) await this.ledger(schoolId, p.studentId, { entryType: 'payment', refType: 'payment', refId: id, credit: p.amount, description: `${paymentNo} ${p.method}` }, t);
      // Dr cash/bank/MFS, Cr fees receivable (advance stays on the receivable as a credit balance)
      const cashAccount = p.bankAccountId ? String((await t.findOne<Row>('bank_accounts', { id: p.bankAccountId }))?.gl_account_id) : String((await this.accounting.accountByCode(schoolId, ['bkash', 'nagad', 'rocket', 'upay', 'sslcommerz'].includes(p.method) ? '1220' : p.method === 'bank_transfer' || p.method === 'cheque' || p.method === 'card' ? '1210' : '1100')).id);
      const j = await this.accounting.post(schoolId, { entryDate: paidAt.slice(0, 10), memo: `Payment ${paymentNo}`, sourceType: 'payment', sourceId: id, lines: [{ accountId: cashAccount, debit: p.amount, description: paymentNo }, { accountCode: '1300', credit: p.amount }] }, t);
      await t.update('payments', { journal_entry_id: j.id }, { id });
      await this.outbox.emit(t, { type: 'payment.received', schoolId, aggregateType: 'fees.payment', aggregateId: id, payload: { paymentId: id, studentId: p.studentId ?? '', amount: p.amount, method: p.method, invoiceIds: allocations.map(a => a.invoiceId) } });
      return { id, paymentNo, allocated: allocations, unallocated: left, journalEntryId: j.id };
    };
    const r = tx ? await run(tx) : await this.db.transaction(run);
    if (p.studentId) await this.notifyPayment(schoolId, p.studentId, r.paymentNo, p.amount);
    return r;
  }
  /** A cheque sits pending: no allocation, no journal, nothing on the student's ledger yet. */
  private async recordCheque(schoolId: string, p: PaymentInput) {
    if (p.amount <= 0) throw badRequest('amount must be positive');
    if (!p.reference) throw badRequest('a cheque needs its number in the reference');
    const id = ulid();
    const paymentNo = await this.numbering.next(schoolId, 'payment_no', { prefix: 'RCPT-', padding: 6, resetYearly: true });
    await this.db.insert('payments', { id, school_id: schoolId, payment_no: paymentNo, student_id: p.studentId ?? null, payer_user_id: null, amount: p.amount, method: 'cheque', gateway_id: null, gateway_txn_id: null, gateway_payload: null, bank_account_id: p.bankAccountId ?? null, reference: p.reference, paid_at: p.paidAt ?? nowSql(), received_by: p.receivedBy ?? null, status: 'pending', cash_session_id: p.cashSessionId ?? null, notes: p.notes ?? null });
    await this.outbox.emitNow({ type: 'cheque.received', schoolId, aggregateType: 'fees.payment', aggregateId: id, payload: { paymentId: id, studentId: p.studentId ?? '', amount: p.amount, reference: String(p.reference) } });
    return { id, paymentNo, allocated: [] as { invoiceId: string; amount: number }[], unallocated: p.amount, journalEntryId: null as string | null, pending: true };
  }
  /** The bank honoured it, so the same row now allocates, journals and reaches the guardian. */
  async clearCheque(schoolId: string, paymentId: string, opts: { clearedAt?: string; bankAccountId?: string | null } = {}) {
    const p = await this.db.findOne<Row>('payments', { id: paymentId, school_id: schoolId });
    if (!p) throw notFound('payment');
    if (p.method !== 'cheque') throw badRequest('that payment is not a cheque');
    if (p.status !== 'pending') throw new HttpError(409, `this cheque is already ${p.status}`, 'conflict');
    const r = await this.recordPayment(schoolId, {
      existingId: paymentId, clearedNow: true, studentId: (p.student_id as string) ?? null, amount: Number(p.amount), method: 'cheque',
      reference: (p.reference as string) ?? null, paidAt: opts.clearedAt ?? nowSql(), receivedBy: (p.received_by as string) ?? null,
      bankAccountId: opts.bankAccountId ?? ((p.bank_account_id as string) ?? null), cashSessionId: (p.cash_session_id as string) ?? null, notes: (p.notes as string) ?? null,
    });
    await this.outbox.emitNow({ type: 'cheque.cleared', schoolId, aggregateType: 'fees.payment', aggregateId: paymentId, payload: { paymentId, amount: Number(p.amount), reference: String(p.reference ?? '') } });
    return r;
  }
  /** It bounced: the payment fails, the fee stays outstanding and the guardian is told plainly. */
  async bounceCheque(schoolId: string, paymentId: string, reason: string) {
    const p = await this.db.findOne<Row>('payments', { id: paymentId, school_id: schoolId });
    if (!p) throw notFound('payment');
    if (p.status !== 'pending') throw new HttpError(409, `this cheque is already ${p.status}`, 'conflict');
    await this.db.update('payments', { status: 'failed', notes: `bounced: ${reason.slice(0, 200)}`, updated_at: nowSql() }, { id: paymentId });
    if (p.student_id) await this.notifyGuardians(schoolId, String(p.student_id), 'fees.cheque_bounced', 'Cheque returned', `The cheque ${p.reference} for Tk ${Number(p.amount)} was returned by the bank. The fee is still outstanding.`);
    await this.outbox.emitNow({ type: 'cheque.bounced', schoolId, aggregateType: 'fees.payment', aggregateId: paymentId, payload: { paymentId, reason } });
    return { id: paymentId, status: 'failed' as const, reason };
  }
  async pendingCheques(schoolId: string) {
    return this.db.query<Row>(`SELECT p.*, s.first_name, s.last_name, s.admission_no FROM payments p LEFT JOIN students s ON s.id = p.student_id WHERE p.school_id = ? AND p.method = 'cheque' AND p.status = 'pending' ORDER BY p.paid_at`, [schoolId]);
  }

  /** The receipt the counter hands over: the payment's own numbers, rendered once and kept. */
  async issueReceipt(schoolId: string, paymentId: string) {
    const p = await this.db.findOne<Row>('payments', { id: paymentId, school_id: schoolId });
    if (!p) throw notFound('payment');
    if (p.receipt_file_id) return { paymentId, fileId: String(p.receipt_file_id), documentNo: String(p.payment_no), alreadyIssued: true };
    if (p.status !== 'success') throw new HttpError(409, `a ${p.status} payment has no receipt`, 'conflict');
    const student = p.student_id ? await this.db.findOne<Row>('students', { id: String(p.student_id) }) : null;
    const allocations = await this.db.query<Row>(`SELECT a.amount, i.invoice_no FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id WHERE a.payment_id = ?`, [paymentId]);
    const due = student ? Number((await this.db.query<{ d: number }>(`SELECT COALESCE(SUM(balance), 0) AS d FROM invoices WHERE student_id = ? AND balance > 0`, [String(student.id)]))[0]?.d ?? 0) : 0;
    const issued = await this.documents.issue(schoolId, {
      docType: 'receipt', personType: student ? 'student' : 'other', studentId: student ? String(student.id) : null,
      data: {
        name: student ? `${student.first_name} ${student.last_name ?? ''}`.trim() : 'Counter payment',
        admission_no: String(student?.admission_no ?? '-'), receipt_no: String(p.payment_no), amount: String(Number(p.amount)),
        method: String(p.method), paid_at: String(p.paid_at).slice(0, 16), reference: String(p.reference ?? ''),
        against: allocations.map(a => `${a.invoice_no} (${Number(a.amount)})`).join(', ') || 'advance',
        outstanding: String(round(due)),
      },
      entityType: 'fees.payment', entityId: paymentId,
    });
    await this.db.update('payments', { receipt_file_id: issued.fileId, updated_at: nowSql() }, { id: paymentId });
    return { paymentId, fileId: issued.fileId, documentNo: issued.documentNo };
  }

  // ---------- instalment plans ----------
  /**
   * Splits one large fee into dated instalments. Nothing is invoiced up front: a scheduled job raises
   * each instalment's invoice on the day it falls due, so a guardian never sees the whole amount as
   * outstanding before it is, and the reminder ladder chases the instalment, not the lump sum.
   */
  async createInstalmentPlan(schoolId: string, p: { studentId: string; feeHeadId: string; totalAmount: number; instalments?: { due: string; amount: number }[]; count?: number; firstDue?: string; approvedBy?: string | null }) {
    if (!(await this.db.findOne('students', { id: p.studentId, school_id: schoolId }))) throw notFound('student');
    if (!(await this.db.findOne('fee_heads', { id: p.feeHeadId, school_id: schoolId }))) throw notFound('fee head');
    if (p.totalAmount <= 0) throw badRequest('the plan needs a positive total');
    let instalments = p.instalments ?? [];
    if (!instalments.length) {
      const count = Math.max(2, Math.min(24, p.count ?? 3));
      const each = round(p.totalAmount / count);
      const first = (p.firstDue ?? nowSql()).slice(0, 10);
      instalments = Array.from({ length: count }, (_, i) => {
        const d = new Date(`${first}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + i);
        return { due: d.toISOString().slice(0, 10), amount: i === count - 1 ? round(p.totalAmount - each * (count - 1)) : each };
      });
    }
    const total = round(instalments.reduce((a, i) => a + i.amount, 0));
    if (total !== round(p.totalAmount)) throw badRequest(`the instalments add up to ${total}, not ${p.totalAmount}`);
    const id = ulid();
    await this.db.insert('instalment_plans', { id, school_id: schoolId, student_id: p.studentId, fee_head_id: p.feeHeadId, total_amount: round(p.totalAmount), instalments: instalments.map(i => ({ ...i, invoiceId: null })) as never, status: 'active', approved_by: p.approvedBy ?? null });
    await this.outbox.emitNow({ type: 'instalment_plan.created', schoolId, aggregateType: 'fees.instalment_plan', aggregateId: id, payload: { planId: id, studentId: p.studentId, count: instalments.length, total } });
    await this.notifyGuardians(schoolId, p.studentId, 'fees.instalment_plan', 'Payment plan agreed', `${instalments.length} instalments totalling Tk ${total}. The first, Tk ${instalments[0]!.amount}, is due ${instalments[0]!.due}.`);
    return { id, instalments };
  }
  async instalmentPlans(schoolId: string, studentId?: string) {
    const where: Row = { school_id: schoolId };
    if (studentId) where.student_id = studentId;
    return this.db.findMany<Row>('instalment_plans', where, { orderBy: 'created_at DESC', limit: 200 });
  }
  async cancelInstalmentPlan(schoolId: string, planId: string) {
    if (!(await this.db.findOne('instalment_plans', { id: planId, school_id: schoolId }))) throw notFound('instalment plan');
    await this.db.update('instalment_plans', { status: 'cancelled', updated_at: nowSql() }, { id: planId });
    return { id: planId, status: 'cancelled' as const };
  }
  /** Raises the invoice for every instalment that has fallen due and has not been billed yet. */
  async billDueInstalments(schoolId: string, onDate = nowSql().slice(0, 10)) {
    const plans = await this.db.findMany<Row>('instalment_plans', { school_id: schoolId, status: 'active' });
    let billed = 0, completed = 0;
    for (const plan of plans) {
      const rows = json<{ due: string; amount: number; invoiceId: string | null }[]>(plan.instalments) ?? [];
      const head = await this.db.findOne<Row>('fee_heads', { id: String(plan.fee_head_id) });
      let changed = false;
      for (const r of rows) {
        if (r.invoiceId || r.due > onDate) continue;
        const inv = await this.createInvoice(schoolId, { studentId: String(plan.student_id), issueDate: r.due, notes: `instalment:${plan.id}`, items: [{ feeHeadId: String(plan.fee_head_id), description: `${head?.name ?? 'Instalment'} - due ${r.due}`, amount: r.amount }] });
        r.invoiceId = inv.id; changed = true; billed++;
      }
      if (changed) {
        const done = rows.every(r => r.invoiceId);
        await this.db.update('instalment_plans', { instalments: rows as never, status: done ? 'completed' : 'active', updated_at: nowSql() }, { id: String(plan.id) });
        if (done) completed++;
      }
    }
    return { billed, completed };
  }

  private async notifyGuardians(schoolId: string, studentId: string, eventKey: string, title: string, body: string) {
    const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [studentId]);
    for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['sms', 'push', 'in_app'], eventKey, title, body, entityType: 'people.student', entityId: studentId });
  }

  private async notifyPayment(schoolId: string, studentId: string, paymentNo: string, amount: number) {
    const student = await this.db.findOne<Row>('students', { id: studentId });
    const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [studentId]);
    const due = await this.db.query<{ balance: number }>(`SELECT COALESCE(SUM(balance), 0) AS balance FROM invoices WHERE student_id = ? AND balance > 0`, [studentId]);
    for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['sms', 'push', 'in_app'], eventKey: 'fees.payment_received', data: { student: `${student?.first_name ?? ''}`, amount, receipt: paymentNo, due: Number(due[0]?.balance ?? 0) }, title: 'Payment received', body: `Received Tk ${amount} (${paymentNo}). Outstanding: Tk ${Number(due[0]?.balance ?? 0)}.`, entityType: 'fees.payment', entityId: paymentNo });
  }

  async refund(schoolId: string, paymentId: string, amount: number, reason: string, requestedBy?: string | null) {
    const p = await this.db.findOne<Row>('payments', { id: paymentId, school_id: schoolId });
    if (!p) throw notFound('payment');
    if (amount > Number(p.amount)) throw badRequest('refund exceeds the payment');
    const id = ulid();
    await this.db.transaction(async t => {
      await t.insert('refunds', { id, school_id: schoolId, payment_id: paymentId, amount, reason, requested_by: requestedBy ?? null, status: 'refunded', refunded_at: nowSql() });
      const allocs = await t.findMany<Row>('payment_allocations', { payment_id: paymentId });
      let left = amount;
      for (const a of allocs) {
        if (left <= 0) break;
        const take = round(Math.min(left, Number(a.amount)));
        const inv = await t.findOne<Row>('invoices', { id: String(a.invoice_id) });
        if (inv) { const paid = round(Number(inv.paid_total) - take); await t.update('invoices', { paid_total: paid, balance: round(Number(inv.total) - paid), status: paid <= 0 ? 'issued' : 'partially_paid', updated_at: nowSql() }, { id: String(inv.id) }); }
        left = round(left - take);
      }
      if (p.student_id) await this.ledger(schoolId, String(p.student_id), { entryType: 'refund', refType: 'refund', refId: id, debit: amount, description: reason }, t);
      const cashAccount = String((await this.accounting.accountByCode(schoolId, '1100')).id);
      const j = await this.accounting.post(schoolId, { memo: `Refund of ${p.payment_no}`, sourceType: 'refund', sourceId: id, lines: [{ accountCode: '1300', debit: amount }, { accountId: cashAccount, credit: amount }] }, t);
      await t.update('refunds', { journal_entry_id: j.id }, { id });
    });
    return { id };
  }

  // ---------- ledger ----------
  private async ledger(schoolId: string, studentId: string, e: { entryType: 'invoice' | 'payment' | 'refund' | 'adjustment' | 'fine' | 'write_off' | 'advance'; refType: string; refId: string; debit?: number; credit?: number; description?: string }, t: Db) {
    const last = await t.query<{ balance_after: number }>(`SELECT balance_after FROM student_ledger_entries WHERE student_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [studentId]);
    const balance = round(Number(last[0]?.balance_after ?? 0) + (e.debit ?? 0) - (e.credit ?? 0));
    await t.insert('student_ledger_entries', { id: ulid(), school_id: schoolId, student_id: studentId, entry_type: e.entryType, ref_type: e.refType, ref_id: e.refId, debit: e.debit ?? 0, credit: e.credit ?? 0, balance_after: balance, description: e.description ?? null });
    return balance;
  }
  async studentLedger(schoolId: string, studentId: string) {
    const rows = await this.db.query<Row>(`SELECT * FROM student_ledger_entries WHERE school_id = ? AND student_id = ? ORDER BY created_at, id`, [schoolId, studentId]);
    const due = await this.db.query<{ balance: number }>(`SELECT COALESCE(SUM(balance), 0) AS balance FROM invoices WHERE school_id = ? AND student_id = ? AND status <> 'cancelled'`, [schoolId, studentId]);
    return { entries: rows, outstanding: round(Number(due[0]?.balance ?? 0)) };
  }
  /**
   * What the receivable account should show: everything invoiced, minus everything paid. Unallocated
   * payments (advances) sit as a credit, so `outstanding` alone never matches the ledger — `net` does.
   */
  async receivablesSummary(schoolId: string) {
    const inv = await this.db.query<{ invoiced: number; paid: number }>(`SELECT COALESCE(SUM(total), 0) AS invoiced, COALESCE(SUM(paid_total), 0) AS paid FROM invoices WHERE school_id = ? AND status <> 'cancelled'`, [schoolId]);
    const payments = await this.db.query<{ received: number }>(`SELECT COALESCE(SUM(amount), 0) AS received FROM payments WHERE school_id = ? AND status = 'success'`, [schoolId]);
    const refunds = await this.db.query<{ refunded: number }>(`SELECT COALESCE(SUM(amount), 0) AS refunded FROM refunds WHERE school_id = ? AND status = 'refunded'`, [schoolId]);
    const invoiced = round(Number(inv[0]?.invoiced ?? 0)), allocated = round(Number(inv[0]?.paid ?? 0));
    const received = round(Number(payments[0]?.received ?? 0)), refunded = round(Number(refunds[0]?.refunded ?? 0));
    const advances = round(received - refunded - allocated);
    return { invoiced, allocated, received, refunded, advances, outstanding: round(invoiced - allocated), net: round(invoiced - received + refunded) };
  }

  async dues(schoolId: string, f: { classId?: string; minDays?: number } = {}) {
    const where = ['i.school_id = ?', 'i.balance > 0', `i.status <> 'cancelled'`]; const params: unknown[] = [schoolId];
    if (f.classId) { where.push('s.current_class_id = ?'); params.push(f.classId); }
    if (f.minDays) { where.push('i.due_date <= ?'); params.push(new Date(Date.now() - f.minDays * 86400_000).toISOString().slice(0, 10)); }
    return this.db.query<Row>(`SELECT s.id AS student_id, s.first_name, s.last_name, s.admission_no, c.name AS class_name, COUNT(i.id) AS invoices, SUM(i.balance) AS due, MIN(i.due_date) AS oldest_due
      FROM invoices i JOIN students s ON s.id = i.student_id LEFT JOIN classes c ON c.id = s.current_class_id WHERE ${where.join(' AND ')}
      GROUP BY s.id, s.first_name, s.last_name, s.admission_no, c.name ORDER BY SUM(i.balance) DESC LIMIT 300`, params);
  }

  // ---------- counter cash ----------
  async openCashSession(schoolId: string, cashierId: string, openingCash = 0) {
    const open = await this.db.findOne<Row>('cash_sessions', { school_id: schoolId, cashier_id: cashierId, closed_at: null });
    if (open) return { id: String(open.id), already: true };
    const id = ulid();
    await this.db.insert('cash_sessions', { id, school_id: schoolId, cashier_id: cashierId, opened_at: nowSql(), opening_cash: openingCash });
    return { id, already: false };
  }
  async closeCashSession(schoolId: string, sessionId: string, countedCash: number) {
    const s = await this.db.findOne<Row>('cash_sessions', { id: sessionId, school_id: schoolId });
    if (!s) throw notFound('cash session');
    const collected = await this.db.query<{ total: number }>(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE cash_session_id = ? AND method = 'cash' AND status = 'success'`, [sessionId]);
    const expected = round(Number(s.opening_cash) + Number(collected[0]?.total ?? 0));
    const variance = round(countedCash - expected);
    await this.db.update('cash_sessions', { closed_at: nowSql(), expected_cash: expected, counted_cash: countedCash, variance, updated_at: nowSql() }, { id: sessionId });
    return { expected, counted: countedCash, variance };
  }
  async openSessionFor(schoolId: string, cashierId: string) { return this.db.findOne<Row>('cash_sessions', { school_id: schoolId, cashier_id: cashierId, closed_at: null }); }

  // ---------- gateways / IPN ----------
  async saveGateway(schoolId: string, g: { provider: 'sslcommerz' | 'bkash' | 'nagad' | 'rocket' | 'upay' | 'aamarpay' | 'shurjopay'; displayName: string; credentials: Record<string, string>; isSandbox?: boolean; feePct?: number }) {
    const ex = await this.db.findOne<{ id: string }>('payment_gateways', { school_id: schoolId, provider: g.provider });
    const row = { display_name: g.displayName, credentials: { enc: encryptSecret(JSON.stringify(g.credentials), this.appKey) }, is_sandbox: g.isSandbox ?? true, is_active: true, fee_pct: g.feePct ?? 0, fee_fixed: 0 };
    if (ex) { await this.db.update('payment_gateways', { ...row, updated_at: nowSql() }, { id: ex.id }); return ex.id; }
    const id = ulid(); await this.db.insert('payment_gateways', { id, school_id: schoolId, provider: g.provider, ...row, sort_order: 0 }); return id;
  }
  async gateways(schoolId: string) {
    const rows = await this.db.findMany<Row>('payment_gateways', { school_id: schoolId, is_active: true }, { orderBy: 'sort_order ASC' });
    return rows.map(r => ({ id: String(r.id), provider: String(r.provider), displayName: String(r.display_name), isSandbox: !!Number(r.is_sandbox), feePct: Number(r.fee_pct) }));
  }
  /** Credentials live encrypted under APP_KEY inside the JSON column ({"enc": "v1..."}). */
  gatewayCredentials(gateway: Row): Record<string, string> {
    try {
      const wrapper = json<{ enc?: string }>(gateway.credentials);
      if (!wrapper?.enc) return {};
      return JSON.parse(decryptSecret(wrapper.enc, this.appKey)) as Record<string, string>;
    } catch { return {}; }
  }
  /** Signature every IPN must carry, so a forged callback cannot mark an invoice paid. */
  ipnSignature(gatewayId: string, txnId: string, amount: number) {
    return createHmac('sha256', this.appKey).update(`${gatewayId}:${txnId}:${amount.toFixed(2)}`).digest('hex');
  }
  verifyIpnSignature(gatewayId: string, txnId: string, amount: number, signature: string) {
    const expected = this.ipnSignature(gatewayId, txnId, amount);
    return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }
  /**
   * Gateway callback. Idempotent on `gateway_txn_id`, so a retried IPN never double-credits.
   * The provider-specific verification call lives behind `verify` (SSLCommerz validation API,
   * bKash query API); until a school configures credentials the signed payload is the source of truth.
   */
  async handleIpn(schoolId: string, input: { gatewayId: string; txnId: string; amount: number; status: 'success' | 'failed'; studentId?: string | null; invoiceIds?: string[]; payload?: unknown }) {
    const gateway = await this.db.findOne<Row>('payment_gateways', { id: input.gatewayId, school_id: schoolId });
    if (!gateway) throw notFound('gateway');
    const existing = await this.db.findOne<Row>('payments', { gateway_id: input.gatewayId, gateway_txn_id: input.txnId });
    if (existing) return { paymentId: String(existing.id), duplicate: true };
    if (input.status !== 'success') return { duplicate: false, ignored: 'not a successful payment' };
    const method = (['bkash', 'nagad', 'rocket', 'upay'].includes(String(gateway.provider)) ? String(gateway.provider) : 'sslcommerz') as PaymentInput['method'];
    const r = await this.recordPayment(schoolId, { studentId: input.studentId ?? null, amount: input.amount, method, invoiceIds: input.invoiceIds, gatewayId: input.gatewayId, gatewayTxnId: input.txnId, gatewayPayload: input.payload, reference: input.txnId });
    return { paymentId: r.id, paymentNo: r.paymentNo, duplicate: false };
  }

  // ---------- scheduled jobs ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      'fees.generate_invoices': async ({ schoolId }) => this.generateBatch(schoolId, {}),
      // an instalment becomes an invoice on the day it falls due, never before
      'fees.instalments_due': async ({ schoolId }) => this.billDueInstalments(schoolId),
      'fees.reminders': async ({ schoolId }) => this.runReminders(schoolId),
      'fees.overdue_and_fines': async ({ schoolId }) => this.applyOverdueAndFines(schoolId),
      'fees.day_end_summary': async ({ schoolId }) => this.dayEndSummary(schoolId),
    };
  }

  /**
   * F3: the reminder ladder. For each unpaid invoice the highest stage whose threshold has passed
   * and has not been sent yet fires — so a day the scheduler missed (a shared host asleep, a process
   * recycle) still sends the right message instead of skipping the stage forever.
   */
  async runReminders(schoolId: string, today = nowSql().slice(0, 10)) {
    const invoices = await this.db.query<Row>(`SELECT i.*, s.first_name, s.last_name FROM invoices i JOIN students s ON s.id = i.student_id
      WHERE i.school_id = ? AND i.balance > 0 AND i.status IN ('issued','partially_paid','overdue') AND i.due_date <= ? ORDER BY i.due_date LIMIT 1000`, [schoolId, new Date(Date.parse(today) + 3 * 86400_000).toISOString().slice(0, 10)]);
    let sent = 0;
    for (const inv of invoices) {
      const daysPast = Math.floor((Date.parse(today) - Date.parse(String(inv.due_date))) / 86400_000);
      const reached = REMINDER_LADDER.filter(s => daysPast >= s.offsetDays);
      const stage = reached[reached.length - 1];
      if (!stage) continue;
      if (await this.db.findOne('fee_reminders', { invoice_id: String(inv.id), stage: stage.stage, channel: 'sms' })) continue;
      const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [String(inv.student_id)]);
      for (const g of guardians) {
        await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['sms', 'push', 'in_app'], eventKey: 'fees.reminder', data: { student: String(inv.first_name), amount: Number(inv.balance), due: String(inv.due_date), month: String(inv.billing_period).slice(0, 7) }, title: daysPast > 0 ? 'Fee overdue' : 'Fee due', body: `${inv.first_name}: Tk ${Number(inv.balance)} ${daysPast > 0 ? `overdue since ${inv.due_date}` : `due on ${inv.due_date}`}.`, entityType: 'fees.invoice', entityId: String(inv.id) });
      }
      await this.db.insert('fee_reminders', { id: ulid(), school_id: schoolId, invoice_id: String(inv.id), stage: stage.stage, channel: 'sms', notification_id: null, sent_at: nowSql() });
      await this.db.update('invoices', { last_reminder_stage: stage.stage, last_reminder_at: nowSql() }, { id: String(inv.id) });
      sent++;
    }
    return { sent };
  }

  /** F4: past the grace period an unpaid invoice becomes overdue and picks up the configured fine. */
  async applyOverdueAndFines(schoolId: string, today = nowSql().slice(0, 10)) {
    const overdue = await this.db.query<Row>(`SELECT * FROM invoices WHERE school_id = ? AND balance > 0 AND due_date < ? AND status IN ('issued','partially_paid') LIMIT 1000`, [schoolId, today]);
    if (!overdue.length) return { overdue: 0, fined: 0, fineTotal: 0 };
    const rules = await this.db.findMany<Row>('late_fine_rules', { school_id: schoolId });
    const rule = rules[0];
    let fined = 0, fineTotal = 0;
    for (const inv of overdue) {
      await this.db.update('invoices', { status: 'overdue', updated_at: nowSql() }, { id: String(inv.id) });
      if (!rule || inv.fine_applied_at) continue;
      const days = Math.floor((Date.parse(today) - Date.parse(String(inv.due_date))) / 86400_000);
      if (days <= Number(rule.grace_days ?? 0)) continue;
      const base = Number(inv.balance);
      let fine = 0;
      if (rule.fine_type === 'flat') fine = Number(rule.value);
      else if (rule.fine_type === 'percent') fine = round(base * Number(rule.value) / 100);
      else if (rule.fine_type === 'per_day') fine = round(Number(rule.value) * (days - Number(rule.grace_days ?? 0)));
      else if (rule.fine_type === 'per_week') fine = round(Number(rule.value) * Math.ceil((days - Number(rule.grace_days ?? 0)) / 7));
      if (rule.max_amount) fine = Math.min(fine, Number(rule.max_amount));
      if (fine <= 0) continue;
      await this.db.transaction(async t => {
        await t.insert('invoice_items', { id: ulid(), school_id: schoolId, invoice_id: String(inv.id), fee_head_id: (rule.fine_head_id as string) ?? null, description: `Late fine (${days} days)`, quantity: 1, unit_amount: fine, discount_amount: 0, tax_amount: 0, amount: fine, item_kind: 'fine' });
        const total = round(Number(inv.total) + fine);
        await t.update('invoices', { fine_total: round(Number(inv.fine_total) + fine), total, balance: round(total - Number(inv.paid_total)), fine_applied_at: nowSql(), updated_at: nowSql() }, { id: String(inv.id) });
        await this.ledger(schoolId, String(inv.student_id), { entryType: 'fine', refType: 'invoice', refId: String(inv.id), debit: fine, description: 'Late fine' }, t);
        await this.accounting.post(schoolId, { memo: `Late fine ${inv.invoice_no}`, sourceType: 'fine', sourceId: String(inv.id), lines: [{ accountCode: '1300', debit: fine }, { accountCode: '4170', credit: fine }] }, t);
      });
      fined++; fineTotal = round(fineTotal + fine);
    }
    return { overdue: overdue.length, fined, fineTotal };
  }

  /** F10: the day's collection by method, rolled into `fee_collection_daily` for the dashboard. */
  async dayEndSummary(schoolId: string, day = nowSql().slice(0, 10)) {
    const rows = await this.db.query<Row>(`SELECT method, COUNT(*) AS n, SUM(amount) AS total FROM payments WHERE school_id = ? AND status = 'success' AND paid_at >= ? AND paid_at <= ? GROUP BY method`, [schoolId, `${day} 00:00:00`, `${day} 23:59:59`]);
    for (const r of rows) {
      const ex = await this.db.findOne<{ id: string }>('fee_collection_daily', { school_id: schoolId, on_date: day, method: String(r.method) });
      const values = { count: Number(r.n), amount: round(Number(r.total)) };
      if (ex) await this.db.update('fee_collection_daily', values, { id: ex.id }); else await this.db.insert('fee_collection_daily', { id: ulid(), school_id: schoolId, on_date: day, method: String(r.method), ...values });
    }
    const total = round(rows.reduce((a, r) => a + Number(r.total), 0));
    if (total > 0) await this.notifications.notifyRole(schoolId, 'accountant', { channels: ['in_app', 'push'], eventKey: 'fees.day_end', title: 'Today’s collection', body: `Tk ${total} collected in ${rows.reduce((a, r) => a + Number(r.n), 0)} payments.`, data: { total } });
    return { day, methods: rows.length, total };
  }
  async collectionSummary(schoolId: string, from: string, to: string) {
    return this.db.query<Row>(`SELECT on_date, method, count, amount FROM fee_collection_daily WHERE school_id = ? AND on_date BETWEEN ? AND ? ORDER BY on_date DESC`, [schoolId, from, to]);
  }
  async batches(schoolId: string) { return this.db.findMany<Row>('invoice_batches', { school_id: schoolId }, { orderBy: 'billing_period DESC', limit: 24 }); }
  async ensureFineRule(schoolId: string) {
    if (await this.db.count('late_fine_rules', { school_id: schoolId })) return null;
    const head = await this.db.findOne<Row>('fee_heads', { school_id: schoolId, code: 'LATE_FINE' });
    const id = ulid();
    await this.db.insert('late_fine_rules', { id, school_id: schoolId, name: 'Standard late fine', grace_days: 5, fine_type: 'per_week', value: 50, max_amount: 500, fine_head_id: head ? String(head.id) : null });
    return id;
  }
}
