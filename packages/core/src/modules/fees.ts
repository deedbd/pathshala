import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters, JobContext, ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { TaskService } from '../tasks.js';
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

/**
 * The reminder ladder (F3). The last rung is deliberately not a message: a family that has ignored
 * five texts is not going to read a sixth, and sending it is how a school teaches its guardians that
 * its messages can be ignored. At +30 the ladder stops and hands the invoice to a person — see
 * `CALL_STAGE`.
 */
const REMINDER_LADDER: { stage: string; offsetDays: number }[] = [
  { stage: 'due_in_3', offsetDays: -3 }, { stage: 'due_today', offsetDays: 0 }, { stage: 'overdue_3', offsetDays: 3 }, { stage: 'overdue_7', offsetDays: 7 }, { stage: 'overdue_15', offsetDays: 15 },
  { stage: 'overdue_30', offsetDays: 30 },
];
/** The rung that raises a call task for the office instead of texting the family again. */
const CALL_STAGE = 'overdue_30';
/** Early payment: the percentage that comes off when a school has never configured a scheme of its own. */
const EARLY_PAYMENT_PCT = 2;

/** How long the office waits for a cheque before somebody has to say what the bank did with it. */
const CHEQUE_CLEARING_DAYS = 5;
/** An instalment invoice this far past its date means the plan has gone quiet and needs a person. */
const QUIET_PLAN_DAYS = 14;
/** A batch still pending after this long was interrupted — a recycled process, a host asleep. */
const STALE_BATCH_MINUTES = 60;

const shiftDay = (day: string, n: number) => new Date(Date.parse(day) + n * 86400_000).toISOString().slice(0, 10);

/**
 * Does a structure item fall due in this calendar month (1–12)?
 *
 * Exported because the forecast bills the same structures forward months before the invoice run
 * touches them. Two copies of this rule would drift apart on the first school that puts its exam
 * fee in an odd month, and a projection that disagrees with the invoices the school actually
 * raises is worse than no projection at all.
 */
export function fallsDueInMonth(frequency: Frequency, applicableMonths: number[] | null | undefined, month: number): boolean {
  const listed = applicableMonths?.length ? applicableMonths : null;
  if (frequency === 'monthly') return !listed || listed.includes(month);
  if (frequency === 'quarterly') return [1, 4, 7, 10].includes(month);
  if (frequency === 'half_yearly') return listed ? listed.includes(month) : [1, 7].includes(month);
  if (frequency === 'yearly' || frequency === 'one_time') return listed ? listed.includes(month) : month === 1;
  if (frequency === 'per_term') return [1, 5, 9].includes(month);
  return false;
}

/**
 * Fees: heads and structures per class, per-student overrides and discounts, the monthly invoice
 * batch (chunked, pro-rata for mid-month admissions), payments with allocation oldest-first, the
 * student ledger, the reminder ladder, late fines, refunds, counter cash sessions, and gateway IPN
 * for bKash / Nagad / SSLCommerz. Every money movement posts a journal entry through AccountingService,
 * so the trial balance is produced from the same rows — "zero manual fee journals".
 */
