import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters, ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { NumberingService } from './numbering.js';
import { round } from './accounting.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface PlanInput { name: string; priceMonthly?: number; priceYearly?: number; studentLimit?: number | null; smsIncluded?: number; storageGb?: number; modules?: string[] | null; isPublic?: boolean; sortOrder?: number }

/**
 * The business side: what a school pays the platform, what a reseller earns for bringing them, and
 * what happens when the bill is not paid.
 *
 * This is the one module whose rows are not per-school data but data *about* schools, so it is only
 * ever reachable with a `saas.*` permission, which no school role has — an administrator of a school
 * cannot see, let alone change, their own subscription.
 *
 * What a school that has not paid loses is deliberate: a past-due subscription stops new work, never
 * access to work already done. A school in arrears can still read its records, take attendance and
 * publish results; it cannot send SMS or add students beyond its plan. Locking a school out of its own
 * register over an unpaid invoice would hurt children for an adult's oversight.
 */
export class SaasService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService,
    private numbering: NumberingService, private adapters: Adapters,
  ) {}

  // ---------- plans ----------
  async ensurePlans() {
    if (await this.db.count('saas_plans', {})) return 0;
    const defaults: PlanInput[] = [
      { name: 'Free', priceMonthly: 0, priceYearly: 0, studentLimit: 60, smsIncluded: 0, storageGb: 1, modules: ['academic', 'people', 'attendance', 'fees'], sortOrder: 1 },
      { name: 'Standard', priceMonthly: 2000, priceYearly: 20_000, studentLimit: 500, smsIncluded: 2000, storageGb: 10, modules: null, sortOrder: 2 },
      { name: 'Premium', priceMonthly: 5000, priceYearly: 50_000, studentLimit: null, smsIncluded: 10_000, storageGb: 50, modules: null, sortOrder: 3 },
    ];
    for (const p of defaults) await this.savePlan(p);
    return defaults.length;
  }
  async savePlan(p: PlanInput) {
    const ex = await this.db.findOne<{ id: string }>('saas_plans', { name: p.name });
    const row = { name: p.name, price_monthly: round(p.priceMonthly ?? 0), price_yearly: round(p.priceYearly ?? 0), currency: 'BDT', student_limit: p.studentLimit ?? null, sms_included: p.smsIncluded ?? 0, storage_gb: p.storageGb ?? 5, modules: (p.modules ?? null) as never, is_public: p.isPublic ?? true, sort_order: p.sortOrder ?? 0 };
    if (ex) { await this.db.update('saas_plans', { ...row, updated_at: nowSql() }, { id: ex.id }); return ex.id; }
    const id = ulid();
    await this.db.insert('saas_plans', { id, ...row });
    return id;
  }
  async plans(publicOnly = false) { return this.db.findMany<Row>('saas_plans', publicOnly ? { is_public: true } : {}, { orderBy: 'sort_order ASC' }); }

  // ---------- subscriptions ----------
  /** Puts a school on a plan. A trial is a subscription with an end date and nothing to pay. */
  async subscribe(schoolId: string, s: { planId: string; billingCycle?: 'monthly' | 'yearly'; startsAt?: string; trialDays?: number; discountPct?: number; referralCode?: string | null }) {
    const plan = await this.db.findOne<Row>('saas_plans', { id: s.planId });
    if (!plan) throw notFound('plan');
    if (!(await this.db.findOne('schools', { id: schoolId }))) throw notFound('school');
    const cycle = s.billingCycle ?? 'yearly';
    const list = round(Number(cycle === 'monthly' ? plan.price_monthly : plan.price_yearly));
    const price = round(list * (1 - (s.discountPct ?? 0) / 100));
    const startsAt = s.startsAt ?? nowSql().slice(0, 10);
    const reseller = s.referralCode ? await this.db.findOne<Row>('saas_partners', { referral_code: s.referralCode.trim().toUpperCase(), status: 'active' }) : null;
    const trial = (s.trialDays ?? 0) > 0;
    const endsAt = trial ? this.addDays(startsAt, s.trialDays!) : this.addPeriod(startsAt, cycle);
    const existing = await this.db.findOne<Row>('saas_subscriptions', { school_id: schoolId, status: 'active' });
    if (existing) await this.db.update('saas_subscriptions', { status: 'cancelled', updated_at: nowSql() }, { id: String(existing.id) });
    const id = ulid();
    await this.db.insert('saas_subscriptions', { id, school_id: schoolId, plan_id: s.planId, billing_cycle: cycle, starts_at: startsAt, ends_at: endsAt, status: trial ? 'trial' : 'active', auto_renew: true, price, discount_pct: s.discountPct ?? 0, reseller_id: reseller ? String(reseller.id) : null });
    await this.outbox.emitNow({ type: 'subscription.changed', schoolId, aggregateType: 'saas.subscription', aggregateId: id, payload: { subscriptionId: id, plan: String(plan.name), status: trial ? 'trial' : 'active', price } });
    return { id, plan: String(plan.name), price, endsAt, status: trial ? 'trial' : 'active', reseller: reseller ? String(reseller.name) : null };
  }
  async subscription(schoolId: string) {
    const rows = await this.db.query<Row>(`SELECT s.*, p.name AS plan_name, p.student_limit, p.sms_included, p.storage_gb, p.modules FROM saas_subscriptions s JOIN saas_plans p ON p.id = s.plan_id WHERE s.school_id = ? AND s.status IN ('trial','active','past_due') ORDER BY s.created_at DESC LIMIT 1`, [schoolId]);
    return rows[0] ? { ...rows[0], modules: json(rows[0].modules) } as Row : null;
  }
  async subscriptions(f: { status?: string } = {}) {
    const where = f.status ? ' WHERE s.status = ?' : '';
    return this.db.query<Row>(`SELECT s.*, p.name AS plan_name, sc.name AS school_name, sc.code FROM saas_subscriptions s JOIN saas_plans p ON p.id = s.plan_id JOIN schools sc ON sc.id = s.school_id${where} ORDER BY s.created_at DESC LIMIT 500`, f.status ? [f.status] : []);
  }
  async cancel(schoolId: string, reason?: string) {
    const sub = await this.subscription(schoolId);
    if (!sub) throw notFound('subscription');
    await this.db.update('saas_subscriptions', { status: 'cancelled', auto_renew: false, updated_at: nowSql() }, { id: String(sub.id) });
    await this.outbox.emitNow({ type: 'subscription.changed', schoolId, aggregateType: 'saas.subscription', aggregateId: String(sub.id), payload: { subscriptionId: String(sub.id), plan: String(sub.plan_name), status: 'cancelled', price: Number(sub.price) } });
    return { id: String(sub.id), status: 'cancelled' as const, reason: reason ?? null };
  }

  // ---------- what a plan allows ----------
  /**
   * The one question the rest of the app asks: may this school do this right now? An unpaid bill
   * stops new work — more students than the plan holds, SMS beyond the bundle — and never stops the
   * school reading what it already has.
   */
  async allows(schoolId: string, what: 'add_student' | 'send_sms' | 'module', detail?: string) {
    const sub = await this.subscription(schoolId);
    if (!sub) return { allowed: true, reason: 'no subscription on this installation' as const };
    const pastDue = sub.status === 'past_due';
    if (what === 'module') {
      const modules = json<string[]>(sub.modules);
      if (modules && detail && !modules.includes(detail)) return { allowed: false, reason: `the ${sub.plan_name} plan does not include ${detail}` };
      return { allowed: true, reason: 'included in the plan' as const };
    }
    if (what === 'add_student') {
      if (pastDue) return { allowed: false, reason: 'the subscription is past due; existing students are unaffected' };
      const limit = sub.student_limit == null ? null : Number(sub.student_limit);
      if (limit == null) return { allowed: true, reason: 'no limit on this plan' as const };
      const active = await this.db.count('students', { school_id: schoolId, status: 'active' });
      if (active >= limit) return { allowed: false, reason: `the ${sub.plan_name} plan holds ${limit} students and there are ${active}` };
      return { allowed: true, reason: `${limit - active} places left` };
    }
    if (pastDue) return { allowed: false, reason: 'the subscription is past due' };
    const included = Number(sub.sms_included ?? 0);
    if (!included) return { allowed: true, reason: 'billed as used' as const };
    const used = await this.usage(schoolId, 'sms');
    if (used >= included) return { allowed: false, reason: `${included} messages are included and ${used} have been sent this month` };
    return { allowed: true, reason: `${included - used} messages left this month` };
  }
  /** Counts what a school has used this month, from the rows that recorded it. */
  async meter(schoolId: string, month = nowSql().slice(0, 7) + '-01') {
    const from = month, to = this.addPeriod(month, 'monthly');
    const [sms, students, storage] = await Promise.all([
      this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND channel IN ('sms','voice','whatsapp') AND status IN ('sent','delivered') AND created_at >= ? AND created_at < ?`, [schoolId, `${from} 00:00:00`, `${to} 00:00:00`]),
      this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM students WHERE school_id = ? AND status = 'active'`, [schoolId]),
      this.db.query<{ n: number }>(`SELECT COALESCE(SUM(size_bytes), 0) AS n FROM files WHERE school_id = ?`, [schoolId]),
    ]);
    const rows: [string, number][] = [['sms', Number(sms[0]?.n ?? 0)], ['students', Number(students[0]?.n ?? 0)], ['storage_mb', Math.round(Number(storage[0]?.n ?? 0) / 1_048_576)]];
    for (const [metric, quantity] of rows) {
      const ex = await this.db.findOne<Row>('saas_usage', { school_id: schoolId, month, metric });
      if (ex) await this.db.update('saas_usage', { quantity }, { id: String(ex.id) });
      else await this.db.insert('saas_usage', { id: ulid(), school_id: schoolId, month, metric, quantity });
    }
    return { month, usage: Object.fromEntries(rows) };
  }
  async usage(schoolId: string, metric: string, month = nowSql().slice(0, 7) + '-01') {
    const row = await this.db.findOne<Row>('saas_usage', { school_id: schoolId, month, metric });
    return Number(row?.quantity ?? 0);
  }

  // ---------- billing ----------
  /** Raises the invoice for a period, once. A reseller's commission is recorded with it. */
  async invoice(schoolId: string, opts: { periodStart?: string; dueDays?: number } = {}) {
    const sub = await this.subscription(schoolId);
    if (!sub) throw notFound('subscription');
    const periodStart = opts.periodStart ?? nowSql().slice(0, 10);
    const periodEnd = this.addPeriod(periodStart, String(sub.billing_cycle) as 'monthly' | 'yearly');
    const ex = await this.db.findOne<Row>('saas_invoices', { school_id: schoolId, subscription_id: String(sub.id), period_start: periodStart });
    if (ex) return { id: String(ex.id), invoiceNo: String(ex.invoice_no), total: Number(ex.total), alreadyRaised: true };
    const amount = round(Number(sub.price));
    const id = ulid();
    // the number is unique across the platform, so it carries the school's own code
    const school = await this.db.findOne<Row>('schools', { id: schoolId });
    const invoiceNo = await this.numbering.next(schoolId, 'saas_invoice_no', { prefix: `PS-${String(school?.code ?? '').slice(0, 8)}-`, padding: 4, resetYearly: true });
    await this.db.insert('saas_invoices', { id, school_id: schoolId, subscription_id: String(sub.id), invoice_no: invoiceNo, period_start: periodStart, period_end: periodEnd, amount, tax: 0, total: amount, status: 'issued', due_date: this.addDays(periodStart, opts.dueDays ?? 14), paid_at: null, payment_ref: null, pdf_file_id: null });
    await this.notifications.notifyRole(schoolId, 'admin', { channels: ['email', 'in_app'], eventKey: 'saas.invoice', title: `Subscription invoice ${invoiceNo}`, body: `${sub.plan_name}: ${amount} for ${periodStart} to ${periodEnd}.`, entityType: 'saas.invoice', entityId: id });
    await this.outbox.emitNow({ type: 'saas_invoice.raised', schoolId, aggregateType: 'saas.invoice', aggregateId: id, payload: { invoiceId: id, invoiceNo, total: amount, periodStart } });
    return { id, invoiceNo, total: amount, periodStart, periodEnd };
  }
  async markPaid(invoiceId: string, p: { paidAt?: string; reference?: string | null } = {}) {
    const inv = await this.db.findOne<Row>('saas_invoices', { id: invoiceId });
    if (!inv) throw notFound('invoice');
    if (inv.status === 'paid') return { id: invoiceId, status: 'paid' as const, alreadyPaid: true };
    await this.db.update('saas_invoices', { status: 'paid', paid_at: p.paidAt ?? nowSql(), payment_ref: p.reference ?? null, updated_at: nowSql() }, { id: invoiceId });
    // paying clears a past-due subscription and extends it to the end of the period paid for
    const sub = await this.db.findOne<Row>('saas_subscriptions', { id: String(inv.subscription_id) });
    if (sub) await this.db.update('saas_subscriptions', { status: 'active', ends_at: String(inv.period_end), updated_at: nowSql() }, { id: String(sub.id) });
    if (sub?.reseller_id) await this.accrueCommission(String(sub.reseller_id), String(inv.period_start), Number(inv.total));
    return { id: invoiceId, status: 'paid' as const };
  }
  async invoices(f: { schoolId?: string; status?: string } = {}) {
    const where: string[] = ['1 = 1']; const params: unknown[] = [];
    if (f.schoolId) { where.push('i.school_id = ?'); params.push(f.schoolId); }
    if (f.status) { where.push('i.status = ?'); params.push(f.status); }
    return this.db.query<Row>(`SELECT i.*, s.name AS school_name FROM saas_invoices i JOIN schools s ON s.id = i.school_id WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT 500`, params);
  }

  // ---------- partners ----------
  async createPartner(p: { name: string; commissionPct?: number; referralCode?: string; contact?: Record<string, unknown> | null }) {
    const code = p.referralCode ?? (p.name.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase() || randomBytes(3).toString('hex').toUpperCase());
    const ex = await this.db.findOne<{ id: string }>('saas_partners', { referral_code: code });
    if (ex) return ex.id;
    const id = ulid();
    await this.db.insert('saas_partners', { id, name: p.name, contact: (p.contact ?? null) as never, commission_pct: p.commissionPct ?? 10, referral_code: code, status: 'active' });
    return id;
  }
  async partners() {
    return this.db.query<Row>(`SELECT p.*, (SELECT COUNT(*) FROM saas_subscriptions s WHERE s.reseller_id = p.id) AS schools FROM saas_partners p ORDER BY p.name`);
  }
  /** Commission is accrued when the school actually pays, not when the invoice is raised. */
  private async accrueCommission(partnerId: string, period: string, invoiceTotal: number) {
    const partner = await this.db.findOne<Row>('saas_partners', { id: partnerId });
    if (!partner || partner.status !== 'active') return null;
    const amount = round((invoiceTotal * Number(partner.commission_pct)) / 100);
    if (amount <= 0) return null;
    const month = `${period.slice(0, 7)}-01`;
    const ex = await this.db.findOne<Row>('saas_partner_payouts', { partner_id: partnerId, period: month, status: 'pending' });
    if (ex) { await this.db.update('saas_partner_payouts', { amount: round(Number(ex.amount) + amount), updated_at: nowSql() }, { id: String(ex.id) }); return String(ex.id); }
    const id = ulid();
    await this.db.insert('saas_partner_payouts', { id, partner_id: partnerId, period: month, amount, status: 'pending', paid_at: null });
    return id;
  }
  async payouts(partnerId?: string) {
    const where = partnerId ? ' WHERE p.partner_id = ?' : '';
    return this.db.query<Row>(`SELECT p.*, pa.name AS partner_name, pa.commission_pct FROM saas_partner_payouts p JOIN saas_partners pa ON pa.id = p.partner_id${where} ORDER BY p.period DESC LIMIT 200`, partnerId ? [partnerId] : []);
  }
  async payPayout(payoutId: string) {
    if (!(await this.db.update('saas_partner_payouts', { status: 'paid', paid_at: nowSql(), updated_at: nowSql() }, { id: payoutId }))) throw notFound('payout');
    return { id: payoutId, status: 'paid' as const };
  }

  // ---------- support ----------
  async openTicket(schoolId: string, t: { subject: string; body: string; priority?: 'low' | 'normal' | 'high' | 'urgent'; openedBy?: string | null }) {
    const id = ulid();
    await this.db.insert('saas_support_tickets', { id, school_id: schoolId, subject: t.subject, body: t.body, priority: t.priority ?? 'normal', status: 'open', opened_by: t.openedBy ?? null, assigned_to: null, closed_at: null });
    return id;
  }
  async tickets(f: { schoolId?: string; status?: string } = {}) {
    const where: string[] = ['1 = 1']; const params: unknown[] = [];
    if (f.schoolId) { where.push('t.school_id = ?'); params.push(f.schoolId); }
    if (f.status) { where.push('t.status = ?'); params.push(f.status); }
    return this.db.query<Row>(`SELECT t.*, s.name AS school_name FROM saas_support_tickets t JOIN schools s ON s.id = t.school_id WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT 300`, params);
  }
  async closeTicket(ticketId: string, resolution?: string) {
    if (!(await this.db.update('saas_support_tickets', { status: 'closed', closed_at: nowSql(), updated_at: nowSql() }, { id: ticketId }))) throw notFound('ticket');
    return { id: ticketId, status: 'closed' as const, resolution: resolution ?? null };
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // renewals, the invoices they need, and the reminders before anything is cut off
      'saas.billing': async ({ schoolId }) => {
        await this.meter(schoolId);
        const sub = await this.subscription(schoolId);
        if (!sub) return { billed: 0 };
        const today = nowSql().slice(0, 10);
        const endsAt = String(sub.ends_at ?? '').slice(0, 10);
        let billed = 0;
        // a fortnight before the end, raise the next invoice so nobody is surprised
        if (sub.auto_renew && endsAt && endsAt <= this.addDays(today, 14) && sub.status !== 'past_due') {
          const r = await this.invoice(schoolId, { periodStart: endsAt });
          if (!('alreadyRaised' in r)) billed++;
        }
        const overdue = await this.db.query<Row>(`SELECT * FROM saas_invoices WHERE school_id = ? AND status = 'issued' AND due_date < ?`, [schoolId, today]);
        for (const inv of overdue) {
          await this.db.update('saas_invoices', { status: 'overdue', updated_at: nowSql() }, { id: String(inv.id) });
          await this.notifications.notifyRole(schoolId, 'admin', { channels: ['email', 'in_app'], eventKey: 'saas.overdue', title: `Invoice ${inv.invoice_no} is overdue`, body: 'New students and messages are paused until it is paid. Everything already in the system stays available.', entityType: 'saas.invoice', entityId: String(inv.id) });
        }
        if (overdue.length && sub.status === 'active') await this.db.update('saas_subscriptions', { status: 'past_due', updated_at: nowSql() }, { id: String(sub.id) });
        return { billed, overdue: overdue.length };
      },
    };
  }

  private addDays(date: string, days: number) { return new Date(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10); }
  private addPeriod(date: string, cycle: 'monthly' | 'yearly') {
    const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
    if (cycle === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1); else d.setUTCFullYear(d.getUTCFullYear() + 1);
    return d.toISOString().slice(0, 10);
  }
}

/** Hashes a client secret or token the same way everywhere: sha256, compared in constant time. */
export const hashToken = (v: string) => createHash('sha256').update(v).digest('hex');
export const tokensMatch = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
