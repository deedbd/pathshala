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
import type { FileService } from '../files.js';
import type { SettingsService } from '../settings.js';
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
    private academic: AcademicService, private people: PeopleService, private fees: FeesService, private documents: DocumentService, private files: FileService, private settings: SettingsService, private adapters: Adapters,
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

  // ---------- applicant documents ----------
  /**
   * What the guardian uploads with the form. Nothing here decides admission; it exists so the office
   * is not chasing a birth certificate on the day the child is meant to start.
   */
  async uploadDocument(schoolId: string, applicationId: string, d: { docType: string; data: Buffer; fileName: string; mimeType?: string }) {
    const app = await this.db.findOne<Row>('admission_applications', { id: applicationId, school_id: schoolId });
    if (!app) throw notFound('application');
    if (d.data.length > 8 * 1024 * 1024) throw badRequest('a document may not be larger than 8 MB');
    const f = await this.files.store({ schoolId, data: d.data, fileName: d.fileName, mimeType: d.mimeType ?? 'application/octet-stream', purpose: `admission_${d.docType}`, entityType: 'admissions.application', entityId: applicationId });
    const ex = await this.db.findOne<Row>('application_documents', { application_id: applicationId, doc_type: d.docType });
    const id = ex ? String(ex.id) : ulid();
    // a re-upload replaces the old one and drops the verification with it: it is a different paper now
    if (ex) await this.db.update('application_documents', { file_id: f.id, verified_at: null, verified_by: null }, { id });
    else await this.db.insert('application_documents', { id, school_id: schoolId, application_id: applicationId, doc_type: d.docType, file_id: f.id, verified_at: null, verified_by: null });
    if (d.docType === 'photo') await this.db.update('admission_applications', { photo_file_id: f.id, updated_at: nowSql() }, { id: applicationId });
    return { id, fileId: f.id, docType: d.docType, replaced: !!ex };
  }
  async verifyDocument(schoolId: string, documentId: string, verifiedBy?: string | null) {
    const n = await this.db.update('application_documents', { verified_at: nowSql(), verified_by: verifiedBy ?? null }, { id: documentId, school_id: schoolId });
    if (!n) throw notFound('document');
    return { id: documentId, verified: true };
  }
  /** The checklist, with what is still missing named rather than counted. */
  async documentChecklist(schoolId: string, applicationId: string) {
    const required = (await this.settings.get<string[]>(schoolId, 'admissions.required_documents')) ?? ['photo', 'birth_certificate', 'previous_result'];
    const have = await this.db.findMany<Row>('application_documents', { school_id: schoolId, application_id: applicationId });
    const byType = new Map(have.map(h => [String(h.doc_type), h]));
    return {
      required, uploaded: have,
      missing: required.filter(r => !byType.has(r)),
      unverified: have.filter(h => !h.verified_at).map(h => String(h.doc_type)),
      complete: required.every(r => byType.get(r)?.verified_at),
    };
  }

  // ---------- interviews ----------
  /**
   * Interview slots for a test: a strip of times someone actually has to sit through, so the slots are
   * made once and applicants are put into them one at a time. A slot holds one applicant — an interview
   * that overlaps another is an interview nobody attends.
   */
  async createInterviewSlots(schoolId: string, testId: string, p: { from: string; minutes?: number; count: number; venue?: string | null; panel?: string[] | null; breakAfter?: number; breakMinutes?: number }) {
    const test = await this.db.findOne<Row>('admission_tests', { id: testId, school_id: schoolId });
    if (!test) throw notFound('test');
    if (p.count < 1 || p.count > 400) throw badRequest('between 1 and 400 slots at a time');
    const minutes = Math.max(5, Math.min(120, p.minutes ?? 15));
    let at = new Date(`${p.from.replace(' ', 'T').slice(0, 19)}Z`);
    if (Number.isNaN(at.getTime())) throw badRequest(`${p.from} is not a date and time`);
    const made: string[] = [];
    for (let i = 0; i < p.count; i++) {
      const ends = new Date(at.getTime() + minutes * 60_000);
      const id = ulid();
      await this.db.insert('admission_interviews', { id, school_id: schoolId, test_id: testId, application_id: null, starts_at: sql(at), ends_at: sql(ends), venue: p.venue ?? (test.venue as string) ?? null, panel: (p.panel ?? null) as never, status: 'open', notes: null });
      made.push(id);
      at = ends;
      if (p.breakAfter && (i + 1) % p.breakAfter === 0) at = new Date(at.getTime() + (p.breakMinutes ?? 15) * 60_000);
    }
    return { testId, slots: made.length, from: made.length ? p.from : null };
  }
  /** Puts an applicant in the next free slot (or a named one) and tells the guardian when to come. */
  async scheduleInterview(schoolId: string, applicationId: string, opts: { testId?: string; slotId?: string } = {}) {
    const app = await this.db.findOne<Row>('admission_applications', { id: applicationId, school_id: schoolId });
    if (!app) throw notFound('application');
    const held = await this.db.findOne<Row>('admission_interviews', { school_id: schoolId, application_id: applicationId });
    if (held) return { slotId: String(held.id), startsAt: String(held.starts_at), alreadyScheduled: true };
    const slot = opts.slotId
      ? await this.db.findOne<Row>('admission_interviews', { id: opts.slotId, school_id: schoolId, status: 'open' })
      : (await this.db.query<Row>(`SELECT i.* FROM admission_interviews i${opts.testId ? '' : ' JOIN admission_tests t ON t.id = i.test_id'} WHERE i.school_id = ? AND i.status = 'open' AND i.application_id IS NULL AND ${opts.testId ? 'i.test_id = ?' : 't.class_id = ?'} ORDER BY i.starts_at LIMIT 1`, [schoolId, opts.testId ?? String(app.class_id)]))[0];
    if (!slot) throw new HttpError(409, 'there is no free interview slot left; make more first', 'no_slot');
    const taken = await this.db.update('admission_interviews', { application_id: applicationId, status: 'booked', updated_at: nowSql() }, { id: String(slot.id), status: 'open' });
    if (!taken) throw new HttpError(409, 'somebody took that slot first', 'no_slot');
    await this.db.update('admission_applications', { status: 'test_scheduled', updated_at: nowSql() }, { id: applicationId });
    await this.notifications.notify({ schoolId, address: String(app.guardian_phone), channels: ['sms'], eventKey: 'admissions.interview_scheduled', data: { no: String(app.application_no), at: String(slot.starts_at) }, title: 'Interview time', body: `${app.first_name}: interview on ${String(slot.starts_at).slice(0, 16)} at ${slot.venue ?? 'the school'}. Please arrive ten minutes early.`, entityType: 'admissions.application', entityId: applicationId });
    return { slotId: String(slot.id), startsAt: String(slot.starts_at), venue: (slot.venue as string) ?? null };
  }
  /** How it went. A no-show is recorded as one, so a merit list built from interviews is honest. */
  async recordInterview(schoolId: string, slotId: string, r: { status: 'attended' | 'no_show' | 'cancelled'; notes?: string | null; marks?: number | null; enteredBy?: string | null }) {
    const slot = await this.db.findOne<Row>('admission_interviews', { id: slotId, school_id: schoolId });
    if (!slot) throw notFound('interview slot');
    await this.db.update('admission_interviews', { status: r.status, notes: r.notes ?? null, updated_at: nowSql() }, { id: slotId });
    if (r.status === 'cancelled') await this.db.update('admission_interviews', { application_id: null, status: 'open', updated_at: nowSql() }, { id: slotId });
    // the interview is one component of the test, not the whole of it: a written score already recorded
    // against this applicant stays, and the total is the sum of what they were actually marked on
    if (slot.application_id && (r.marks != null || r.status === 'no_show')) {
      const ex = await this.db.findOne<Row>('admission_test_results', { test_id: String(slot.test_id), application_id: String(slot.application_id) });
      const components = { ...(json<Record<string, number>>(ex?.component_marks) ?? {}), interview: r.marks ?? 0 };
      await this.enterResults(schoolId, String(slot.test_id), [{ applicationId: String(slot.application_id), componentMarks: components, isAbsent: r.status === 'no_show', remarks: r.notes ?? (r.status === 'no_show' ? 'did not attend the interview' : null) }], r.enteredBy);
    }
    return { slotId, status: r.status };
  }
  async interviewSchedule(schoolId: string, testId: string) {
    return this.db.query<Row>(`SELECT i.*, a.application_no, a.first_name, a.last_name, a.guardian_phone FROM admission_interviews i LEFT JOIN admission_applications a ON a.id = i.application_id WHERE i.school_id = ? AND i.test_id = ? ORDER BY i.starts_at LIMIT 500`, [schoolId, testId]);
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

  /**
   * The merit list as one PDF, the way it goes on the notice board: rank, application number, name and
   * score, seats marked where the line falls. Names of children who were not selected still appear —
   * that is the point of publishing a merit list — but nothing else about them does.
   */
  async meritListPdf(schoolId: string, campaignId: string, classId: string) {
    const campaign = await this.db.findOne<Row>('admission_campaigns', { id: campaignId, school_id: schoolId });
    if (!campaign) throw notFound('campaign');
    const cls = await this.db.findOne<Row>('classes', { id: classId, school_id: schoolId });
    const school = await this.db.findOne<Row>('schools', { id: schoolId });
    const rows = await this.db.query<Row>(`SELECT application_no, first_name, last_name, test_score, merit_rank, status, waitlist_position FROM admission_applications WHERE school_id = ? AND campaign_id = ? AND class_id = ? AND merit_rank IS NOT NULL ORDER BY merit_rank LIMIT 2000`, [schoolId, campaignId, classId]);
    if (!rows.length) throw new HttpError(409, 'this class has no merit list yet', 'conflict');
    const seat = await this.db.findOne<Row>('admission_campaign_classes', { campaign_id: campaignId, class_id: classId });
    const seats = Number(seat?.seats ?? 0);
    const body = rows.map(r => [
      { text: String(r.merit_rank), alignment: 'right' },
      String(r.application_no),
      `${r.first_name} ${r.last_name ?? ''}`.trim(),
      { text: r.test_score == null ? '-' : String(Number(r.test_score)), alignment: 'right' },
      String(r.status) === 'waitlisted' ? `waiting ${r.waitlist_position ?? ''}`.trim() : String(r.status),
    ]);
    const doc = {
      pageSize: 'A4', pageMargins: [40, 48, 40, 48],
      content: [
        { text: String(school?.name ?? 'School'), style: 'h1', alignment: 'center' },
        { text: `Merit list — ${String(campaign.name)}`, style: 'title', alignment: 'center', margin: [0, 8, 0, 2] },
        { text: `${String(cls?.name ?? '')} · ${seats} seats · ${rows.length} applicants ranked`, style: 'small', alignment: 'center', margin: [0, 0, 0, 14] },
        { table: { headerRows: 1, widths: [34, 90, '*', 50, 70], body: [['Rank', 'Application', 'Name', 'Score', 'Result'].map(t => ({ text: t, bold: true })), ...body] }, layout: 'lightHorizontalLines' },
        { text: `Published ${nowSql().slice(0, 16)}. A place is held only until the admission fee is paid by the date on the offer letter.`, style: 'small', margin: [0, 16, 0, 0] },
      ],
      styles: { h1: { fontSize: 16, bold: true }, title: { fontSize: 13, bold: true }, small: { fontSize: 8, color: '#555' } },
    } as Record<string, unknown>;
    const pdf = await this.adapters.pdf.render(doc);
    // the purpose carries the class, so the nightly pass can tell "this sheet exists" from "a sheet
    // for some other class of the same campaign exists" and does not render the same PDF every night
    const f = await this.files.store({ schoolId, data: pdf, fileName: `merit-${String(cls?.name ?? classId)}-${campaignId.slice(-6)}.pdf`, mimeType: 'application/pdf', purpose: `merit_list:${classId}`, entityType: 'admissions.campaign', entityId: campaignId });
    return { fileId: f.id, ranked: rows.length, seats };
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
      /**
       * Daily: everything in a live admission that was waiting for somebody to remember it.
       *
       * The pieces were all here already, but each one hung off a single trigger — a test seat off
       * the form-fee payment, the merit list off the last mark, an interview off a person opening the
       * page. An admission with no form fee therefore allocated no seats at all, a class where one
       * applicant never sat the test never got a merit list, and an interview slot made in advance
       * stayed empty until somebody put names in it by hand. This pass walks the campaigns that are
       * still live and finishes what the triggers could not reach.
       */
      'admissions.campaign_watch': async ({ schoolId }) => {
        const today = nowSql().slice(0, 10);
        const out = { seated: 0, interviews: 0, merit: 0, sheets: 0, reminded: 0, chased: 0 };
        const campaigns = await this.db.query<Row>(`SELECT * FROM admission_campaigns WHERE school_id = ? AND status IN ('open','closed') ORDER BY opens_at DESC LIMIT 20`, [schoolId]);

        for (const c of campaigns) {
          const campaignId = String(c.id);
          // 1. a test to sit and nobody told them where. `onPaymentReceived` does this for a campaign
          // with a form fee; a free campaign submits the application on the spot and reached nothing.
          if (Number(c.requires_test)) {
            const waiting = await this.db.query<Row>(`SELECT a.id FROM admission_applications a JOIN admission_tests t ON t.campaign_id = a.campaign_id AND t.class_id = a.class_id
              WHERE a.school_id = ? AND a.campaign_id = ? AND a.status IN ('submitted','screening') LIMIT 100`, [schoolId, campaignId]);
            for (const a of waiting) { if (await this.allocateTestSeat(schoolId, String(a.id)).catch(() => null)) out.seated++; }
          }

          // 2. interview slots that exist and are empty, with applicants who have not been given one.
          // Putting a name in the next free slot is arithmetic; what happens in the interview is not.
          if (['interview', 'mixed'].includes(String(c.selection_mode))) {
            const unbooked = await this.db.query<Row>(`SELECT a.id, a.class_id FROM admission_applications a
              WHERE a.school_id = ? AND a.campaign_id = ? AND a.status IN ('submitted','screening','tested')
                AND NOT EXISTS (SELECT 1 FROM admission_interviews i WHERE i.application_id = a.id)
              ORDER BY a.created_at LIMIT 60`, [schoolId, campaignId]);
            let noSlot = 0;
            for (const a of unbooked) {
              try { await this.scheduleInterview(schoolId, String(a.id)); out.interviews++; }
              catch { noSlot++; }                                    // no free slot left: counted, not retried
            }
            if (noSlot) {
              await this.notifications.notifyRoleOnce(schoolId, 'admin', 72, { channels: ['in_app'], eventKey: 'admissions.no_interview_slots', title: 'Interview slots have run out', body: `${noSlot} applicants in ${String(c.name)} are waiting for an interview time. Make more slots and they will be booked in automatically.`, entityType: 'admissions.campaign', entityId: campaignId });
              out.chased++;
            }
          }

          // 3. the merit list. A5 fires on the last mark of a class; a class where somebody never sat
          // the test never gets that last mark, so the list is computed here once the admission has
          // closed and no mark can still arrive. A campaign that does not want it computed is told.
          const closed = String(c.closes_at).slice(0, 10) < today || String(c.status) === 'closed';
          if (closed) {
            const classes = await this.db.findMany<Row>('admission_campaign_classes', { campaign_id: campaignId });
            for (const k of classes) {
              const classId = String(k.class_id);
              const [pending] = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM admission_applications WHERE school_id = ? AND campaign_id = ? AND class_id = ? AND merit_rank IS NULL AND status IN ('submitted','screening','test_scheduled','tested')`, [schoolId, campaignId, classId]);
              if (Number(pending?.n ?? 0) > 0) {
                if (Number(c.auto_merit_list)) { await this.computeMerit(schoolId, campaignId, classId); out.merit++; }
                else {
                  // prepared, confirmed by a person: this campaign asked to rank its own applicants
                  await this.notifications.notifyRoleOnce(schoolId, 'admin', 72, { channels: ['in_app'], eventKey: 'admissions.merit_ready', title: 'A merit list is waiting to be drawn up', body: `${String(c.name)} has closed and ${Number(pending!.n)} applicants are unranked. Open Admissions and press Merit list.`, entityType: 'admissions.campaign', entityId: campaignId });
                  out.chased++;
                }
              }
              // an offer is a promise to a family, so a campaign that turned auto_offer off keeps the
              // decision. Everything around it is done — ranked, shortlisted, seats counted, the sheet
              // rendered — and the desk is told once that it is one button away.
              if (!Number(c.auto_offer)) {
                const [ready] = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM admission_applications WHERE school_id = ? AND campaign_id = ? AND class_id = ? AND status = 'shortlisted'`, [schoolId, campaignId, classId]);
                if (Number(ready?.n ?? 0) > 0) {
                  const sent = await this.notifications.notifyRoleOnce(schoolId, 'admin', 72, { channels: ['in_app'], eventKey: 'admissions.offers_ready', title: `${Number(ready!.n)} applicants are shortlisted and waiting for an offer`, body: `${String(c.name)}: the merit list is drawn and the seats are counted. Press Make offers and the letters, invoices and messages go out.`, entityType: 'admissions.campaign', entityId: campaignId });
                  if (sent.length) out.chased++;
                }
              }
              // 4. the sheet for the notice board, rendered once per class and left in Files
              const [ranked] = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM admission_applications WHERE school_id = ? AND campaign_id = ? AND class_id = ? AND merit_rank IS NOT NULL`, [schoolId, campaignId, classId]);
              if (Number(ranked?.n ?? 0) > 0 && !(await this.db.findOne('files', { school_id: schoolId, purpose: `merit_list:${classId}`, entity_id: campaignId }))) {
                await this.meritListPdf(schoolId, campaignId, classId).catch(() => null);
                out.sheets++;
              }
            }
          }
        }

        // 5. an offer about to lapse. The hourly job revokes it the moment it expires; nobody was
        // ever told beforehand, so the first news a family had was that the place had gone.
        const soon = nowSql(new Date(Date.now() + 2 * 86_400_000));
        const expiring = await this.db.query<Row>(`SELECT o.*, a.first_name, a.guardian_phone FROM admission_offers o JOIN admission_applications a ON a.id = o.application_id
          WHERE o.school_id = ? AND o.accepted_at IS NULL AND o.declined_at IS NULL AND o.revoked_at IS NULL AND o.expires_at BETWEEN ? AND ? LIMIT 200`, [schoolId, nowSql(), soon]);
        for (const o of expiring) {
          const sent = await this.notifications.notifyOnce(72, { schoolId, address: String(o.guardian_phone), channels: ['sms'], eventKey: 'admissions.offer_expiring', data: { name: String(o.first_name), expires: String(o.expires_at).slice(0, 10) }, title: 'Offer about to expire', body: `${o.first_name}'s place is held only until ${String(o.expires_at).slice(0, 10)}. Pay the admission fee before then to keep it.`, entityType: 'admissions.offer', entityId: String(o.id) });
          if (sent.length) out.reminded++;
        }

        // 6. papers still missing from an applicant who has been offered a place: the office would
        // otherwise discover the birth certificate is absent on the child's first morning
        const required = (await this.settings.get<string[]>(schoolId, 'admissions.required_documents')) ?? ['photo', 'birth_certificate', 'previous_result'];
        const offered = await this.db.query<Row>(`SELECT id, first_name, last_name, application_no FROM admission_applications WHERE school_id = ? AND status IN ('shortlisted','offered') ORDER BY updated_at DESC LIMIT 50`, [schoolId]);
        for (const a of offered) {
          const have = await this.db.findMany<Row>('application_documents', { school_id: schoolId, application_id: String(a.id) });
          const missing = required.filter(r => !have.some(h => String(h.doc_type) === r));
          if (!missing.length) continue;
          const sent = await this.notifications.notifyRoleOnce(schoolId, 'admin', 168, { channels: ['in_app'], eventKey: 'admissions.documents_missing', title: 'Papers still missing', body: `${a.first_name} ${a.last_name ?? ''} (${a.application_no}) has been offered a place without ${missing.join(', ')}.`, entityType: 'admissions.application', entityId: String(a.id) });
          if (sent.length) out.chased++;
        }
        return out;
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

const sql = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
