import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { TaskService } from '../tasks.js';
import type { ApprovalService } from '../approvals.js';
import type { InventoryService } from './inventory.js';
import { encryptSecret, decryptSecret } from '../util.js';
import { HttpError, badRequest, notFound } from '../context.js';

/** Seeded so a school has something to record against on day one. */
const CATEGORIES: [string, 'positive' | 'negative', number, 'low' | 'medium' | 'high' | 'critical', boolean][] = [
  ['Helped a classmate', 'positive', 3, 'low', false],
  ['Excellent work', 'positive', 5, 'low', false],
  ['Represented the school', 'positive', 10, 'low', true],
  ['Late to class', 'negative', -1, 'low', false],
  ['Homework not done', 'negative', -2, 'low', true],
  ['Disrupting the class', 'negative', -5, 'medium', true],
  ['Bullying', 'negative', -15, 'high', true],
  ['Violence', 'negative', -25, 'critical', true],
];

/**
 * Welfare: behaviour points that add up to a proposed action rather than a teacher's mood, health
 * records and vaccinations, the clinic (which takes its medicines out of the store and calls home
 * when a child is sent home), counselling and safeguarding notes that are encrypted at rest and
 * readable only through this service, and special-needs plans.
 */
export class WelfareService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService, private tasks: TaskService,
    private approvals: ApprovalService, private inventory: InventoryService, private appKey: string,
  ) {}

  // ---------- behaviour ----------
  async ensureCategories(schoolId: string) {
    if (await this.db.count('behaviour_categories', { school_id: schoolId })) return 0;
    for (const [name, polarity, points, severity, notify] of CATEGORIES) {
      await this.db.insert('behaviour_categories', { id: ulid(), school_id: schoolId, name, polarity, default_points: points, severity, notify_guardian: notify });
    }
    if (!(await this.db.count('behaviour_rules', { school_id: schoolId }))) {
      await this.db.insert('behaviour_rules', { id: ulid(), school_id: schoolId, name: 'Repeated misconduct in a month', window_days: 30, threshold_points: -20, action_type: 'detention', notify_roles: ['principal', 'admin'] as never, is_active: true });
      await this.db.insert('behaviour_rules', { id: ulid(), school_id: schoolId, name: 'Serious pattern in a term', window_days: 90, threshold_points: -50, action_type: 'suspension', notify_roles: ['principal'] as never, is_active: true });
    }
    return CATEGORIES.length;
  }
  async categories(schoolId: string) { return this.db.findMany<Row>('behaviour_categories', { school_id: schoolId }, { orderBy: 'polarity DESC, default_points DESC' }); }
  /** N1: a category that says so tells the guardian, with the class teacher copied in. */
  async recordIncident(schoolId: string, i: { studentId: string; categoryId: string; incidentDate?: string; points?: number; description: string; reportedBy: string; witnesses?: string | null }) {
    const category = await this.db.findOne<Row>('behaviour_categories', { id: i.categoryId, school_id: schoolId });
    if (!category) throw notFound('behaviour category');
    const id = ulid();
    const points = i.points ?? Number(category.default_points);
    await this.db.insert('behaviour_incidents', { id, school_id: schoolId, student_id: i.studentId, category_id: i.categoryId, incident_date: i.incidentDate ?? nowSql().slice(0, 10), points, description: i.description, reported_by: i.reportedBy, witnesses: i.witnesses ?? null, attachments: null, guardian_notified_at: null, status: 'open' });
    if (Number(category.notify_guardian)) {
      const student = await this.db.findOne<Row>('students', { id: i.studentId });
      await this.notifyGuardians(schoolId, i.studentId, 'welfare.behaviour_incident', points >= 0 ? 'Well done' : 'Behaviour note', `${student?.first_name}: ${category.name}. ${i.description}`, id);
      await this.db.update('behaviour_incidents', { guardian_notified_at: nowSql(), updated_at: nowSql() }, { id });
    }
    await this.outbox.emitNow({ type: 'incident.reported', schoolId, aggregateType: 'welfare.incident', aggregateId: id, payload: { incidentId: id, studentId: i.studentId, points, severity: String(category.severity) } });
    if (category.severity === 'critical') await this.tasks.create({ schoolId, title: `Critical behaviour incident to review`, taskType: 'welfare.incident', assignedRole: 'principal', entityType: 'welfare.incident', entityId: id, priority: 'urgent' });
    return { id, points };
  }
  async incidents(schoolId: string, f: { studentId?: string; status?: string } = {}) {
    const where = ['i.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.studentId) { where.push('i.student_id = ?'); params.push(f.studentId); }
    if (f.status) { where.push('i.status = ?'); params.push(f.status); }
    return this.db.query<Row>(`SELECT i.*, c.name AS category_name, c.polarity, c.severity, s.first_name, s.last_name FROM behaviour_incidents i JOIN behaviour_categories c ON c.id = i.category_id JOIN students s ON s.id = i.student_id WHERE ${where.join(' AND ')} ORDER BY i.incident_date DESC LIMIT 300`, params);
  }
  /** The running total a rule is measured against. */
  async points(schoolId: string, studentId: string, windowDays = 30) {
    const from = addDays(nowSql().slice(0, 10), -windowDays);
    const rows = await this.db.query<{ total: number; n: number }>(`SELECT COALESCE(SUM(points), 0) AS total, COUNT(*) AS n FROM behaviour_incidents WHERE school_id = ? AND student_id = ? AND incident_date >= ?`, [schoolId, studentId, from]);
    return { total: Number(rows[0]?.total ?? 0), incidents: Number(rows[0]?.n ?? 0), windowDays, from };
  }
  async proposeAction(schoolId: string, a: { studentId: string; actionType: 'verbal_warning' | 'written_warning' | 'detention' | 'suspension' | 'expulsion' | 'counselling' | 'community_service'; incidentId?: string | null; fromDate?: string | null; toDate?: string | null; description?: string | null; isAuto?: boolean }) {
    const id = ulid();
    await this.db.insert('disciplinary_actions', { id, school_id: schoolId, incident_id: a.incidentId ?? null, student_id: a.studentId, action_type: a.actionType, from_date: a.fromDate ?? null, to_date: a.toDate ?? null, description: a.description ?? null, is_auto_proposed: !!a.isAuto, status: 'pending', approved_by: null, guardian_acknowledged_at: null });
    const ap = await this.approvals.request({ schoolId, entityType: 'welfare.disciplinary_action', entityId: id, summary: { studentId: a.studentId, action: a.actionType } });
    if (ap.status === 'approved') await this.approveAction(schoolId, id);
    return { id, approval: ap.status };
  }
  /** Suspension is not a message a guardian should read from a chat thread; it goes by SMS too. */
  async approveAction(schoolId: string, id: string, approvedBy?: string | null) {
    const a = await this.db.findOne<Row>('disciplinary_actions', { id, school_id: schoolId });
    if (!a) throw notFound('action');
    if (a.status === 'approved') return { id, status: 'approved' as const };
    await this.db.update('disciplinary_actions', { status: 'approved', approved_by: approvedBy ?? null, updated_at: nowSql() }, { id });
    const student = await this.db.findOne<Row>('students', { id: String(a.student_id) });
    await this.notifyGuardians(schoolId, String(a.student_id), 'welfare.action_taken', 'Disciplinary action', `${student?.first_name}: ${String(a.action_type).replace(/_/g, ' ')}${a.from_date ? ` from ${String(a.from_date).slice(0, 10)}` : ''}. Please acknowledge in the app.`, id, ['sms', 'push', 'in_app']);
    if (a.incident_id) await this.db.update('behaviour_incidents', { status: 'actioned', updated_at: nowSql() }, { id: String(a.incident_id) });
    return { id, status: 'approved' as const };
  }
  async acknowledgeAction(schoolId: string, id: string, guardianUserId: string) {
    const a = await this.db.findOne<Row>('disciplinary_actions', { id, school_id: schoolId });
    if (!a) throw notFound('action');
    const guardian = await this.db.findOne<{ id: string }>('guardians', { school_id: schoolId, user_id: guardianUserId });
    if (!guardian || !(await this.db.findOne('student_guardians', { student_id: String(a.student_id), guardian_id: guardian.id }))) throw new HttpError(403, 'not your child', 'forbidden');
    await this.db.update('disciplinary_actions', { guardian_acknowledged_at: nowSql(), updated_at: nowSql() }, { id });
    return { id, acknowledgedAt: nowSql() };
  }
  async actions(schoolId: string, studentId?: string) {
    const where: Row = { school_id: schoolId };
    if (studentId) where.student_id = studentId;
    return this.db.findMany<Row>('disciplinary_actions', where, { orderBy: 'created_at DESC', limit: 200 });
  }

  // ---------- health and the clinic ----------
  async recordHealth(schoolId: string, h: { studentId: string; recordedOn?: string; heightCm?: number | null; weightKg?: number | null; visionLeft?: string | null; visionRight?: string | null; hearing?: string | null; dental?: string | null; doctorNotes?: string | null; recordedBy?: string | null }) {
    const bmi = h.heightCm && h.weightKg ? Math.round((h.weightKg / ((h.heightCm / 100) ** 2)) * 10) / 10 : null;
    const id = ulid();
    await this.db.insert('health_records', { id, school_id: schoolId, student_id: h.studentId, recorded_on: h.recordedOn ?? nowSql().slice(0, 10), height_cm: h.heightCm ?? null, weight_kg: h.weightKg ?? null, bmi, vision_left: h.visionLeft ?? null, vision_right: h.visionRight ?? null, hearing: h.hearing ?? null, dental: h.dental ?? null, doctor_notes: h.doctorNotes ?? null, recorded_by: h.recordedBy ?? null });
    return { id, bmi };
  }
  async health(schoolId: string, studentId: string) {
    return {
      records: await this.db.findMany<Row>('health_records', { school_id: schoolId, student_id: studentId }, { orderBy: 'recorded_on DESC', limit: 50 }),
      vaccinations: await this.db.findMany<Row>('vaccinations', { school_id: schoolId, student_id: studentId }, { orderBy: 'given_on DESC', limit: 50 }),
      visits: await this.db.findMany<Row>('clinic_visits', { school_id: schoolId, student_id: studentId }, { orderBy: 'visited_at DESC', limit: 50 }),
    };
  }
  async recordVaccination(schoolId: string, v: { studentId: string; vaccine: string; doseNo?: number; givenOn?: string | null; nextDueOn?: string | null }) {
    const ex = await this.db.findOne<Row>('vaccinations', { student_id: v.studentId, vaccine: v.vaccine, dose_no: v.doseNo ?? 1 });
    const row = { school_id: schoolId, student_id: v.studentId, vaccine: v.vaccine, dose_no: v.doseNo ?? 1, given_on: v.givenOn ?? null, next_due_on: v.nextDueOn ?? null, certificate_file_id: null };
    if (ex) { await this.db.update('vaccinations', { ...row, updated_at: nowSql() }, { id: String(ex.id) }); return String(ex.id); }
    const id = ulid();
    await this.db.insert('vaccinations', { id, ...row });
    return id;
  }
  /**
   * L5 and N4: medicines leave the clinic store as stock movements, and a child sent home is a phone
   * call, not an in-app note.
   */
  async clinicVisit(schoolId: string, v: { personType?: 'student' | 'staff'; studentId?: string | null; staffId?: string | null; complaint: string; treatment?: string | null; medicines?: { itemId: string; quantity: number }[]; storeId?: string | null; referredTo?: string | null; sentHome?: boolean; attendedBy?: string | null }) {
    const id = ulid();
    const personType = v.personType ?? (v.studentId ? 'student' : 'staff');
    const given: { itemId: string; quantity: number; name?: string }[] = [];
    for (const m of v.medicines ?? []) {
      const store = v.storeId ?? String((await this.db.findMany<Row>('stores', { school_id: schoolId }, { limit: 1 }))[0]?.id ?? '');
      if (!store) break;
      await this.inventory.move(schoolId, { itemId: m.itemId, storeId: store, moveType: 'consume', quantity: m.quantity, refType: 'clinic_visit', refId: id, note: v.complaint.slice(0, 100) });
      const item = await this.db.findOne<Row>('inventory_items', { id: m.itemId });
      given.push({ itemId: m.itemId, quantity: m.quantity, name: String(item?.name ?? '') });
    }
    await this.db.insert('clinic_visits', { id, school_id: schoolId, person_type: personType, student_id: v.studentId ?? null, staff_id: v.staffId ?? null, visited_at: nowSql(), complaint: v.complaint.slice(0, 255), treatment: v.treatment ?? null, medicines_given: (given.length ? given : null) as never, referred_to: v.referredTo ?? null, sent_home: !!v.sentHome, guardian_notified_at: null, attended_by: v.attendedBy ?? null });
    if (personType === 'student' && v.studentId) {
      const student = await this.db.findOne<Row>('students', { id: v.studentId });
      const channels: ('sms' | 'push' | 'in_app')[] = v.sentHome ? ['sms', 'push', 'in_app'] : ['push', 'in_app'];
      await this.notifyGuardians(schoolId, v.studentId, v.sentHome ? 'welfare.sent_home' : 'welfare.clinic_visit', v.sentHome ? 'Your child is being sent home' : 'Clinic visit', `${student?.first_name} came to the clinic: ${v.complaint}.${v.sentHome ? ' Please collect them or call the school now.' : ''}`, id, channels);
      await this.db.update('clinic_visits', { guardian_notified_at: nowSql(), updated_at: nowSql() }, { id });
    }
    return { id, medicines: given.length };
  }

  // ---------- counselling and safeguarding (encrypted) ----------
  /** Notes are stored encrypted; only this service decrypts them, and only for the people allowed. */
  async counsellingSession(schoolId: string, c: { studentId: string; counsellorId: string; sessionAt?: string; referralSource?: 'self' | 'teacher' | 'behaviour_rule' | 'result_drop' | 'guardian' | 'clinic'; notes?: string | null; followUpAt?: string | null; status?: 'scheduled' | 'done' | 'no_show' | 'cancelled' }) {
    const id = ulid();
    await this.db.insert('counselling_sessions', { id, school_id: schoolId, student_id: c.studentId, counsellor_id: c.counsellorId, session_at: c.sessionAt ?? nowSql(), referral_source: c.referralSource ?? 'self', notes_encrypted: c.notes ? encryptSecret(c.notes, this.appKey) : null, follow_up_at: c.followUpAt ?? null, status: c.status ?? 'scheduled' });
    return id;
  }
  /** Only the counsellor who ran the session, or the case owner, sees the words. */
  async counsellingNotes(schoolId: string, sessionId: string, staffId: string) {
    const s = await this.db.findOne<Row>('counselling_sessions', { id: sessionId, school_id: schoolId });
    if (!s) throw notFound('session');
    if (String(s.counsellor_id) !== staffId) throw new HttpError(403, 'only the counsellor who held the session can read the notes', 'forbidden');
    return { id: sessionId, notes: s.notes_encrypted ? decryptSecret(String(s.notes_encrypted), this.appKey) : null };
  }
  async counsellingSessions(schoolId: string, f: { studentId?: string; counsellorId?: string } = {}) {
    const where: Row = { school_id: schoolId };
    if (f.studentId) where.student_id = f.studentId;
    if (f.counsellorId) where.counsellor_id = f.counsellorId;
    // the list never carries the notes themselves
    const rows = await this.db.findMany<Row>('counselling_sessions', where, { orderBy: 'session_at DESC', limit: 200 });
    return rows.map(r => ({ ...r, notes_encrypted: undefined, has_notes: !!r.notes_encrypted }));
  }
  async safeguardingCase(schoolId: string, c: { studentId: string; category: 'abuse' | 'neglect' | 'bullying' | 'online_safety' | 'self_harm' | 'other'; details: string; riskLevel?: 'low' | 'medium' | 'high'; reportedBy?: string | null; caseOwnerId?: string | null }) {
    const id = ulid();
    await this.db.insert('safeguarding_cases', { id, school_id: schoolId, student_id: c.studentId, reported_by: c.reportedBy ?? null, category: c.category, details_encrypted: encryptSecret(c.details, this.appKey), risk_level: c.riskLevel ?? 'medium', status: 'open', case_owner_id: c.caseOwnerId ?? null, closed_at: null });
    // no names, no details: whoever is on call needs to open the case, not read it in a push.
    // an alert nobody receives is worse than none, so a school with no principal account tells the admins
    const sent = await this.notifications.notifyRole(schoolId, 'principal', { channels: ['push', 'in_app'], eventKey: 'welfare.safeguarding_case', title: 'A safeguarding case has been opened', body: `Risk level ${c.riskLevel ?? 'medium'}. Open the case to see the details.`, entityType: 'welfare.safeguarding', entityId: id });
    if (!sent.length) await this.notifications.notifyRole(schoolId, 'admin', { channels: ['push', 'in_app'], eventKey: 'welfare.safeguarding_case', title: 'A safeguarding case has been opened', body: `Risk level ${c.riskLevel ?? 'medium'}. Open the case to see the details.`, entityType: 'welfare.safeguarding', entityId: id });
    await this.tasks.create({ schoolId, title: 'Review a safeguarding case', taskType: 'welfare.safeguarding', assignedRole: 'principal', entityType: 'welfare.safeguarding', entityId: id, priority: 'urgent' });
    return id;
  }
  async safeguardingDetails(schoolId: string, caseId: string, staffId: string) {
    const c = await this.db.findOne<Row>('safeguarding_cases', { id: caseId, school_id: schoolId });
    if (!c) throw notFound('case');
    if (c.case_owner_id && String(c.case_owner_id) !== staffId) throw new HttpError(403, 'only the case owner can read this case', 'forbidden');
    return { id: caseId, category: String(c.category), riskLevel: String(c.risk_level), status: String(c.status), details: c.details_encrypted ? decryptSecret(String(c.details_encrypted), this.appKey) : null };
  }
  async safeguardingCases(schoolId: string) {
    const rows = await this.db.findMany<Row>('safeguarding_cases', { school_id: schoolId }, { orderBy: 'created_at DESC', limit: 200 });
    return rows.map(r => ({ ...r, details_encrypted: undefined }));
  }

  // ---------- special needs ----------
  async savePlan(schoolId: string, p: { studentId: string; diagnosis?: string | null; accommodations?: string[]; goals?: { goal: string; by: string }[]; reviewDate?: string | null; coordinatorId?: string | null }) {
    const ex = await this.db.findOne<Row>('special_needs_plans', { school_id: schoolId, student_id: p.studentId });
    const row = { school_id: schoolId, student_id: p.studentId, diagnosis: p.diagnosis ?? null, accommodations: (p.accommodations ?? []) as never, goals: (p.goals ?? []) as never, review_date: p.reviewDate ?? null, coordinator_id: p.coordinatorId ?? null };
    if (ex) { await this.db.update('special_needs_plans', { ...row, updated_at: nowSql() }, { id: String(ex.id) }); return String(ex.id); }
    const id = ulid();
    await this.db.insert('special_needs_plans', { id, ...row });
    return id;
  }
  async plan(schoolId: string, studentId: string) { return this.db.findOne<Row>('special_needs_plans', { school_id: schoolId, student_id: studentId }); }

  private async notifyGuardians(schoolId: string, studentId: string, eventKey: string, title: string, body: string, entityId: string, channels: ('sms' | 'push' | 'in_app' | 'email')[] = ['push', 'in_app']) {
    const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [studentId]);
    for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels, eventKey, title, body, entityType: 'welfare.incident', entityId });
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // N2: points crossing a threshold propose an action; N3: a vaccination falling due
      'welfare.behaviour_rules': async ({ schoolId }) => {
        const rules = await this.db.findMany<Row>('behaviour_rules', { school_id: schoolId, is_active: true });
        let proposed = 0;
        for (const rule of rules) {
          const from = addDays(nowSql().slice(0, 10), -Number(rule.window_days));
          const totals = await this.db.query<{ student_id: string; total: number }>(`SELECT student_id, SUM(points) AS total FROM behaviour_incidents WHERE school_id = ? AND incident_date >= ? GROUP BY student_id`, [schoolId, from]);
          for (const t of totals) {
            if (Number(t.total) > Number(rule.threshold_points)) continue;    // thresholds are negative
            // one proposal per student per rule per window, not one a night
            const recent = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM disciplinary_actions WHERE school_id = ? AND student_id = ? AND action_type = ? AND created_at >= ?`, [schoolId, String(t.student_id), String(rule.action_type), `${from} 00:00:00`]);
            if (Number(recent[0]?.n ?? 0) > 0) continue;
            const r = await this.proposeAction(schoolId, { studentId: String(t.student_id), actionType: String(rule.action_type) as 'detention', description: `${rule.name}: ${t.total} points in ${rule.window_days} days`, isAuto: true });
            for (const role of json<string[]>(rule.notify_roles) ?? ['principal']) {
              await this.notifications.notifyRole(schoolId, role, { channels: ['in_app', 'push'], eventKey: 'welfare.action_proposed', title: 'Behaviour threshold crossed', body: `${rule.name}: ${t.total} points in ${rule.window_days} days. A ${String(rule.action_type).replace(/_/g, ' ')} has been proposed.`, entityType: 'welfare.disciplinary_action', entityId: r.id });
            }
            proposed++;
          }
        }
        // N3: a vaccination falling due. The window is a week wide, so without a guard the same
        // family was texted about the same jab on each of seven nights; one message per dose is
        // enough, and a booster months later is a different row and gets its own.
        const due = await this.db.query<Row>(`SELECT v.*, s.first_name FROM vaccinations v JOIN students s ON s.id = v.student_id WHERE v.school_id = ? AND v.next_due_on IS NOT NULL AND v.next_due_on BETWEEN ? AND ?`, [schoolId, nowSql().slice(0, 10), addDays(nowSql().slice(0, 10), 7)]);
        let reminded = 0;
        for (const v of due) {
          if (await this.notifications.sentSince(schoolId, 'welfare.vaccination_due', String(v.id), nowSql(new Date(Date.now() - (24 * 30) * 3600_000)))) continue;
          await this.notifyGuardians(schoolId, String(v.student_id), 'welfare.vaccination_due', 'Vaccination due', `${v.first_name}: ${v.vaccine} dose ${v.dose_no} is due on ${String(v.next_due_on).slice(0, 10)}.`, String(v.id), ['sms', 'push', 'in_app']);
          reminded++;
        }
        return { proposed, vaccinationReminders: reminded };
      },
      /**
       * N14 and N15 (P21 of the year-2 list): the welfare work that has no deadline of its own and so
       * gets forgotten.
       *
       * A safeguarding case that stays open is reviewed every fortnight. The reminder says a case
       * needs looking at, its risk level and how long it has been open — never the category and never
       * a word of what is in it, because the details are encrypted and only the case owner decrypts
       * them, and an alert is read on a phone screen anybody can see over a shoulder. The event
       * payload carries the same three facts for the same reason.
       *
       * Beside it: a counselling follow-up whose date has gone by with no later session, a special
       * needs plan past its review date, and an insurance policy about to lapse. Each becomes one
       * open task, which is the difference between a duty and an intention.
       */
      'welfare.followups': async ({ schoolId }) => {
        const today = nowSql().slice(0, 10);
        const fortnight = nowSql(new Date(Date.now() - 14 * 86_400_000));
        const open = await this.db.query<Row>(`SELECT * FROM safeguarding_cases WHERE school_id = ? AND status = 'open' AND created_at < ? ORDER BY created_at LIMIT 200`, [schoolId, fortnight]);
        let reviews = 0;
        for (const c of open) {
          if (await this.notifications.sentSince(schoolId, 'welfare.case_review_due', String(c.id), nowSql(new Date(Date.now() - (24 * 14) * 3600_000)))) continue;
          const daysOpen = Math.max(0, Math.round((Date.now() - Date.parse(`${String(c.created_at).replace(' ', 'T')}Z`)) / 86_400_000));
          const body = `A case opened ${daysOpen} day(s) ago is still open. Risk level ${c.risk_level}. Open the case to see it.`;
          const alert = { channels: ['push', 'in_app'] as ('push' | 'in_app')[], eventKey: 'welfare.case_review_due', title: 'A safeguarding case is due for review', body, entityType: 'welfare.safeguarding', entityId: String(c.id) };
          const owner = c.case_owner_id ? await this.db.findOne<Row>('staff', { id: String(c.case_owner_id) }) : null;
          if (owner?.user_id) await this.notifications.notify({ schoolId, userId: String(owner.user_id), ...alert });
          else {
            // as when the case was opened: a reminder nobody receives is worse than none, so a school
            // with no principal account falls back to the admins
            const sent = await this.notifications.notifyRole(schoolId, 'principal', alert);
            if (!sent.length) await this.notifications.notifyRole(schoolId, 'admin', alert);
          }
          const ownerUser = (owner?.user_id as string) ?? null;      // a task is held by a user account, not a staff row
          await this.tasks.ensure({ schoolId, title: 'Review an open safeguarding case', description: `Open for ${daysOpen} day(s), risk level ${c.risk_level}. Open the case itself for the details.`, taskType: 'welfare.safeguarding', assignedTo: ownerUser, assignedRole: ownerUser ? null : 'principal', entityType: 'welfare.safeguarding', entityId: String(c.id), priority: c.risk_level === 'high' ? 'urgent' : 'high' });
          await this.outbox.emitNow({ type: 'safeguarding.review_due', schoolId, aggregateType: 'welfare.safeguarding', aggregateId: String(c.id), payload: { caseId: String(c.id), riskLevel: String(c.risk_level), daysOpen } });
          reviews++;
        }
        // a counselling follow-up nobody kept: the date passed and no session has happened since
        const followUps = await this.db.query<Row>(`SELECT c.* FROM counselling_sessions c WHERE c.school_id = ? AND c.follow_up_at IS NOT NULL AND c.follow_up_at < ? AND c.status IN ('scheduled','done')
          AND NOT EXISTS (SELECT 1 FROM counselling_sessions later WHERE later.student_id = c.student_id AND later.session_at > c.follow_up_at) ORDER BY c.follow_up_at LIMIT 200`, [schoolId, nowSql()]);
        for (const s of followUps) {
          const counsellor = (await this.db.findOne<Row>('staff', { id: String(s.counsellor_id) }))?.user_id as string ?? null;
          await this.tasks.ensure({ schoolId, title: 'A counselling follow-up is overdue', description: `The follow-up was set for ${String(s.follow_up_at).slice(0, 16)} and no session has been held since. Open the session for the rest.`, taskType: 'welfare.counselling', assignedTo: counsellor, assignedRole: counsellor ? null : 'principal', entityType: 'welfare.counselling', entityId: String(s.id), dueAt: String(s.follow_up_at) });
        }
        // special needs plans past their review date
        const plans = await this.db.query<Row>(`SELECT p.*, s.first_name, s.last_name FROM special_needs_plans p JOIN students s ON s.id = p.student_id WHERE p.school_id = ? AND p.review_date IS NOT NULL AND p.review_date < ? LIMIT 200`, [schoolId, today]);
        for (const p of plans) {
          const coordinator = p.coordinator_id ? ((await this.db.findOne<Row>('staff', { id: String(p.coordinator_id) }))?.user_id as string) ?? null : null;
          await this.tasks.ensure({ schoolId, title: `Review the support plan for ${p.first_name} ${p.last_name ?? ''}`.trim(), description: `The review was due on ${String(p.review_date).slice(0, 10)}.`, taskType: 'welfare.plan_review', assignedTo: coordinator, assignedRole: coordinator ? null : 'principal', entityType: 'welfare.plan', entityId: String(p.id), dueAt: String(p.review_date).slice(0, 10) });
        }
        // insurance about to lapse — a month is enough notice to renew a policy
        const policies = await this.db.query<Row>(`SELECT * FROM insurance_policies WHERE school_id = ? AND valid_to IS NOT NULL AND valid_to <= ? LIMIT 200`, [schoolId, addDays(today, 30)]);
        for (const p of policies) {
          await this.tasks.ensure({ schoolId, title: `${p.provider ?? 'Insurance'} policy ${p.policy_no ?? ''} ${String(p.valid_to).slice(0, 10) < today ? 'has lapsed' : `expires on ${String(p.valid_to).slice(0, 10)}`}`.trim(), taskType: 'welfare.insurance', assignedRole: 'admin', entityType: 'welfare.insurance', entityId: String(p.id), dueAt: String(p.valid_to).slice(0, 10), priority: String(p.valid_to).slice(0, 10) < today ? 'high' : 'normal' });
        }
        return { caseReviews: reviews, counsellingFollowUps: followUps.length, planReviews: plans.length, insurance: policies.length };
      },
    };
  }
}

const addDays = (date: string, days: number) => { const d = new Date(`${date.slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