export class FeesService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService, private tasks: TaskService, private numbering: NumberingService, private academic: AcademicService, private accounting: AccountingService, private documents: DocumentService, private adapters: Adapters, private appKey: string) {}

  // ---------- structures ----------
  async heads(schoolId: string) { return this.db.findMany<Row>('fee_heads', { school_id: schoolId, status: 'active' }, { orderBy: 'name ASC' }); }
  /**
   * A head another module needs for its own billing — one coaching course, say — rather than one the
   * office typed in. It is keyed on the code, so calling it again for the same thing hands back the
   * head that already exists instead of splitting the income across two lines of the ledger.
   */
  async ensureHead(schoolId: string, h: { name: string; code: string; kind?: 'academic' | 'transport' | 'hostel' | 'fine' | 'misc' | 'course' | 'shop' | 'canteen'; glCode?: string }) {
    const code = h.code.trim().toUpperCase().slice(0, 20);
    const ex = await this.db.findOne<{ id: string }>('fee_heads', { school_id: schoolId, code });
    if (ex) return ex.id;
    const gl = await this.db.findOne<{ id: string }>('gl_accounts', { school_id: schoolId, code: h.glCode ?? '4100' });
    const id = ulid();
    await this.db.insert('fee_heads', { id, school_id: schoolId, name: h.name.slice(0, 80), code, head_kind: h.kind ?? 'misc', gl_account_id: gl ? gl.id : null, is_refundable: false, tax_pct: 0, status: 'active' });
    return id;
  }
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
      if (!fallsDueInMonth(freq, json<number[]>(it.applicable_months), month)) continue;
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
    // the batch says so itself: nobody has to open the page to find out whether the month was billed
    await this.outbox.emitNow({ type: 'invoice.batch_finished', schoolId, aggregateType: 'fees.invoice_batch', aggregateId: batchId, payload: { batchId, billingPeriod, invoices: count, total } });
    await this.notifications.notifyRole(schoolId, 'accountant', { channels: ['in_app', 'push'], eventKey: 'fees.batch_finished', title: 'Invoices raised', body: `${count} invoices for ${billingPeriod.slice(0, 7)}, Tk ${total} in total.`, entityType: 'fees.invoice_batch', entityId: batchId });
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
      // "Early payment 2% — auto-applied": the discount comes off before a taka is allocated, so the
      // family's money goes further rather than the school quietly keeping the difference.
      const paidOn = paidAt.slice(0, 10);
      for (const inv of [...named, ...others]) {
        if (left <= 0) break;
        await this.applyEarlyPayment(schoolId, t, inv, paidOn, left);
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
  /**
   * The school's early-payment scheme. A school that has switched it off, renamed it or set its own
   * percentage keeps that decision; only a school that has never had one at all gets the default,
   * because the prototype promises the discount is applied without anybody configuring anything.
   */
  private async earlyPaymentScheme(schoolId: string, t: Db): Promise<Row | null> {
    const rows = await t.query<Row>(`SELECT * FROM discount_schemes WHERE school_id = ? AND discount_kind = 'early_payment' ORDER BY name LIMIT 10`, [schoolId]);
    if (rows.length) return rows.find(r => String(r.status) === 'active') ?? null;
    // two payments taken at the same counter in the same second would both find nothing and both
    // insert; the name is unique, so one of them loses. Losing must not fail the payment — it means
    // the scheme is there, which is all this asked for — and on Postgres an expected failure has to
    // sit in a savepoint or it takes the whole transaction with it.
    const id = ulid();
    const made = await t.attempt(async () => {
      await t.insert('discount_schemes', { id, school_id: schoolId, name: 'Early payment', discount_kind: 'early_payment', value_type: 'percent', value: EARLY_PAYMENT_PCT, applies_to_heads: null, auto_rule: null, requires_approval: false, budget_cap: null, status: 'active' });
      return true;
    }).catch(() => false);
    if (made) return t.findOne<Row>('discount_schemes', { id });
    return t.findOne<Row>('discount_schemes', { school_id: schoolId, name: 'Early payment', status: 'active' });
  }
  /** Creates the scheme at provisioning so the console can show it before anybody has paid anything. */
  async ensureEarlyPaymentDiscount(schoolId: string) {
    return this.db.transaction(async t => (await this.earlyPaymentScheme(schoolId, t))?.id ?? null);
  }
  /**
   * Money that arrives before the invoice falls due earns the discount, **once**: the adjustment line
   * it writes is its own guard, so a second payment on the same invoice — or a relay that delivers
   * `payment.received` twice — takes nothing more off.
   *
   * Two things it deliberately refuses. A part-paid invoice: the discount is for settling early, and
   * once a payment has landed the invoice is no longer being settled early. And a payment that does
   * not cover the discounted balance: otherwise a family pays Tk 1 the day before the due date and
   * takes 2% off the whole term. A fine is never discounted either — a fine is what lateness cost,
   * and it did not arrive early.
   */
  private async applyEarlyPayment(schoolId: string, t: Db, inv: Row, paidOn: string, available: number): Promise<number> {
    const due = String(inv.due_date).slice(0, 10);
    if (!(paidOn < due)) return 0;
    if (Number(inv.paid_total) > 0) return 0;
    if (await t.findOne('invoice_items', { invoice_id: String(inv.id), source_type: 'early_payment' })) return 0;
    const scheme = await this.earlyPaymentScheme(schoolId, t);
    if (!scheme) return 0;
    const base = round(Number(inv.total) - Number(inv.fine_total ?? 0));
    if (base <= 0) return 0;
    const amount = round(String(scheme.value_type) === 'flat' ? Math.min(Number(scheme.value), base) : base * Number(scheme.value) / 100);
    if (amount <= 0) return 0;
    if (available < round(Number(inv.balance) - amount)) return 0;
    const days = Math.round((Date.parse(due) - Date.parse(paidOn)) / 86400_000);
    const reason = `${scheme.name} · ${String(scheme.value_type) === 'flat' ? `Tk ${Number(scheme.value)}` : `${Number(scheme.value)}%`} for paying ${days} day${days === 1 ? '' : 's'} before ${due}`;
    await t.insert('invoice_items', { id: ulid(), school_id: schoolId, invoice_id: String(inv.id), fee_head_id: null, description: reason.slice(0, 200), quantity: 1, unit_amount: -amount, discount_amount: amount, discount_id: null, tax_amount: 0, amount: -amount, item_kind: 'adjustment', source_type: 'early_payment', source_id: String(scheme.id) });
    const total = round(Number(inv.total) - amount);
    const balance = round(total - Number(inv.paid_total));
    await t.update('invoices', { discount_total: round(Number(inv.discount_total ?? 0) + amount), total, balance, updated_at: nowSql() }, { id: String(inv.id) });
    inv.total = total; inv.balance = balance; inv.discount_total = round(Number(inv.discount_total ?? 0) + amount);
    if (inv.student_id) await this.ledger(schoolId, String(inv.student_id), { entryType: 'adjustment', refType: 'invoice', refId: String(inv.id), credit: amount, description: reason.slice(0, 200) }, t);
    // give the income back where the invoice credited it: Dr each head's income account pro rata, Cr receivable
    const items = await t.query<Row>(`SELECT fee_head_id, amount FROM invoice_items WHERE invoice_id = ? AND item_kind = 'fee' AND amount > 0`, [String(inv.id)]);
    const gross = round(items.reduce((a, i) => a + Number(i.amount), 0));
    const lines: { accountId?: string; accountCode?: string; debit?: number; credit?: number; description?: string }[] = [];
    if (gross > 0) {
      const byAccount = new Map<string, number>();
      let spread = 0;
      for (let i = 0; i < items.length; i++) {
        const share = i === items.length - 1 ? round(amount - spread) : round(amount * Number(items[i].amount) / gross);
        spread = round(spread + share);
        const acc = String((await this.accountForHead(schoolId, items[i].fee_head_id as string | null)).id);
        byAccount.set(acc, round((byAccount.get(acc) ?? 0) + share));
      }
      for (const [accountId, debit] of byAccount) if (debit) lines.push({ accountId, debit });
    } else lines.push({ accountId: String((await this.accountForHead(schoolId, null)).id), debit: amount });
    lines.push({ accountCode: '1300', credit: amount, description: String(inv.invoice_no) });
    await this.accounting.post(schoolId, { entryDate: paidOn, memo: `Early payment discount ${inv.invoice_no}`, sourceType: 'discount', sourceId: String(inv.id), lines }, t);
    return amount;
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
    // F10: a till that does not add up is said out loud the moment it is counted, not found in a report
    if (variance !== 0) {
      const body = `Counter cash was Tk ${countedCash} against Tk ${expected} expected — ${variance > 0 ? 'a surplus' : 'a shortfall'} of Tk ${Math.abs(variance)}.`;
      for (const role of ['accountant', 'admin']) await this.notifications.notifyRole(schoolId, role, { channels: ['in_app', 'push'], eventKey: 'fees.cash_variance', title: 'Cash does not match', body, entityType: 'fees.cash_session', entityId: sessionId });
    }
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
      // F14: everything in the fee module that today waits for somebody to remember it
      'fees.money_watch': async ({ schoolId, payload, deadline }) => this.moneyWatch(schoolId, { today: (payload.onDate as string) || undefined, deadline }),
      // F15: what is owed, by how long — the figure the office otherwise rebuilds by hand each month
      'fees.receivables_ageing': async ({ schoolId, payload }) => this.ageingReport(schoolId, (payload.onDate as string) || undefined),
    };
  }

  /** An open task already standing for this thing: the watchdogs never ask twice for the same row. */
  private async openTaskFor(schoolId: string, entityType: string, entityId: string) {
    return this.db.findOne<Row>('tasks', { school_id: schoolId, entity_type: entityType, entity_id: entityId, status: 'open' });
  }
  /** Has this exact message already gone out since `since`? Keeps a daily job from repeating itself. */
  private async messagedSince(schoolId: string, eventKey: string, entityId: string, since: string) {
    const r = await this.db.query<{ id: string }>(`SELECT id FROM notifications WHERE school_id = ? AND event_key = ? AND entity_id = ? AND created_at >= ? LIMIT 1`, [schoolId, eventKey, entityId, since]);
    return !!r[0];
  }

  /**
   * F14: the daily walk over money that has stopped moving. Each pass is either carried out (nothing
   * to decide, nothing to lose) or *prepared* as one task with everything already filled in:
   *
   * - receipts nobody printed → issued (the payment is already recorded; the PDF is just its copy)
   * - a cheque past its clearing window → **a person decides**: only the bank knows whether it was
   *   honoured, and clearing it moves money onto the ledger, so the task carries the cheque number,
   *   the amount and the child, and the office presses clear or bounce
   * - a till left open overnight → **a person decides**: the counted cash is not in the database
   * - an instalment plan whose billed instalment went unpaid → **a person decides** what to offer next
   * - a discount whose `valid_to` has passed → expired (the school already set the date)
   * - an invoice batch nobody finished → re-queued, and a month that was never billed at all is billed
   * - a fee head with no income account → **a person decides** which account it belongs to
   *
   * Everything here is keyed on an open task or on the row's own state, so running it twice in a day
   * changes nothing the first run did not already do.
   */
  async moneyWatch(schoolId: string, opts: { today?: string; deadline?: number; clearingDays?: number; quietDays?: number } = {}) {
    const today = opts.today ?? nowSql().slice(0, 10);
    const deadline = opts.deadline ?? Date.now() + 20_000;
    const out = { receipts: 0, cheques: 0, cashSessions: 0, quietPlans: 0, discountsExpired: 0, batches: 0, headsWithoutAccount: 0 };

    // ---- receipts nobody printed ----
    const unreceipted = await this.db.query<Row>(`SELECT id FROM payments WHERE school_id = ? AND status = 'success' AND receipt_file_id IS NULL ORDER BY paid_at LIMIT 100`, [schoolId]);
    for (const p of unreceipted) {
      if (Date.now() > deadline) break;
      // a payment whose template is missing is left for the next pass rather than failing the job
      try { const r = await this.issueReceipt(schoolId, String(p.id)); if (!(r as { alreadyIssued?: boolean }).alreadyIssued) out.receipts++; } catch { /* next time */ }
    }

    // ---- cheques past their clearing window ----
    const clearingCutoff = shiftDay(today, -(opts.clearingDays ?? CHEQUE_CLEARING_DAYS));
    const stale = await this.db.query<Row>(`SELECT p.*, s.first_name, s.last_name, s.admission_no FROM payments p LEFT JOIN students s ON s.id = p.student_id
      WHERE p.school_id = ? AND p.method = 'cheque' AND p.status = 'pending' AND p.paid_at <= ? ORDER BY p.paid_at LIMIT 200`, [schoolId, `${clearingCutoff} 23:59:59`]);
    for (const c of stale) {
      if (await this.openTaskFor(schoolId, 'fees.payment', String(c.id))) continue;
      const days = Math.max(0, Math.floor((Date.parse(today) - Date.parse(String(c.paid_at).slice(0, 10))) / 86400_000));
      const who = c.first_name ? `${c.first_name} ${c.last_name ?? ''}`.trim() : 'a counter payment';
      await this.tasks.create({
        schoolId, title: `Cheque ${c.reference} for Tk ${Number(c.amount)} has not cleared`, taskType: 'fees.cheque', assignedRole: 'accountant', priority: 'high',
        description: `${who} handed this cheque in ${days} days ago and it is still pending. Ask the bank, then clear it or mark it returned — nothing is on the ledger until you do.`,
        entityType: 'fees.payment', entityId: String(c.id),
      });
      await this.outbox.emitNow({ type: 'cheque.overdue', schoolId, aggregateType: 'fees.payment', aggregateId: String(c.id), payload: { paymentId: String(c.id), studentId: (c.student_id as string) ?? '', amount: Number(c.amount), reference: String(c.reference ?? ''), days } });
      out.cheques++;
    }

    // ---- a till left open overnight ----
    const openTills = await this.db.query<Row>(`SELECT * FROM cash_sessions WHERE school_id = ? AND closed_at IS NULL AND opened_at < ? ORDER BY opened_at LIMIT 100`, [schoolId, `${today} 00:00:00`]);
    for (const s of openTills) {
      if (await this.openTaskFor(schoolId, 'fees.cash_session', String(s.id))) continue;
      const collected = await this.db.query<{ total: number }>(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE cash_session_id = ? AND method = 'cash' AND status = 'success'`, [String(s.id)]);
      const expected = round(Number(s.opening_cash) + Number(collected[0]?.total ?? 0));
      await this.tasks.create({
        schoolId, title: `Close the counter of ${String(s.opened_at).slice(0, 10)}`, taskType: 'fees.cash_session', assignedTo: (s.cashier_id as string) ?? null, assignedRole: s.cashier_id ? null : 'accountant', priority: 'high',
        description: `The till has been open since ${String(s.opened_at).slice(0, 16)}. Tk ${expected} should be in it. Count the cash and close the session — the counted amount is the one thing the system cannot know.`,
        entityType: 'fees.cash_session', entityId: String(s.id),
      });
      out.cashSessions++;
    }

    // ---- an instalment plan that has gone quiet ----
    const quietCutoff = shiftDay(today, -(opts.quietDays ?? QUIET_PLAN_DAYS));
    const plans = await this.db.findMany<Row>('instalment_plans', { school_id: schoolId, status: 'active' }, { limit: 300 });
    for (const plan of plans) {
      const rows = json<{ due: string; amount: number; invoiceId: string | null }[]>(plan.instalments) ?? [];
      const billed = rows.map(r => r.invoiceId).filter((v): v is string => !!v);
      if (!billed.length) continue;
      const late = await this.db.query<Row>(`SELECT invoice_no, balance, due_date FROM invoices WHERE school_id = ? AND id IN (${billed.map(() => '?').join(',')}) AND balance > 0 AND due_date <= ? ORDER BY due_date LIMIT 1`, [schoolId, ...billed, quietCutoff]);
      if (!late[0]) continue;
      if (await this.openTaskFor(schoolId, 'fees.instalment_plan', String(plan.id))) continue;
      const student = await this.db.findOne<Row>('students', { id: String(plan.student_id) });
      await this.tasks.create({
        schoolId, title: `Instalment plan of ${student ? `${student.first_name} ${student.last_name ?? ''}`.trim() : 'a student'} has stopped`, taskType: 'fees.instalment_plan', assignedRole: 'accountant', priority: 'normal',
        description: `${late[0].invoice_no} was due ${String(late[0].due_date)} and Tk ${Number(late[0].balance)} of it is unpaid. The reminders have already gone out. Re-plan it, or cancel the plan — both take money off the family, so neither is done automatically.`,
        entityType: 'fees.instalment_plan', entityId: String(plan.id),
      });
      out.quietPlans++;
    }

    // ---- a discount whose end date has passed is not a discount any more ----
    const done = await this.db.query<Row>(`SELECT id, student_id, discount_scheme_id, valid_to FROM student_discounts WHERE school_id = ? AND status = 'approved' AND valid_to IS NOT NULL AND valid_to < ? LIMIT 200`, [schoolId, today]);
    for (const d of done) {
      await this.db.update('student_discounts', { status: 'expired', updated_at: nowSql() }, { id: String(d.id) });
      await this.outbox.emitNow({ type: 'discount.expired', schoolId, aggregateType: 'fees.discount', aggregateId: String(d.id), payload: { discountId: String(d.id), studentId: String(d.student_id), schemeId: String(d.discount_scheme_id), validTo: String(d.valid_to) } });
      out.discountsExpired++;
    }

    // ---- a batch nobody finished, and a month nobody billed ----
    const staleAt = nowSql(new Date(Date.now() - STALE_BATCH_MINUTES * 60_000));
    const stuck = await this.db.query<Row>(`SELECT id FROM invoice_batches WHERE school_id = ? AND status IN ('pending','running') AND (started_at IS NULL OR started_at < ?) LIMIT 20`, [schoolId, staleAt]);
    for (const b of stuck) {
      await this.adapters.queue.push({ name: 'fees.generate_invoices', queue: 'batch', schoolId, payload: { batchId: String(b.id) }, triggeredBy: 'fees.money_watch' });
      out.batches++;
    }
    // never on the 1st (the monthly job owns that day) and never for a school that has not billed
    // before: a watchdog must not be the thing that invoices a school for the very first time.
    if (Number(today.slice(8, 10)) >= 2) {
      const period = today.slice(0, 7) + '-01';
      const already = await this.db.findOne('invoice_batches', { school_id: schoolId, billing_period: period });
      const previous = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM invoice_batches WHERE school_id = ? AND billing_period < ? AND status = 'success'`, [schoolId, period]);
      if (!already && Number(previous[0]?.n ?? 0) > 0) {
        try { await this.generateBatch(schoolId, { billingPeriod: period }); out.batches++; } catch { /* no current year yet: the monthly job will say so */ }
      }
    }

    // ---- a fee head with nowhere to post its income ----
    const orphans = await this.db.query<Row>(`SELECT id, name, code FROM fee_heads WHERE school_id = ? AND status = 'active' AND gl_account_id IS NULL LIMIT 50`, [schoolId]);
    for (const h of orphans) {
      if (await this.openTaskFor(schoolId, 'fees.head', String(h.id))) continue;
      await this.tasks.create({
        schoolId, title: `“${h.name}” has no income account`, taskType: 'fees.head', assignedRole: 'accountant', priority: 'normal',
        description: `Invoices for ${h.code} post to general tuition income (4100) instead of an account of their own, so nothing is lost — but the income statement cannot tell this head apart until somebody picks the account it belongs to.`,
        entityType: 'fees.head', entityId: String(h.id),
      });
      out.headsWithoutAccount++;
    }
    return out;
  }

  /** Everything still owed, split by how long it has been owed. Bucketed in SQL: a big school's ledger never lands in memory. */
  async ageing(schoolId: string, asOf = nowSql().slice(0, 10)) {
    const d30 = shiftDay(asOf, -30), d60 = shiftDay(asOf, -60), d90 = shiftDay(asOf, -90);
    const r = await this.db.query<Row>(`SELECT
        COALESCE(SUM(CASE WHEN due_date >= ? THEN balance ELSE 0 END), 0) AS not_due,
        COALESCE(SUM(CASE WHEN due_date < ? AND due_date >= ? THEN balance ELSE 0 END), 0) AS b30,
        COALESCE(SUM(CASE WHEN due_date < ? AND due_date >= ? THEN balance ELSE 0 END), 0) AS b60,
        COALESCE(SUM(CASE WHEN due_date < ? AND due_date >= ? THEN balance ELSE 0 END), 0) AS b90,
        COALESCE(SUM(CASE WHEN due_date < ? THEN balance ELSE 0 END), 0) AS older,
        COUNT(*) AS invoices
      FROM invoices WHERE school_id = ? AND balance > 0 AND status <> 'cancelled'`, [asOf, asOf, d30, d30, d60, d60, d90, d90, schoolId]);
    const row = r[0] ?? {};
    const buckets = { notDue: round(Number(row.not_due ?? 0)), days1to30: round(Number(row.b30 ?? 0)), days31to60: round(Number(row.b60 ?? 0)), days61to90: round(Number(row.b90 ?? 0)), over90: round(Number(row.older ?? 0)) };
    return { asOf, invoices: Number(row.invoices ?? 0), ...buckets, total: round(buckets.notDue + buckets.days1to30 + buckets.days31to60 + buckets.days61to90 + buckets.over90) };
  }

  /** F15: the ageing put in front of accounts once a month — never twice, whatever the scheduler does. */
  async ageingReport(schoolId: string, asOf = nowSql().slice(0, 10)) {
    const a = await this.ageing(schoolId, asOf);
    const month = asOf.slice(0, 7);
    if (await this.messagedSince(schoolId, 'fees.ageing', month, `${month}-01 00:00:00`)) return { ...a, notified: false, already: true };
    if (a.total <= 0) return { ...a, notified: false, already: false };
    const body = `Tk ${a.total} outstanding: Tk ${a.notDue} not yet due, Tk ${a.days1to30} up to a month late, Tk ${a.days31to60} up to two, Tk ${a.days61to90} up to three, Tk ${a.over90} older than that.`;
    for (const role of ['accountant', 'admin']) await this.notifications.notifyRole(schoolId, role, { channels: ['in_app', 'push'], eventKey: 'fees.ageing', title: 'What the school is owed', body, data: { total: a.total, over90: a.over90 }, entityType: 'fees.ageing', entityId: month });
    return { ...a, notified: true, already: false };
  }

  /**
   * F3: the reminder ladder. For each unpaid invoice the highest stage whose threshold has passed
   * and has not been sent yet fires — so a day the scheduler missed (a shared host asleep, a process
   * recycle) still sends the right message instead of skipping the stage forever.
   */
  async runReminders(schoolId: string, today = nowSql().slice(0, 10)) {
    // B5: a school does not chase money on Eid morning. The ladder is keyed on how many days an
    // invoice is past its date, not on how many times this job has run, so holding for a holiday
    // costs nothing — tomorrow's pass sends exactly the stage today's would have sent.
    if (await this.academic.isHoliday(schoolId, today)) return { sent: 0, calls: 0, skipped: 'holiday' as string | null, reason: `${today} is a holiday, so nobody was chased for money` as string | null };
    const invoices = await this.db.query<Row>(`SELECT i.*, s.first_name, s.last_name FROM invoices i JOIN students s ON s.id = i.student_id
      WHERE i.school_id = ? AND i.balance > 0 AND i.status IN ('issued','partially_paid','overdue') AND i.due_date <= ? ORDER BY i.due_date LIMIT 1000`, [schoolId, new Date(Date.parse(today) + 3 * 86400_000).toISOString().slice(0, 10)]);
    let sent = 0, calls = 0;
    for (const inv of invoices) {
      const daysPast = Math.floor((Date.parse(today) - Date.parse(String(inv.due_date))) / 86400_000);
      const reached = REMINDER_LADDER.filter(s => daysPast >= s.offsetDays);
      const stage = reached[reached.length - 1];
      if (!stage) continue;
      const call = stage.stage === CALL_STAGE;
      const channel = call ? 'call_task' : 'sms';
      if (await this.db.findOne('fee_reminders', { invoice_id: String(inv.id), stage: stage.stage, channel })) continue;
      const student = `${inv.first_name} ${inv.last_name ?? ''}`.trim();
      if (call) {
        // F3's last rung: a month overdue is a conversation, not a sixth text. Everything the caller
        // needs is in the task — who, how much, since when and which number to ring — so the office
        // never has to go and look the family up.
        const guardian = (await this.db.query<Row>(`SELECT g.full_name, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? ORDER BY sg.is_primary DESC LIMIT 1`, [String(inv.student_id)]))[0];
        const raised = await this.tasks.ensure({
          schoolId, entityType: 'fees.invoice', entityId: String(inv.id), taskType: 'fees.call_guardian', assignedRole: 'accountant', priority: 'high',
          title: `Ring ${guardian?.full_name ?? 'the guardian'} about ${student}: Tk ${Number(inv.balance)} unpaid for 30 days`,
          description: `Invoice ${inv.invoice_no} (${String(inv.billing_period).slice(0, 7)}) fell due on ${inv.due_date} and Tk ${Number(inv.balance)} is still outstanding. Five reminders have gone to ${guardian?.phone ?? 'the number on file'} and none was answered. Ring the family rather than sending a sixth message.`,
          dueAt: new Date(Date.now() + 48 * 3600_000), createdBy: 'system',
        });
        if (raised) calls++;
      } else {
        const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [String(inv.student_id)]);
        for (const g of guardians) {
          await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['sms', 'push', 'in_app'], eventKey: 'fees.reminder', data: { student: String(inv.first_name), amount: Number(inv.balance), due: String(inv.due_date), month: String(inv.billing_period).slice(0, 7) }, title: daysPast > 0 ? 'Fee overdue' : 'Fee due', body: `${inv.first_name}: Tk ${Number(inv.balance)} ${daysPast > 0 ? `overdue since ${inv.due_date}` : `due on ${inv.due_date}`}.`, entityType: 'fees.invoice', entityId: String(inv.id) });
        }
        sent++;
      }
      await this.db.insert('fee_reminders', { id: ulid(), school_id: schoolId, invoice_id: String(inv.id), stage: stage.stage, channel, notification_id: null, sent_at: nowSql() });
      await this.db.update('invoices', { last_reminder_stage: stage.stage, last_reminder_at: nowSql() }, { id: String(inv.id) });
    }
    return { sent, calls, skipped: null as string | null, reason: null as string | null };
  }
  /** The ladder as the console shows it: every stage, when it fired and what it did. */
  async reminderLadder(schoolId: string, limit = 200) {
    const stages = await this.db.query<Row>(`SELECT stage, channel, COUNT(*) AS n, MAX(sent_at) AS last_sent FROM fee_reminders WHERE school_id = ? GROUP BY stage, channel`, [schoolId]);
    const byStage = new Map(stages.map(s => [`${s.stage}:${s.channel}`, s]));
    const ladder = REMINDER_LADDER.map(s => {
      const channel = s.stage === CALL_STAGE ? 'call_task' : 'sms';
      const row = byStage.get(`${s.stage}:${channel}`);
      return { stage: s.stage, offsetDays: s.offsetDays, channel, sent: Number(row?.n ?? 0), lastSent: (row?.last_sent as string) ?? null };
    });
    const recent = await this.db.query<Row>(`SELECT r.*, i.invoice_no, i.balance, i.due_date, s.first_name, s.last_name FROM fee_reminders r JOIN invoices i ON i.id = r.invoice_id LEFT JOIN students s ON s.id = i.student_id WHERE r.school_id = ? ORDER BY r.sent_at DESC, r.id DESC LIMIT ${Math.min(500, limit)}`, [schoolId]);
    return { ladder, recent };
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
