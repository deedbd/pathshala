import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters, JobContext, ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { NumberingService } from './numbering.js';
import type { AcademicService } from './academic.js';
import type { PeopleService } from './people.js';
import type { FeesService } from './fees.js';
import type { DocumentService } from './documents.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface CampaignInput {
  academicYearId?: string | null; name: string; opensAt: string; closesAt: string; formFee?: number; admissionFeeHeadId?: string | null;
  selectionMode?: 'test' | 'lottery' | 'first_come' | 'interview' | 'mixed'; requiresTest?: boolean; autoMeritList?: boolean; autoOffer?: boolean;
  offerValidityDays?: number; siblingPriority?: boolean; slug?: string; classes?: { classId: string; seats: number; minAgeYears?: number | null; maxAgeYears?: number | null }[];
}
export interface ApplicationInput {
  classId: string; shiftId?: string | null; firstName: string; lastName?: string | null; gender: 'male' | 'female' | 'other'; dateOfBirth: string;
  guardianName: string; guardianPhone: string; guardianEmail?: string | null; guardianRelation?: string | null;
  address?: unknown; previousSchool?: unknown; extraFields?: Record<string, unknown> | null; photoFileId?: string | null; enquiryId?: string | null;
}

/**
 * Admissions: campaign → enquiry → public application (with its form fee) → entrance test → merit
 * list → offer with an expiry → enrolment. Money is the trigger throughout: paying the form fee
 * submits the application, and paying the admission fee turns the applicant into a student with
 * guardians, an account and a section. An expired unpaid offer is revoked and the next waitlisted
 * applicant is promoted in its place.
 */
