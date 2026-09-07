import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { AccountingService } from './accounting.js';
import { round } from './accounting.js';
import type { FeesService } from './fees.js';
import type { AcademicService } from './academic.js';
import type { DocumentService } from './documents.js';
import { HttpError, badRequest, notFound } from '../context.js';

export type FundKind = 'internal' | 'government_stipend' | 'donor' | 'zakat' | 'alumni';

/**
 * Scholarships and fundraising: where the money to help a child comes from, and where it goes.
 *
 * A fund holds a balance. Money reaches it as a donation — which is income the day it arrives, posted
 * Dr cash, Cr donations — and leaves it as an award, which becomes a fee discount on that student's
 * invoices. The award posts no journal of its own: the discount already reduces the fee income, and
 * posting again would count the same taka twice.
 *
 * The balance is therefore a commitment ledger, and it is what stops a school promising more than it
 * has. Two rules follow from what these funds actually are: a zakat fund may only pay need-based
 * awards, and a fund whose balance would go negative refuses the award rather than quietly overdrawing.
 */
export class GivingService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService,
    private accounting: AccountingService, private fees: FeesService, private academic: AcademicService,
    private documents: DocumentService,
  ) {}

  // ---------- funds ----------
  async createFund(schoolId: string, f: { name: string; kind?: FundKind; rules?: Record<string, unknown> | null; opening?: number }) {
    const ex = await this.db.findOne<{ id: string }>('scholarship_funds', { school_id: schoolId, name: f.name });
    if (ex) return ex.id;
    const id = ulid();
    await this.db.insert('scholarship_funds', { id, school_id: schoolId, name: f.name, kind: f.kind ?? 'internal', balance: round(f.opening ?? 0), gl_account_id: null, rules: (f.rules ?? null) as never, status: 'active' });
    return id;
  }
  async funds(schoolId: string) {
    return this.db.query<Row>(`SELECT f.*, (SELECT COUNT(*) FROM scholarship_awards a WHERE a.fund_id = f.id AND a.status IN ('approved','active')) AS awards FROM scholarship_funds f WHERE f.school_id = ? ORDER BY f.name`, [schoolId]);
  }
  async fund(schoolId: string, fundId: string) {
    const fund = await this.db.findOne<Row>('scholarship_funds', { id: fundId, school_id: schoolId });
    if (!fund) throw notFound('fund');
    const awards = await this.db.query<Row>(`SELECT a.*, s.first_name, s.last_name, s.admission_no FROM scholarship_awards a JOIN students s ON s.id = a.student_id WHERE a.fund_id = ? ORDER BY a.created_at DESC LIMIT 200`, [fundId]);
    const donations = await this.db.query<Row>(`SELECT d.*, o.name AS donor_name FROM donations d JOIN donors o ON o.id = d.donor_id WHERE d.fund_id = ? ORDER BY d.created_at DESC LIMIT 100`, [fundId]);
    return { fund: { ...fund, rules: json(fund.rules) }, awards, donations };
  }

  // ---------- awards ----------
  /**
   * An award is a promise to pay part of a child's fees out of a named fund. It becomes a discount
   * the invoice engine already understands, so nothing downstream has to know about scholarships.
   */
  async award(schoolId: string, a: { fundId: string; studentId: string; amount: number; academicYearId?: string; frequency?: 'monthly' | 'yearly' | 'one_time'; needBased?: boolean; sponsorDonorId?: string | null; approvedBy?: string | null }) {
    const fund = await this.db.findOne<Row>('scholarship_funds', { id: a.fundId, school_id: schoolId });
    if (!fund) throw notFound('fund');
    if (fund.status !== 'active') throw new HttpError(409, 'this fund is closed', 'conflict');
    if (a.amount <= 0) throw badRequest('an award must be positive');
    const student = await this.db.findOne<Row>('students', { id: a.studentId, school_id: schoolId });
    if (!student) throw notFound('student');
    if (fund.kind === 'zakat' && !a.needBased) throw badRequest('a zakat fund may only pay a need-based award');
    const frequency = a.frequency ?? 'yearly';
    const yearId = a.academicYearId ?? String((await this.academic.requireYear(schoolId, null)).id);
    // what the fund is committing over the year, which is what its balance has to cover
    const committed = round(frequency === 'monthly' ? a.amount * 12 : a.amount);
    if (committed > Number(fund.balance)) throw new HttpError(409, `the fund holds ${Number(fund.balance)} and this award commits ${committed}`, 'insufficient_fund');
    if (await this.db.findOne('scholarship_awards', { fund_id: a.fundId, student_id: a.studentId, academic_year_id: yearId })) throw new HttpError(409, 'this student already holds an award from this fund this year', 'duplicate');

    const scheme = await this.fees.createDiscountScheme(schoolId, { name: `Scholarship: ${fund.name}`, kind: a.needBased ? 'need_based' : 'scholarship', valueType: 'flat', value: a.amount });
    const discountId = await this.fees.grantDiscount(schoolId, a.studentId, scheme, yearId, { valueOverride: a.amount, status: a.approvedBy ? 'approved' : 'pending' });
    const id = ulid();
    await this.db.transaction(async tx => {
      await tx.insert('scholarship_awards', { id, school_id: schoolId, fund_id: a.fundId, student_id: a.studentId, academic_year_id: yearId, amount: round(a.amount), frequency, discount_id: discountId, sponsor_donor_id: a.sponsorDonorId ?? null, status: a.approvedBy ? 'active' : 'proposed', approved_by: a.approvedBy ?? null });
      if (a.approvedBy) await tx.update('scholarship_funds', { balance: round(Number(fund.balance) - committed), updated_at: nowSql() }, { id: a.fundId });
    });
    if (a.approvedBy) await this.tellTheFamily(schoolId, a.studentId, String(fund.name), a.amount, frequency);
    await this.outbox.emitNow({ type: 'scholarship.awarded', schoolId, aggregateType: 'giving.award', aggregateId: id, payload: { awardId: id, fundId: a.fundId, studentId: a.studentId, amount: round(a.amount), status: a.approvedBy ? 'active' : 'proposed' } });
    return { id, discountId, committed, status: a.approvedBy ? 'active' : 'proposed' };
  }
  /** Approval is where the money is actually committed, so the fund is checked again here. */
  async decideAward(schoolId: string, awardId: string, decision: 'approved' | 'rejected', approvedBy?: string | null) {
    const award = await this.db.findOne<Row>('scholarship_awards', { id: awardId, school_id: schoolId });
    if (!award) throw notFound('award');
    if (award.status !== 'proposed') throw new HttpError(409, `this award is already ${award.status}`, 'conflict');
    if (award.discount_id) await this.fees.decideDiscount(schoolId, String(award.discount_id), decision, approvedBy);
    if (decision === 'rejected') {
      await this.db.update('scholarship_awards', { status: 'ended', approved_by: approvedBy ?? null, updated_at: nowSql() }, { id: awardId });
      return { id: awardId, status: 'ended' as const };
    }
    const fund = await this.db.findOne<Row>('scholarship_funds', { id: String(award.fund_id) });
    const committed = round(award.frequency === 'monthly' ? Number(award.amount) * 12 : Number(award.amount));
    if (committed > Number(fund?.balance ?? 0)) throw new HttpError(409, `the fund now holds only ${Number(fund?.balance ?? 0)}`, 'insufficient_fund');
    await this.db.transaction(async tx => {
      await tx.update('scholarship_awards', { status: 'active', approved_by: approvedBy ?? null, updated_at: nowSql() }, { id: awardId });
      await tx.update('scholarship_funds', { balance: round(Number(fund!.balance) - committed), updated_at: nowSql() }, { id: String(award.fund_id) });
    });
    await this.tellTheFamily(schoolId, String(award.student_id), String(fund?.name ?? 'the fund'), Number(award.amount), String(award.frequency));
    return { id: awardId, status: 'active' as const, committed };
  }
  /** Ending an award returns what is left of the commitment to the fund, so it can help someone else. */
  async endAward(schoolId: string, awardId: string, reason: string, monthsUsed?: number) {
    // monthsUsed is how many months of the year the student actually had it; the rest goes back
    const award = await this.db.findOne<Row>('scholarship_awards', { id: awardId, school_id: schoolId });
    if (!award) throw notFound('award');
    if (award.status !== 'active') throw new HttpError(409, `this award is ${award.status}`, 'conflict');
    // whatever the frequency, what is returned is the part of the year the child did not get
    const committed = round(award.frequency === 'monthly' ? Number(award.amount) * 12 : Number(award.amount));
    const months = Math.min(12, Math.max(0, monthsUsed ?? 12));
    const returned = round((committed * (12 - months)) / 12);
    await this.db.transaction(async tx => {
      await tx.update('scholarship_awards', { status: 'ended', updated_at: nowSql() }, { id: awardId });
      if (returned > 0) await tx.execute(`UPDATE scholarship_funds SET balance = balance + ?, updated_at = ? WHERE id = ?`, [returned, nowSql(), String(award.fund_id)]);
      if (award.discount_id) await tx.update('student_discounts', { status: 'expired', updated_at: nowSql() }, { id: String(award.discount_id) });
    });
    return { id: awardId, status: 'ended' as const, returnedToFund: returned, reason };
  }
  async awards(schoolId: string, f: { fundId?: string; studentId?: string; status?: string } = {}) {
    const where: string[] = ['a.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.fundId) { where.push('a.fund_id = ?'); params.push(f.fundId); }
    if (f.studentId) { where.push('a.student_id = ?'); params.push(f.studentId); }
    if (f.status) { where.push('a.status = ?'); params.push(f.status); }
    return this.db.query<Row>(`SELECT a.*, s.first_name, s.last_name, s.admission_no, f.name AS fund_name FROM scholarship_awards a JOIN students s ON s.id = a.student_id JOIN scholarship_funds f ON f.id = a.fund_id WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT 300`, params);
  }

  // ---------- donors and campaigns ----------
  async donor(schoolId: string, d: { name: string; kind?: 'individual' | 'organisation' | 'alumni'; phone?: string | null; email?: string | null; alumniId?: string | null; isAnonymous?: boolean }) {
    const ex = d.phone ? await this.db.findOne<{ id: string }>('donors', { school_id: schoolId, phone: d.phone }) : null;
    if (ex) return ex.id;
    const id = ulid();
    await this.db.insert('donors', { id, school_id: schoolId, name: d.name, kind: d.kind ?? 'individual', phone: d.phone ?? null, email: d.email ?? null, address: null, alumni_id: d.alumniId ?? null, total_donated: 0, is_anonymous: !!d.isAnonymous });
    return id;
  }
  async donors(schoolId: string) { return this.db.findMany<Row>('donors', { school_id: schoolId }, { orderBy: 'total_donated DESC', limit: 300 }); }
  async createCampaign(schoolId: string, c: { title: string; goalAmount: number; startsAt?: string | null; endsAt?: string | null; description?: string | null }) {
    const id = ulid();
    const base = c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'appeal';
    let slug = base, n = 1;
    while (await this.db.findOne('fundraising_campaigns', { school_id: schoolId, slug })) slug = `${base}-${++n}`;
    await this.db.insert('fundraising_campaigns', { id, school_id: schoolId, title: c.title, slug, goal_amount: round(c.goalAmount), raised_amount: 0, starts_at: c.startsAt ?? null, ends_at: c.endsAt ?? null, description: c.description ?? null, cover_file_id: null, status: 'draft' });
    return { id, slug };
  }
  async setCampaignStatus(schoolId: string, campaignId: string, status: 'draft' | 'live' | 'closed') {
    if (!(await this.db.update('fundraising_campaigns', { status, updated_at: nowSql() }, { id: campaignId, school_id: schoolId }))) throw notFound('campaign');
    return { id: campaignId, status };
  }
  async campaigns(schoolId: string, liveOnly = false) {
    const where: Row = { school_id: schoolId };
    if (liveOnly) where.status = 'live';
    return this.db.findMany<Row>('fundraising_campaigns', where, { orderBy: 'created_at DESC', limit: 100 });
  }
  /** The public page: the appeal, how far it has come, and who gave — unless they asked not to be named. */
  async publicCampaign(schoolId: string, slug: string) {
    const c = await this.db.findOne<Row>('fundraising_campaigns', { school_id: schoolId, slug, status: 'live' });
    if (!c) throw notFound('campaign');
    const donations = await this.db.query<Row>(`SELECT d.amount, d.message, d.received_at, o.name, o.is_anonymous FROM donations d JOIN donors o ON o.id = d.donor_id WHERE d.campaign_id = ? AND d.kind = 'received' ORDER BY d.received_at DESC LIMIT 50`, [String(c.id)]);
    return {
      title: String(c.title), slug: String(c.slug), description: String(c.description ?? ''),
      goal: round(Number(c.goal_amount)), raised: round(Number(c.raised_amount)),
      percent: Number(c.goal_amount) > 0 ? Math.min(100, round((Number(c.raised_amount) * 100) / Number(c.goal_amount))) : 0,
      donors: donations.length,
      recent: donations.map(d => ({ name: Number(d.is_anonymous) ? 'A well-wisher' : String(d.name), amount: round(Number(d.amount)), message: (d.message as string) ?? null, at: String(d.received_at ?? '').slice(0, 10) })),
    };
  }

  // ---------- donations ----------
  /**
   * A pledge is a promise and posts nothing; money received is income the day it arrives and gets a
   * receipt with a verification code, because a donor who cannot prove they gave stops giving.
   */
  async donate(schoolId: string, d: { donorId: string; amount: number; campaignId?: string | null; fundId?: string | null; kind?: 'pledge' | 'received'; method?: string | null; reference?: string | null; message?: string | null; receivedAt?: string }) {
    if (d.amount <= 0) throw badRequest('a donation must be positive');
    const donor = await this.db.findOne<Row>('donors', { id: d.donorId, school_id: schoolId });
    if (!donor) throw notFound('donor');
    const kind = d.kind ?? 'received';
    const id = ulid();
    const amount = round(d.amount);
    let journalEntryId: string | null = null;
    if (kind === 'received') {
      const cashCode = ['bkash', 'nagad', 'rocket', 'upay'].includes(String(d.method)) ? '1220' : d.method === 'cash' ? '1100' : '1210';
      journalEntryId = (await this.accounting.post(schoolId, {
        entryDate: (d.receivedAt ?? nowSql()).slice(0, 10), memo: `Donation from ${donor.name}`, sourceType: 'giving.donation', sourceId: id,
        lines: [{ accountCode: cashCode, debit: amount, description: 'Donation received' }, { accountCode: '4300', credit: amount, description: String(donor.name) }],
      })).id;
    }
    await this.db.transaction(async tx => {
      await tx.insert('donations', { id, school_id: schoolId, donor_id: d.donorId, campaign_id: d.campaignId ?? null, fund_id: d.fundId ?? null, amount, kind, method: d.method ?? null, reference: d.reference ?? null, received_at: kind === 'received' ? (d.receivedAt ?? nowSql()) : null, receipt_doc_id: null, journal_entry_id: journalEntryId, message: d.message ?? null });
      if (kind === 'received') {
        await tx.execute(`UPDATE donors SET total_donated = total_donated + ?, updated_at = ? WHERE id = ?`, [amount, nowSql(), d.donorId]);
        if (d.campaignId) await tx.execute(`UPDATE fundraising_campaigns SET raised_amount = raised_amount + ?, updated_at = ? WHERE id = ?`, [amount, nowSql(), d.campaignId]);
        if (d.fundId) await tx.execute(`UPDATE scholarship_funds SET balance = balance + ?, updated_at = ? WHERE id = ?`, [amount, nowSql(), d.fundId]);
      }
    });
    await this.outbox.emitNow({ type: 'donation.received', schoolId, aggregateType: 'giving.donation', aggregateId: id, payload: { donationId: id, donorId: d.donorId, amount, kind, campaignId: d.campaignId ?? '' } });
    if (kind === 'received') await this.issueReceipt(schoolId, id);
    return { id, amount, kind, journalEntryId };
  }
  /** A pledge that turns into money runs the same path as a donation, so there is one way in. */
  async receivePledge(schoolId: string, donationId: string, opts: { method?: string | null; reference?: string | null; receivedAt?: string } = {}) {
    const p = await this.db.findOne<Row>('donations', { id: donationId, school_id: schoolId });
    if (!p) throw notFound('donation');
    if (p.kind !== 'pledge') throw new HttpError(409, 'that donation is already received', 'conflict');
    await this.db.delete('donations', { id: donationId });
    return this.donate(schoolId, { donorId: String(p.donor_id), amount: Number(p.amount), campaignId: (p.campaign_id as string) ?? null, fundId: (p.fund_id as string) ?? null, kind: 'received', method: opts.method ?? (p.method as string) ?? null, reference: opts.reference ?? (p.reference as string) ?? null, message: (p.message as string) ?? null, receivedAt: opts.receivedAt });
  }
  async issueReceipt(schoolId: string, donationId: string) {
    const d = await this.db.findOne<Row>('donations', { id: donationId, school_id: schoolId });
    if (!d) throw notFound('donation');
    if (d.receipt_doc_id) return { donationId, documentId: String(d.receipt_doc_id), alreadyIssued: true };
    if (d.kind !== 'received') throw new HttpError(409, 'a pledge has no receipt until it is paid', 'conflict');
    const donor = await this.db.findOne<Row>('donors', { id: String(d.donor_id) });
    const campaign = d.campaign_id ? await this.db.findOne<Row>('fundraising_campaigns', { id: String(d.campaign_id) }) : null;
    const fund = d.fund_id ? await this.db.findOne<Row>('scholarship_funds', { id: String(d.fund_id) }) : null;
    const issued = await this.documents.issue(schoolId, {
      docType: 'donation_receipt', personType: 'other',
      data: {
        name: String(donor?.name ?? ''), amount: String(round(Number(d.amount))), method: String(d.method ?? ''),
        received_on: String(d.received_at ?? '').slice(0, 10), towards: String(campaign?.title ?? fund?.name ?? 'the general fund'),
        reference: String(d.reference ?? ''),
      },
      entityType: 'giving.donation', entityId: donationId,
    });
    await this.db.update('donations', { receipt_doc_id: issued.id, updated_at: nowSql() }, { id: donationId });
    if (donor?.phone) await this.notifications.notify({ schoolId, address: String(donor.phone), channels: ['sms'], eventKey: 'giving.thank_you', data: { amount: round(Number(d.amount)) }, title: 'Thank you', body: `Your gift of Tk ${round(Number(d.amount))} has been received. Receipt ${issued.documentNo}, verification code ${issued.verificationCode}.`, entityType: 'giving.donation', entityId: donationId });
    return { donationId, documentId: issued.id, fileId: issued.fileId, documentNo: issued.documentNo };
  }
  async donations(schoolId: string, f: { campaignId?: string; donorId?: string; kind?: 'pledge' | 'received' } = {}) {
    const where: string[] = ['d.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.campaignId) { where.push('d.campaign_id = ?'); params.push(f.campaignId); }
    if (f.donorId) { where.push('d.donor_id = ?'); params.push(f.donorId); }
    if (f.kind) { where.push('d.kind = ?'); params.push(f.kind); }
    return this.db.query<Row>(`SELECT d.*, o.name AS donor_name, c.title AS campaign_title FROM donations d JOIN donors o ON o.id = d.donor_id LEFT JOIN fundraising_campaigns c ON c.id = d.campaign_id WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 300`, params);
  }

  private async tellTheFamily(schoolId: string, studentId: string, fundName: string, amount: number, frequency: string) {
    const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [studentId]);
    for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['sms', 'push', 'in_app'], eventKey: 'giving.scholarship_awarded', data: { fund: fundName, amount }, title: 'A scholarship has been granted', body: `Tk ${amount} ${frequency === 'monthly' ? 'a month' : frequency === 'yearly' ? 'a year' : 'once'} from ${fundName} will come off the fees. Nothing needs to be paid for it.`, entityType: 'people.student', entityId: studentId });
  }
}