export class AdmissionsService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService, private numbering: NumberingService,
    private academic: AcademicService, private people: PeopleService, private fees: FeesService, private documents: DocumentService, private adapters: Adapters,
  ) {}

  // ---------- campaigns ----------
  async campaigns(schoolId: string) { return this.db.findMany<Row>('admission_campaigns', { school_id: schoolId }, { orderBy: 'opens_at DESC', limit: 50 }); }
  async campaign(schoolId: string, id: string): Promise<Row & { classes: Row[] }> {
    const c = await this.db.findOne<Row>('admission_campaigns', { id, school_id: schoolId });
    if (!c) throw notFound('campaign');
    const classes = await this.db.query<Row>(`SELECT cc.*, c.name AS class_name, c.numeric_level, (SELECT COUNT(*) FROM admission_applications a WHERE a.campaign_id = cc.campaign_id AND a.class_id = cc.class_id AND a.status NOT IN ('draft','rejected','withdrawn')) AS applicants FROM admission_campaign_classes cc JOIN classes c ON c.id = cc.class_id WHERE cc.campaign_id = ? ORDER BY c.numeric_level`, [id]);
    return { ...c, classes } as Row & { classes: Row[] };
  }
  async createCampaign(schoolId: string, c: CampaignInput) {
    const year = await this.academic.requireYear(schoolId, c.academicYearId);
    const id = ulid();
    const slug = (c.slug ?? c.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || `admission-${id.slice(-6).toLowerCase()}`;
    if (await this.db.findOne('admission_campaigns', { public_form_slug: slug })) throw new HttpError(409, `the address /admission/${slug} is taken`, 'conflict');
    await this.db.transaction(async tx => {
      await tx.insert('admission_campaigns', {
        id, school_id: schoolId, academic_year_id: String(year.id), name: c.name, opens_at: c.opensAt, closes_at: c.closesAt, form_fee: c.formFee ?? 0,
        admission_fee_head_id: c.admissionFeeHeadId ?? (await tx.findOne<{ id: string }>('fee_heads', { school_id: schoolId, code: 'ADMISSION' }))?.id ?? null,
        selection_mode: c.selectionMode ?? 'test', requires_test: c.requiresTest ?? (c.selectionMode ?? 'test') === 'test', auto_merit_list: c.autoMeritList ?? true, auto_offer: c.autoOffer ?? true,
        offer_validity_days: c.offerValidityDays ?? 7, sibling_priority: c.siblingPriority ?? true, status: 'draft', public_form_slug: slug, form_schema: null,
      });
      for (const k of c.classes ?? []) await tx.insert('admission_campaign_classes', { id: ulid(), school_id: schoolId, campaign_id: id, class_id: k.classId, seats: k.seats, min_age_years: k.minAgeYears ?? null, max_age_years: k.maxAgeYears ?? null, test_id: null });
    });
    return { id, slug };
  }
  async setCampaignStatus(schoolId: string, id: string, status: 'draft' | 'open' | 'closed' | 'archived') {
    const n = await this.db.update('admission_campaigns', { status, updated_at: nowSql() }, { id, school_id: schoolId });
    if (n && status === 'open') await this.outbox.emitNow({ type: 'campaign.opened', schoolId, aggregateType: 'admissions.campaign', aggregateId: id, payload: { campaignId: id } });
    return n;
  }

  // ---------- enquiries (CRM) ----------
  async enquiries(schoolId: string, f: { status?: string; assignedTo?: string; campaignId?: string } = {}) {
    const where: Row = { school_id: schoolId };
    if (f.status) where.status = f.status;
    if (f.assignedTo) where.assigned_to = f.assignedTo;
    if (f.campaignId) where.campaign_id = f.campaignId;
    return this.db.findMany<Row>('admission_enquiries', where, { orderBy: 'created_at DESC', limit: 300 });
  }
  /** A1: the next counsellor in the rota, an acknowledgement, and a follow-up 48 hours out. */
  async assignCounsellor(schoolId: string, enquiryId: string) {
    const e = await this.db.findOne<Row>('admission_enquiries', { id: enquiryId, school_id: schoolId });
    if (!e) throw notFound('enquiry');
    if (e.assigned_to) return String(e.assigned_to);
    const counsellors = await this.db.query<Row>(`SELECT s.id, (SELECT COUNT(*) FROM admission_enquiries q WHERE q.assigned_to = s.id AND q.status IN ('new','contacted','visited')) AS open_leads FROM staff s WHERE s.school_id = ? AND s.status IN ('active','probation') AND s.staff_category IN ('admin','non_teaching') ORDER BY open_leads ASC, s.id ASC LIMIT 1`, [schoolId]);
    const staffId = counsellors[0] ? String(counsellors[0].id) : null;
    await this.db.update('admission_enquiries', { assigned_to: staffId, updated_at: nowSql() }, { id: enquiryId });
    return staffId;
  }
  async addFollowup(schoolId: string, enquiryId: string, f: { note: string; channel?: 'call' | 'visit' | 'sms' | 'email' | 'whatsapp'; nextAt?: string | null; status?: 'new' | 'contacted' | 'visited' | 'converted' | 'lost'; lostReason?: string | null; byUserId?: string | null }) {
    if (!(await this.db.findOne('admission_enquiries', { id: enquiryId, school_id: schoolId }))) throw notFound('enquiry');
    const id = ulid();
    await this.db.insert('enquiry_followups', { id, school_id: schoolId, enquiry_id: enquiryId, note: f.note, channel: f.channel ?? 'call', by_user_id: f.byUserId ?? null, next_at: f.nextAt ?? null, created_at: nowSql() });
    const set: Row = { next_follow_up_at: f.nextAt ?? null, updated_at: nowSql() };
    if (f.status) { set.status = f.status; if (f.status === 'lost') set.lost_reason = f.lostReason ?? null; }
    await this.db.update('admission_enquiries', set, { id: enquiryId });
    return id;
  }
  async followups(schoolId: string, enquiryId: string) { return this.db.findMany<Row>('enquiry_followups', { school_id: schoolId, enquiry_id: enquiryId }, { orderBy: 'created_at DESC', limit: 100 }); }

  // ---------- the public form ----------
  async publicForm(slug: string) {
    const c = await this.db.findOne<Row>('admission_campaigns', { public_form_slug: slug });
    if (!c || c.status !== 'open') throw new HttpError(404, 'no admission is open at this address', 'not_found');
    const now = nowSql();
    if (String(c.opens_at) > now || String(c.closes_at) < now) throw new HttpError(409, 'this admission is not accepting applications right now', 'closed');
    const classes = await this.db.query<Row>(`SELECT cc.class_id, cc.seats, cc.min_age_years, cc.max_age_years, c.name AS class_name FROM admission_campaign_classes cc JOIN classes c ON c.id = cc.class_id WHERE cc.campaign_id = ? ORDER BY c.numeric_level`, [String(c.id)]);
    return { campaign: { id: String(c.id), schoolId: String(c.school_id), name: String(c.name), formFee: Number(c.form_fee), closesAt: String(c.closes_at), requiresTest: !!Number(c.requires_test), fields: json(c.form_schema) }, classes };
  }
  /**
   * A3: an application arrives from the website. With a form fee it waits at `draft` until the fee is
   * paid; without one it is submitted immediately. The guardian's phone finds an existing sibling.
   */
  async apply(schoolId: string, campaignId: string, a: ApplicationInput) {
    const c = await this.db.findOne<Row>('admission_campaigns', { id: campaignId, school_id: schoolId });
    if (!c) throw notFound('campaign');
    if (c.status !== 'open') throw new HttpError(409, 'this admission is closed', 'closed');
    const seat = await this.db.findOne<Row>('admission_campaign_classes', { campaign_id: campaignId, class_id: a.classId });
    if (!seat) throw badRequest('that class is not part of this admission');
    const age = years(a.dateOfBirth, String(c.opens_at).slice(0, 10));
    if (seat.min_age_years != null && age < Number(seat.min_age_years)) throw badRequest(`the child must be at least ${seat.min_age_years} years old for this class`);
    if (seat.max_age_years != null && age > Number(seat.max_age_years)) throw badRequest(`the child must be under ${seat.max_age_years} years old for this class`);
    const phone = a.guardianPhone.trim();
    if (await this.db.findOne('admission_applications', { campaign_id: campaignId, guardian_phone: phone, first_name: a.firstName.trim(), date_of_birth: a.dateOfBirth })) throw new HttpError(409, 'this child has already applied in this admission', 'duplicate');
    const sibling = await this.db.query<{ student_id: string }>(`SELECT sg.student_id FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id JOIN students s ON s.id = sg.student_id WHERE g.school_id = ? AND g.phone = ? AND s.status = 'active' LIMIT 1`, [schoolId, phone]);
    const id = ulid();
    const formFee = Number(c.form_fee);
    await this.db.transaction(async tx => {
      const applicationNo = await this.numbering.next(schoolId, 'application_no', { prefix: 'APP-', padding: 5, resetYearly: true }, tx);
      await tx.insert('admission_applications', {
        id, school_id: schoolId, campaign_id: campaignId, enquiry_id: a.enquiryId ?? null, application_no: applicationNo, class_id: a.classId, shift_id: a.shiftId ?? null,
        first_name: a.firstName.trim(), last_name: a.lastName?.trim() || null, gender: a.gender, date_of_birth: a.dateOfBirth, photo_file_id: a.photoFileId ?? null,
        guardian_name: a.guardianName.trim(), guardian_phone: phone, guardian_email: a.guardianEmail?.toLowerCase() ?? null, guardian_relation: a.guardianRelation ?? 'father',
        address: (a.address ?? null) as never, previous_school: (a.previousSchool ?? null) as never, extra_fields: (a.extraFields ?? null) as never,
        sibling_student_id: sibling[0]?.student_id ?? null, status: formFee > 0 ? 'draft' : 'submitted', form_fee_invoice_id: null, test_score: null, merit_rank: null, lottery_no: null, waitlist_position: null,
        student_id: null, submitted_at: formFee > 0 ? null : nowSql(), decided_at: null, decided_by: null, rejection_reason: null,
      });
      if (a.enquiryId) await tx.update('admission_enquiries', { status: 'converted', updated_at: nowSql() }, { id: a.enquiryId });
    });
    let invoiceId: string | null = null;
    if (formFee > 0) {
      const head = await this.db.findOne<{ id: string }>('fee_heads', { school_id: schoolId, code: 'FORM' });
      const inv = await this.fees.createInvoice(schoolId, { applicationId: id, items: [{ feeHeadId: head?.id ?? null, description: `Admission form fee — ${c.name}`, amount: formFee }], notes: `application:${id}` });
      invoiceId = inv.id;
      await this.db.update('admission_applications', { form_fee_invoice_id: invoiceId, updated_at: nowSql() }, { id });
    }
    const application = await this.db.findOne<Row>('admission_applications', { id });
    await this.outbox.emitNow({ type: 'application.submitted', schoolId, aggregateType: 'admissions.application', aggregateId: id, payload: { applicationId: id, applicationNo: String(application!.application_no), campaignId, classId: a.classId, formFee, invoiceId } });
    await this.notifications.notify({ schoolId, address: phone, channels: ['sms'], eventKey: 'admissions.application_received', data: { name: a.firstName, no: String(application!.application_no) }, title: 'Application received', body: formFee > 0 ? `Application ${application!.application_no} received. Pay the form fee of ${formFee} to complete it.` : `Application ${application!.application_no} received. We will contact you.`, entityType: 'admissions.application', entityId: id });
    return { id, applicationNo: String(application!.application_no), invoiceId, status: String(application!.status) };
  }

  /** A4 and A8: money decides. The form fee submits the application; the admission fee enrols. */
  async onPaymentReceived(schoolId: string, invoiceId: string) {
    const app = await this.db.findOne<Row>('admission_applications', { school_id: schoolId, form_fee_invoice_id: invoiceId });
    if (app) {
      if (String(app.status) === 'draft') {
        await this.db.update('admission_applications', { status: 'submitted', submitted_at: nowSql(), updated_at: nowSql() }, { id: String(app.id) });
        const campaign = await this.db.findOne<Row>('admission_campaigns', { id: String(app.campaign_id) });
        if (Number(campaign?.requires_test)) await this.allocateTestSeat(schoolId, String(app.id));
        await this.notifications.notify({ schoolId, address: String(app.guardian_phone), channels: ['sms'], eventKey: 'admissions.application_submitted', data: { no: String(app.application_no) }, title: 'Application complete', body: `Form fee received. Application ${app.application_no} is now complete.`, entityType: 'admissions.application', entityId: String(app.id) });
      }
      return { applicationId: String(app.id), stage: 'form_fee' as const };
    }
    const offer = await this.db.findOne<Row>('admission_offers', { school_id: schoolId, admission_fee_invoice_id: invoiceId });
    if (offer) return { applicationId: String(offer.application_id), stage: 'admission_fee' as const, ...(await this.enrol(schoolId, String(offer.application_id))) };
    return null;
  }

  // ---------- tests ----------
  async createTest(schoolId: string, t: { campaignId: string; classId: string; name: string; heldAt: string; durationMin?: number; venue?: string | null; totalMarks?: number; passMarks?: number | null; components?: Record<string, number> | null }) {
    const id = ulid();
    await this.db.insert('admission_tests', { id, school_id: schoolId, campaign_id: t.campaignId, class_id: t.classId, name: t.name, held_at: t.heldAt, duration_min: t.durationMin ?? 60, venue: t.venue ?? null, total_marks: t.totalMarks ?? 100, pass_marks: t.passMarks ?? null, components: (t.components ?? null) as never, online_exam_id: null });
    await this.db.update('admission_campaign_classes', { test_id: id }, { campaign_id: t.campaignId, class_id: t.classId });
    return id;
  }
  async tests(schoolId: string, campaignId?: string) {
    const where: Row = { school_id: schoolId };
    if (campaignId) where.campaign_id = campaignId;
    return this.db.findMany<Row>('admission_tests', where, { orderBy: 'held_at ASC', limit: 100 });
  }
  /** The applicant is told when and where to sit, and gets an admit card to bring. */
  async allocateTestSeat(schoolId: string, applicationId: string) {
    const app = await this.db.findOne<Row>('admission_applications', { id: applicationId, school_id: schoolId });
    if (!app) throw notFound('application');
    const test = await this.db.findOne<Row>('admission_tests', { campaign_id: String(app.campaign_id), class_id: String(app.class_id) });
    if (!test) return null;
    await this.db.update('admission_applications', { status: 'test_scheduled', updated_at: nowSql() }, { id: applicationId });
    const issued = await this.documents.issue(schoolId, {
      docType: 'admit_card', personType: 'other', data: { name: `${app.first_name} ${app.last_name ?? ''}`.trim(), application_no: String(app.application_no), test: String(test.name), held_at: String(test.held_at), venue: String(test.venue ?? 'School campus'), guardian: String(app.guardian_name) },
      entityType: 'admissions.application', entityId: applicationId,
    });
    await this.notifications.notify({ schoolId, address: String(app.guardian_phone), channels: ['sms'], eventKey: 'admissions.test_scheduled', data: { no: String(app.application_no), at: String(test.held_at) }, title: 'Admission test', body: `${app.first_name}: admission test on ${String(test.held_at).slice(0, 16)} at ${test.venue ?? 'the school'}. Admit card is in the link.`, entityType: 'admissions.application', entityId: applicationId });
    return { testId: String(test.id), admitCardFileId: issued.fileId };
  }
  async enterResults(schoolId: string, testId: string, rows: { applicationId: string; totalMarks?: number | null; componentMarks?: Record<string, number> | null; isAbsent?: boolean; remarks?: string | null }[], enteredBy?: string | null) {
    const test = await this.db.findOne<Row>('admission_tests', { id: testId, school_id: schoolId });
    if (!test) throw notFound('test');
    let saved = 0;
    for (const r of rows) {
      const total = r.isAbsent ? 0 : Number(r.totalMarks ?? (r.componentMarks ? Object.values(r.componentMarks).reduce((a, b) => a + Number(b), 0) : 0));
      if (total > Number(test.total_marks)) throw badRequest(`${total} is more than the test's ${test.total_marks} marks`);
      const ex = await this.db.findOne<Row>('admission_test_results', { test_id: testId, application_id: r.applicationId });
      const row = { school_id: schoolId, test_id: testId, application_id: r.applicationId, component_marks: (r.componentMarks ?? null) as never, total_marks: total, is_absent: !!r.isAbsent, remarks: r.remarks ?? null, entered_by: enteredBy ?? null, entered_at: nowSql() };
      if (ex) await this.db.update('admission_test_results', row, { id: String(ex.id) });
      else await this.db.insert('admission_test_results', { id: ulid(), ...row });
      await this.db.update('admission_applications', { test_score: total, status: 'tested', updated_at: nowSql() }, { id: r.applicationId, school_id: schoolId });
      saved++;
    }
    await this.outbox.emitNow({ type: 'test.results_entered', schoolId, aggregateType: 'admissions.test', aggregateId: testId, payload: { testId, campaignId: String(test.campaign_id), classId: String(test.class_id), results: saved } });
    return { saved };
  }

  // ---------- merit list ----------
  /**
   * A5: ranks the applicants of one class and fills the seats. Test and interview modes sort by score,
   * lottery draws a number, first-come uses the submission time. A sibling already in the school wins a
   * tie, then the older child. Everyone beyond the seats is waitlisted in the same order.
   */
  /** A5's condition: nobody in this class is still waiting for a mark. */
  async readyForMerit(schoolId: string, campaignId: string, classId: string) {
    const pending = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM admission_applications a WHERE a.school_id = ? AND a.campaign_id = ? AND a.class_id = ? AND a.status IN ('submitted','screening','test_scheduled') AND a.test_score IS NULL`, [schoolId, campaignId, classId]);
    return Number(pending[0]?.n ?? 0) === 0;
  }
  async computeMerit(schoolId: string, campaignId: string, classId: string) {
    const c = await this.db.findOne<Row>('admission_campaigns', { id: campaignId, school_id: schoolId });
    if (!c) throw notFound('campaign');
    const seatRow = await this.db.findOne<Row>('admission_campaign_classes', { campaign_id: campaignId, class_id: classId });
    if (!seatRow) throw badRequest('that class is not part of this admission');
    // seats already held by an offer or an enrolment are not up for grabs again, and those applicants
    // keep the rank they were given: recomputing must never unseat somebody who has been told they are in
    const taken = Number((await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM admission_applications WHERE school_id = ? AND campaign_id = ? AND class_id = ? AND status IN ('offered','accepted','enrolled')`, [schoolId, campaignId, classId]))[0]?.n ?? 0);
    const seats = Math.max(0, Number(seatRow.seats) - taken);
    const apps = await this.db.query<Row>(`SELECT * FROM admission_applications WHERE school_id = ? AND campaign_id = ? AND class_id = ? AND status IN ('submitted','screening','test_scheduled','tested','shortlisted','waitlisted') ORDER BY id`, [schoolId, campaignId, classId]);
    if (!apps.length) return { ranked: 0, shortlisted: 0, waitlisted: 0 };
    const mode = String(c.selection_mode);
    const siblingFirst = !!Number(c.sibling_priority);
    const lottery = new Map<string, number>();
    if (mode === 'lottery') {
      // a draw that can be repeated and checked: hash the application id with the campaign id
      for (const a of apps) lottery.set(String(a.id), hash(`${campaignId}:${a.id}`));
    }
    const sorted = [...apps].sort((x, y) => {
      if (siblingFirst && !!x.sibling_student_id !== !!y.sibling_student_id) return x.sibling_student_id ? -1 : 1;
      if (mode === 'lottery') return (lottery.get(String(x.id)) ?? 0) - (lottery.get(String(y.id)) ?? 0);
      if (mode === 'first_come') return String(x.submitted_at ?? '') < String(y.submitted_at ?? '') ? -1 : 1;
      const sx = Number(x.test_score ?? -1), sy = Number(y.test_score ?? -1);
      if (sx !== sy) return sy - sx;                                   // higher score first
      return String(x.date_of_birth) < String(y.date_of_birth) ? -1 : 1;  // then the older child
    });
    let shortlisted = 0, waitlisted = 0;
    await this.db.transaction(async tx => {
      for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i]!;
        const inSeat = i < seats;
        await tx.update('admission_applications', {
          merit_rank: taken + i + 1, lottery_no: mode === 'lottery' ? String(lottery.get(String(a.id))).padStart(6, '0') : null,
          status: inSeat ? 'shortlisted' : 'waitlisted', waitlist_position: inSeat ? null : i - seats + 1, updated_at: nowSql(),
        }, { id: String(a.id) });
        if (inSeat) shortlisted++; else waitlisted++;
      }
    });
    await this.outbox.emitNow({ type: 'merit_list.generated', schoolId, aggregateType: 'admissions.campaign', aggregateId: campaignId, payload: { campaignId, classId, ranked: sorted.length, shortlisted, waitlisted } });
    if (Number(c.auto_offer)) await this.makeOffers(schoolId, campaignId, classId);
    return { ranked: sorted.length, shortlisted, waitlisted };
  }
  async meritList(schoolId: string, campaignId: string, classId?: string) {
    const where = classId ? ' AND class_id = ?' : '';
    const params = classId ? [schoolId, campaignId, classId] : [schoolId, campaignId];
    return this.db.query<Row>(`SELECT * FROM admission_applications WHERE school_id = ? AND campaign_id = ?${where} AND merit_rank IS NOT NULL ORDER BY class_id, merit_rank LIMIT 2000`, params);
  }

  // ---------- offers ----------
  /** A6: every shortlisted applicant gets an offer, an admission-fee invoice and an offer letter. */
  async makeOffers(schoolId: string, campaignId: string, classId?: string) {
    const c = await this.db.findOne<Row>('admission_campaigns', { id: campaignId, school_id: schoolId });
    if (!c) throw notFound('campaign');
    const apps = await this.db.query<Row>(`SELECT * FROM admission_applications WHERE school_id = ? AND campaign_id = ? AND status = 'shortlisted'${classId ? ' AND class_id = ?' : ''} ORDER BY class_id, merit_rank`, classId ? [schoolId, campaignId, classId] : [schoolId, campaignId]);
    let made = 0;
    const seatsLeft = new Map<string, number>();
    for (const a of apps) {
      const cls = String(a.class_id);
      if (!seatsLeft.has(cls)) seatsLeft.set(cls, await this.freeSeats(schoolId, campaignId, cls));
      // an offer is a seat held: never promise more places than the class has
      if ((seatsLeft.get(cls) ?? 0) <= 0) continue;
      if (await this.offerTo(schoolId, c, a)) { made++; seatsLeft.set(cls, (seatsLeft.get(cls) ?? 0) - 1); }
    }
    return { offers: made };
  }
  /** Seats not already held by a live offer or an enrolled student. */
  async freeSeats(schoolId: string, campaignId: string, classId: string) {
    const seat = await this.db.findOne<Row>('admission_campaign_classes', { campaign_id: campaignId, class_id: classId });
    if (!seat) return 0;
    const held = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM admission_offers o JOIN admission_applications a ON a.id = o.application_id WHERE a.campaign_id = ? AND a.class_id = ? AND o.revoked_at IS NULL AND o.declined_at IS NULL`, [campaignId, classId]);
    return Math.max(0, Number(seat.seats) - Number(held[0]?.n ?? 0));
  }
  private async offerTo(schoolId: string, c: Row, a: Row) {
    if (await this.db.findOne('admission_offers', { application_id: String(a.id) })) return false;
    const expires = nowSql(new Date(Date.now() + Number(c.offer_validity_days ?? 7) * 86_400_000));
    const amount = await this.admissionFeeFor(schoolId, String(a.class_id), String(c.academic_year_id));
    const inv = amount > 0 ? await this.fees.createInvoice(schoolId, { applicationId: String(a.id), items: [{ feeHeadId: (c.admission_fee_head_id as string) ?? null, description: `Admission fee — ${c.name}`, amount }], notes: `application:${a.id}` }) : null;
    const letter = await this.documents.issue(schoolId, {
      docType: 'offer_letter', personType: 'other',
      data: { name: `${a.first_name} ${a.last_name ?? ''}`.trim(), application_no: String(a.application_no), campaign: String(c.name), expires_at: expires, amount: String(amount), guardian: String(a.guardian_name) },
      entityType: 'admissions.application', entityId: String(a.id),
    });
    const id = ulid();
    await this.db.insert('admission_offers', { id, school_id: schoolId, application_id: String(a.id), offered_at: nowSql(), expires_at: expires, admission_fee_invoice_id: inv?.id ?? null, offer_letter_file_id: letter.fileId, accepted_at: null, declined_at: null, revoked_at: null, revoke_reason: null });
    await this.db.update('admission_applications', { status: 'offered', updated_at: nowSql() }, { id: String(a.id) });
    await this.notifications.notify({ schoolId, address: String(a.guardian_phone), channels: ['sms', 'email'], eventKey: 'admissions.offer_made', data: { name: String(a.first_name), amount, expires: expires.slice(0, 10) }, title: 'Admission offer', body: `${a.first_name} has been offered a place. Pay the admission fee of ${amount} by ${expires.slice(0, 10)} to confirm.`, entityType: 'admissions.offer', entityId: id });
    await this.outbox.emitNow({ type: 'offer.made', schoolId, aggregateType: 'admissions.offer', aggregateId: id, payload: { offerId: id, applicationId: String(a.id), amount, expiresAt: expires } });
    return true;
  }
  private async admissionFeeFor(schoolId: string, classId: string, yearId: string) {
    const rows = await this.db.query<{ amount: number }>(`SELECT i.amount FROM fee_structure_items i JOIN fee_structures s ON s.id = i.fee_structure_id JOIN fee_heads h ON h.id = i.fee_head_id WHERE s.school_id = ? AND s.class_id = ? AND s.academic_year_id = ? AND h.code = 'ADMISSION' LIMIT 1`, [schoolId, classId, yearId]);
    return Number(rows[0]?.amount ?? 0);
  }
  async offers(schoolId: string, campaignId: string) {
    return this.db.query<Row>(`SELECT o.*, a.first_name, a.last_name, a.application_no, a.class_id, a.guardian_phone FROM admission_offers o JOIN admission_applications a ON a.id = o.application_id WHERE o.school_id = ? AND a.campaign_id = ? ORDER BY o.offered_at DESC LIMIT 1000`, [schoolId, campaignId]);
  }
  async declineOffer(schoolId: string, offerId: string, reason?: string) {
    const o = await this.db.findOne<Row>('admission_offers', { id: offerId, school_id: schoolId });
    if (!o) throw notFound('offer');
    await this.db.update('admission_offers', { declined_at: nowSql(), revoke_reason: reason?.slice(0, 120) ?? null, updated_at: nowSql() }, { id: offerId });
    await this.db.update('admission_applications', { status: 'withdrawn', decided_at: nowSql(), updated_at: nowSql() }, { id: String(o.application_id) });
    return this.promoteWaitlist(schoolId, String(o.application_id));
  }
  /** A7: the seat freed by an expired or declined offer goes to the next applicant on the waitlist. */
  async promoteWaitlist(schoolId: string, freedApplicationId: string) {
    const freed = await this.db.findOne<Row>('admission_applications', { id: freedApplicationId });
    if (!freed) return null;
    const next = await this.db.query<Row>(`SELECT * FROM admission_applications WHERE school_id = ? AND campaign_id = ? AND class_id = ? AND status = 'waitlisted' ORDER BY waitlist_position ASC, merit_rank ASC LIMIT 1`, [schoolId, String(freed.campaign_id), String(freed.class_id)]);
    if (!next[0]) return null;
    const c = await this.db.findOne<Row>('admission_campaigns', { id: String(freed.campaign_id) });
    await this.db.update('admission_applications', { status: 'shortlisted', waitlist_position: null, updated_at: nowSql() }, { id: String(next[0].id) });
    await this.offerTo(schoolId, c!, { ...next[0], status: 'shortlisted' });
    await this.notifications.notify({ schoolId, address: String(next[0].guardian_phone), channels: ['sms'], eventKey: 'admissions.waitlist_promoted', data: { name: String(next[0].first_name) }, title: 'A seat has opened', body: `${next[0].first_name} has moved off the waiting list and now has an offer.`, entityType: 'admissions.application', entityId: String(next[0].id) });
    return { promoted: String(next[0].id) };
  }

  // ---------- enrolment ----------
  /** A8: the applicant becomes a student — guardians, account, section, roll and the first invoice. */
  async enrol(schoolId: string, applicationId: string) {
    const a = await this.db.findOne<Row>('admission_applications', { id: applicationId, school_id: schoolId });
    if (!a) throw notFound('application');
    if (a.student_id) return { studentId: String(a.student_id), alreadyEnrolled: true };
    const c = await this.db.findOne<Row>('admission_campaigns', { id: String(a.campaign_id) });
    const created = await this.people.createStudent(schoolId, {
      firstName: String(a.first_name), lastName: (a.last_name as string) ?? null, gender: String(a.gender) as 'male', dateOfBirth: String(a.date_of_birth),
      academicYearId: String(c?.academic_year_id ?? ''), classId: String(a.class_id), presentAddress: json(a.address) ?? null, previousSchool: json(a.previous_school) ?? null,
      guardians: [{ fullName: String(a.guardian_name), phone: String(a.guardian_phone), email: (a.guardian_email as string) ?? null, relation: (a.guardian_relation as string) ?? 'father', isPrimary: true } as never],
    });
    await this.db.transaction(async tx => {
      await tx.update('admission_applications', { student_id: created.id, status: 'enrolled', decided_at: nowSql(), updated_at: nowSql() }, { id: applicationId });
      await tx.update('admission_offers', { accepted_at: nowSql(), updated_at: nowSql() }, { application_id: applicationId });
    });
    await this.outbox.emitNow({ type: 'applicant.enrolled', schoolId, aggregateType: 'admissions.application', aggregateId: applicationId, payload: { applicationId, studentId: created.id, admissionNo: created.admissionNo, classId: String(a.class_id), academicYearId: String(c?.academic_year_id ?? '') } });
    await this.notifications.notify({ schoolId, address: String(a.guardian_phone), channels: ['sms'], eventKey: 'admissions.enrolled', data: { name: String(a.first_name), admissionNo: created.admissionNo }, title: 'Welcome', body: `${a.first_name} is enrolled. Admission number ${created.admissionNo}. Sign in to the parent app with this phone number.`, entityType: 'people.student', entityId: created.id });
    return { studentId: created.id, admissionNo: created.admissionNo };
  }

  async applications(schoolId: string, f: { campaignId?: string; classId?: string; status?: string } = {}) {
    const where: string[] = ['a.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.campaignId) { where.push('a.campaign_id = ?'); params.push(f.campaignId); }
    if (f.classId) { where.push('a.class_id = ?'); params.push(f.classId); }
    if (f.status) { where.push('a.status = ?'); params.push(f.status); }
    return this.db.query<Row>(`SELECT a.*, c.name AS class_name FROM admission_applications a JOIN classes c ON c.id = a.class_id WHERE ${where.join(' AND ')} ORDER BY a.merit_rank IS NULL, a.merit_rank, a.created_at DESC LIMIT 1000`, params);
  }
  async application(schoolId: string, id: string) {
    const a = await this.db.findOne<Row>('admission_applications', { id, school_id: schoolId });
    if (!a) throw notFound('application');
    const [documents, offer, results] = await Promise.all([
      this.db.findMany<Row>('application_documents', { application_id: id }),
      this.db.findOne<Row>('admission_offers', { application_id: id }),
      this.db.findMany<Row>('admission_test_results', { application_id: id }),
    ]);
    return { application: a, documents, offer, results };
  }
  /** Public status page: the guardian checks with the application number and the phone they used. */
  async track(schoolId: string, applicationNo: string, phone: string) {
    const a = await this.db.findOne<Row>('admission_applications', { school_id: schoolId, application_no: applicationNo, guardian_phone: phone.trim() });
    if (!a) throw notFound('application');
    const offer = await this.db.findOne<Row>('admission_offers', { application_id: String(a.id) });
    return {
      applicationNo, name: `${a.first_name} ${a.last_name ?? ''}`.trim(), status: String(a.status), meritRank: a.merit_rank == null ? null : Number(a.merit_rank),
      waitlistPosition: a.waitlist_position == null ? null : Number(a.waitlist_position), testScore: a.test_score == null ? null : Number(a.test_score),
      offer: offer ? { expiresAt: String(offer.expires_at), accepted: !!offer.accepted_at, invoiceId: (offer.admission_fee_invoice_id as string) ?? null } : null,
    };
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // A7: hourly — expired unpaid offers are revoked and the waitlist moves up
      'admissions.offer_expiry': async ({ schoolId }) => {
        const due = await this.db.query<Row>(`SELECT o.*, a.first_name, a.guardian_phone FROM admission_offers o JOIN admission_applications a ON a.id = o.application_id WHERE o.school_id = ? AND o.accepted_at IS NULL AND o.declined_at IS NULL AND o.revoked_at IS NULL AND o.expires_at < ?`, [schoolId, nowSql()]);
        let revoked = 0, promoted = 0;
        for (const o of due) {
          await this.db.update('admission_offers', { revoked_at: nowSql(), revoke_reason: 'admission fee not paid before the offer expired', updated_at: nowSql() }, { id: String(o.id) });
          await this.db.update('admission_applications', { status: 'rejected', rejection_reason: 'offer expired', decided_at: nowSql(), updated_at: nowSql() }, { id: String(o.application_id) });
          await this.notifications.notify({ schoolId, address: String(o.guardian_phone), channels: ['sms'], eventKey: 'admissions.offer_expired', data: { name: String(o.first_name) }, title: 'Offer expired', body: `The admission offer for ${o.first_name} has expired because the fee was not paid.`, entityType: 'admissions.offer', entityId: String(o.id) });
          revoked++;
          if (await this.promoteWaitlist(schoolId, String(o.application_id))) promoted++;
        }
        return { revoked, promoted };
      },
      // A2: daily — counsellors are reminded of the follow-ups they owe
      'admissions.followup_reminders': async ({ schoolId }) => {
        const due = await this.db.query<Row>(`SELECT e.*, s.user_id FROM admission_enquiries e LEFT JOIN staff s ON s.id = e.assigned_to WHERE e.school_id = ? AND e.status IN ('new','contacted','visited') AND e.next_follow_up_at IS NOT NULL AND e.next_follow_up_at <= ?`, [schoolId, nowSql()]);
        let reminded = 0, escalated = 0;
        for (const e of due) {
          const missed = await this.db.count('enquiry_followups', { enquiry_id: String(e.id) });
          if (!e.assigned_to) await this.assignCounsellor(schoolId, String(e.id));
          if (e.user_id) await this.notifications.notify({ schoolId, userId: String(e.user_id), channels: ['in_app', 'push'], eventKey: 'admissions.followup_due', data: { name: String(e.student_name) }, title: 'Follow-up due', body: `${e.guardian_name} (${e.phone}) asked about ${e.student_name}. Call them today.`, entityType: 'admissions.enquiry', entityId: String(e.id) });
          reminded++;
          if (missed >= 2) { await this.notifications.notifyRole(schoolId, 'admin', { channels: ['in_app'], eventKey: 'admissions.followup_escalated', title: 'Enquiry going cold', body: `${e.student_name} has had ${missed} follow-ups and is still open.`, entityType: 'admissions.enquiry', entityId: String(e.id) }); escalated++; }
        }
        return { reminded, escalated };
      },
    };
  }

  /** Bulk merit computation for a whole campaign, chunked by class. */
  async runMeritJob(payload: Record<string, unknown>, ctx: JobContext) {
    const campaignId = String(payload.campaignId);
    const c = await this.db.findOne<Row>('admission_campaigns', { id: campaignId });
    if (!c) throw notFound('campaign');
    const schoolId = String(c.school_id);
    const classes = await this.db.findMany<Row>('admission_campaign_classes', { campaign_id: campaignId });
    const cursor = (ctx.job.cursor as { done?: number } | null) ?? {};
    let done = cursor.done ?? 0;
    let ranked = 0;
    while (done < classes.length) {
      const r = await this.computeMerit(schoolId, campaignId, String(classes[done]!.class_id));
      ranked += r.ranked; done++;
      await ctx.progress(done, classes.length, { done });
      if (Date.now() > ctx.deadline && done < classes.length) return { continue: true as const, cursor: { done } };
    }
    return { result: { classes: classes.length, ranked } };
  }
}

/** Whole years between two dates. */
function years(from: string, to: string) {
  const a = new Date(`${from.slice(0, 10)}T00:00:00Z`), b = new Date(`${to.slice(0, 10)}T00:00:00Z`);
  let n = b.getUTCFullYear() - a.getUTCFullYear();
  if (b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())) n--;
  return n;
}
/** Stable 32-bit hash — the lottery draw must be repeatable and checkable by anyone. */
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 1_000_000;
}
