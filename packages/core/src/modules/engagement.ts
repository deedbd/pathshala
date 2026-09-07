import { randomBytes } from 'node:crypto';
import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { DocumentService } from './documents.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface SurveyInput { title: string; questions: { key: string; label: string; type?: 'text' | 'choice' | 'rating' | 'yes_no'; options?: string[] }[]; audience?: { roles?: string[]; classIds?: string[]; guardians?: boolean }; isAnonymous?: boolean; opensAt?: string | null; closesAt?: string | null }

/**
 * Engagement: surveys built on the form builder and answered by guardians in the app, newsletters
 * that go out on a schedule, events with RSVP and a QR ticket that the gate scans once, clubs and
 * houses, and the badges and achievements that make up a child's portfolio. The weekly digest — one
 * message a week per guardian, with attendance, homework and dues — runs here.
 */
export class EngagementService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService, private documents: DocumentService) {}

  // ---------- surveys ----------
  async createSurvey(schoolId: string, s: SurveyInput, createdBy?: string | null) {
    const formId = ulid();
    const slug = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || `survey-${formId.slice(-6).toLowerCase()}`;
    await this.db.insert('form_definitions', { id: formId, school_id: schoolId, name: s.title, slug, purpose: 'survey', schema_json: { fields: s.questions } as never, audience: (s.audience ?? null) as never, is_public: false, opens_at: s.opensAt ?? null, closes_at: s.closesAt ?? null, status: 'draft', created_by: createdBy ?? null });
    const id = ulid();
    await this.db.insert('surveys', { id, school_id: schoolId, form_id: formId, title: s.title, audience: (s.audience ?? null) as never, is_anonymous: !!s.isAnonymous, opens_at: s.opensAt ?? null, closes_at: s.closesAt ?? null, status: 'draft', results: null });
    return { id, formId, slug };
  }
  /** Opening a survey is what actually asks people; nothing is sent while it is a draft. */
  async openSurvey(schoolId: string, id: string) {
    const s = await this.db.findOne<Row>('surveys', { id, school_id: schoolId });
    if (!s) throw notFound('survey');
    await this.db.update('surveys', { status: 'open', opens_at: s.opens_at ?? nowSql(), updated_at: nowSql() }, { id });
    await this.db.update('form_definitions', { status: 'open', updated_at: nowSql() }, { id: String(s.form_id) });
    const audience = json<{ guardians?: boolean; roles?: string[] }>(s.audience) ?? { guardians: true };
    let asked = 0;
    if (audience.guardians !== false) {
      const users = await this.db.query<{ id: string }>(`SELECT id FROM users WHERE school_id = ? AND user_type = 'guardian' AND is_active = TRUE LIMIT 5000`, [schoolId]);
      for (const u of users) { await this.notifications.notify({ schoolId, userId: u.id, channels: ['push', 'in_app'], eventKey: 'engagement.survey_open', title: 'We would like your view', body: String(s.title), entityType: 'engagement.survey', entityId: id }); asked++; }
    }
    for (const role of audience.roles ?? []) await this.notifications.notifyRole(schoolId, role, { channels: ['in_app'], eventKey: 'engagement.survey_open', title: 'A survey is open', body: String(s.title), entityType: 'engagement.survey', entityId: id });
    return { id, asked };
  }
  async answerSurvey(schoolId: string, id: string, answers: Record<string, unknown>, submittedBy?: string | null) {
    const s = await this.db.findOne<Row>('surveys', { id, school_id: schoolId });
    if (!s) throw notFound('survey');
    if (s.status !== 'open') throw new HttpError(409, 'this survey is not open', 'closed');
    if (s.closes_at && String(s.closes_at) < nowSql()) throw new HttpError(409, 'this survey has closed', 'closed');
    const anonymous = !!Number(s.is_anonymous);
    if (!anonymous && submittedBy && (await this.db.findOne('form_submissions', { form_id: String(s.form_id), submitted_by: submittedBy }))) throw new HttpError(409, 'you have already answered this survey', 'duplicate');
    const submissionId = ulid();
    await this.db.insert('form_submissions', { id: submissionId, school_id: schoolId, form_id: String(s.form_id), submitted_by: anonymous ? null : submittedBy ?? null, entity_type: 'engagement.survey', entity_id: id, answers: answers as never, ip: null });
    return { id: submissionId, anonymous };
  }
  /** Counts per choice and an average per rating; free text is returned as it was written. */
  async surveyResults(schoolId: string, id: string) {
    const s = await this.db.findOne<Row>('surveys', { id, school_id: schoolId });
    if (!s) throw notFound('survey');
    const form = await this.db.findOne<Row>('form_definitions', { id: String(s.form_id) });
    const fields = json<{ fields: { key: string; label: string; type?: string }[] }>(form?.schema_json)?.fields ?? [];
    const rows = await this.db.findMany<Row>('form_submissions', { form_id: String(s.form_id) }, { limit: 5000 });
    const summary = fields.map(f => {
      const values = rows.map(r => (json<Record<string, unknown>>(r.answers) ?? {})[f.key]).filter(v => v != null);
      if (f.type === 'rating') {
        const nums = values.map(Number).filter(n => !Number.isNaN(n));
        return { key: f.key, label: f.label, type: f.type, answers: nums.length, average: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null };
      }
      if (f.type === 'choice' || f.type === 'yes_no') {
        const counts: Record<string, number> = {};
        for (const v of values) counts[String(v)] = (counts[String(v)] ?? 0) + 1;
        return { key: f.key, label: f.label, type: f.type, answers: values.length, counts };
      }
      return { key: f.key, label: f.label, type: f.type ?? 'text', answers: values.length, texts: values.slice(0, 200).map(String) };
    });
    await this.db.update('surveys', { results: { responses: rows.length, summary } as never, updated_at: nowSql() }, { id });
    return { responses: rows.length, anonymous: !!Number(s.is_anonymous), summary };
  }
  async surveys(schoolId: string) { return this.db.findMany<Row>('surveys', { school_id: schoolId }, { orderBy: 'created_at DESC', limit: 100 }); }

  // ---------- newsletters ----------
  async createNewsletter(schoolId: string, n: { title: string; body: string; channel?: 'email' | 'whatsapp' | 'sms'; audience?: { guardians?: boolean; roles?: string[] }; scheduledFor?: string | null }) {
    const id = ulid();
    await this.db.insert('newsletters', { id, school_id: schoolId, title: n.title, body: n.body, audience: (n.audience ?? { guardians: true }) as never, channel: n.channel ?? 'email', scheduled_for: n.scheduledFor ?? null, sent_at: null, stats: null, status: n.scheduledFor ? 'scheduled' : 'draft' });
    return id;
  }
  async sendNewsletter(schoolId: string, id: string) {
    const n = await this.db.findOne<Row>('newsletters', { id, school_id: schoolId });
    if (!n) throw notFound('newsletter');
    if (n.sent_at) return { id, alreadySent: true, sent: Number(json<{ sent: number }>(n.stats)?.sent ?? 0) };
    const channel = String(n.channel) as 'email' | 'sms';
    const audience = json<{ guardians?: boolean; roles?: string[] }>(n.audience) ?? { guardians: true };
    let sent = 0;
    if (audience.guardians !== false) {
      const users = await this.db.query<{ id: string; email: string | null; phone: string | null }>(`SELECT id, email, phone FROM users WHERE school_id = ? AND user_type = 'guardian' AND is_active = TRUE LIMIT 5000`, [schoolId]);
      for (const u of users) {
        const address = channel === 'email' ? u.email : u.phone;
        if (!address) continue;
        await this.notifications.notify({ schoolId, userId: u.id, address, channels: [channel], eventKey: 'engagement.newsletter', title: String(n.title), body: String(n.body).slice(0, 2000), entityType: 'engagement.newsletter', entityId: id });
        sent++;
      }
    }
    await this.db.update('newsletters', { status: 'sent', sent_at: nowSql(), stats: { sent } as never, updated_at: nowSql() }, { id });
    return { id, sent };
  }
  async newsletters(schoolId: string) { return this.db.findMany<Row>('newsletters', { school_id: schoolId }, { orderBy: 'created_at DESC', limit: 100 }); }

  // ---------- events ----------
  async createEvent(schoolId: string, e: { title: string; eventType: 'sports' | 'cultural' | 'ptm' | 'seminar' | 'trip' | 'ceremony' | 'competition' | 'workshop' | 'other'; startsAt: string; endsAt?: string | null; venue?: string | null; description?: string | null; rsvpRequired?: boolean; ticketPrice?: number | null; ticketLimit?: number | null; organiserId?: string | null }) {
    const id = ulid();
    await this.db.insert('events', { id, school_id: schoolId, calendar_event_id: null, title: e.title, description: e.description ?? null, event_type: e.eventType, starts_at: e.startsAt, ends_at: e.endsAt ?? null, venue: e.venue ?? null, room_id: null, audience: null, rsvp_required: !!e.rsvpRequired, ticket_price: e.ticketPrice ?? null, ticket_limit: e.ticketLimit ?? null, fee_head_id: null, banner_file_id: null, organiser_id: e.organiserId ?? null, status: 'scheduled', feedback_form_id: null });
    await this.outbox.emitNow({ type: 'event.created', schoolId, aggregateType: 'engagement.event', aggregateId: id, payload: { eventId: id, title: e.title, startsAt: e.startsAt } });
    return id;
  }
  async announceEvent(schoolId: string, id: string) {
    const e = await this.db.findOne<Row>('events', { id, school_id: schoolId });
    if (!e) throw notFound('event');
    const users = await this.db.query<{ id: string }>(`SELECT id FROM users WHERE school_id = ? AND user_type = 'guardian' AND is_active = TRUE LIMIT 5000`, [schoolId]);
    for (const u of users) await this.notifications.notify({ schoolId, userId: u.id, channels: ['push', 'in_app'], eventKey: 'engagement.event', title: String(e.title), body: `${String(e.starts_at).slice(0, 16)}${e.venue ? ` at ${e.venue}` : ''}. ${Number(e.rsvp_required) ? 'Please let us know if you are coming.' : ''}`.trim(), entityType: 'engagement.event', entityId: id });
    return { id, told: users.length };
  }
  async rsvp(schoolId: string, eventId: string, userId: string, response: 'yes' | 'no' | 'maybe', guests = 0) {
    const e = await this.db.findOne<Row>('events', { id: eventId, school_id: schoolId });
    if (!e) throw notFound('event');
    const ex = await this.db.findOne<Row>('event_rsvps', { event_id: eventId, user_id: userId });
    const row = { school_id: schoolId, event_id: eventId, user_id: userId, student_id: null, response, guests, responded_at: nowSql() };
    if (ex) await this.db.update('event_rsvps', row, { id: String(ex.id) });
    else await this.db.insert('event_rsvps', { id: ulid(), ...row });
    return { eventId, response, guests };
  }
  /** A ticket is a QR the gate scans once; the limit is enforced here, not at the door. */
  async issueTicket(schoolId: string, eventId: string, t: { holderUserId?: string | null; holderName?: string | null; quantity?: number; paymentId?: string | null }) {
    const e = await this.db.findOne<Row>('events', { id: eventId, school_id: schoolId });
    if (!e) throw notFound('event');
    const quantity = t.quantity ?? 1;
    if (e.ticket_limit) {
      const sold = Number((await this.db.query<{ n: number }>(`SELECT COALESCE(SUM(quantity), 0) AS n FROM event_tickets WHERE event_id = ? AND status <> 'cancelled'`, [eventId]))[0]?.n ?? 0);
      if (sold + quantity > Number(e.ticket_limit)) throw new HttpError(409, `only ${Math.max(0, Number(e.ticket_limit) - sold)} ticket(s) left`, 'sold_out');
    }
    const id = ulid();
    const qr = randomBytes(8).toString('hex').toUpperCase();
    const amount = Number(e.ticket_price ?? 0) * quantity;
    await this.db.insert('event_tickets', { id, school_id: schoolId, event_id: eventId, holder_user_id: t.holderUserId ?? null, holder_name: t.holderName ?? null, quantity, amount, payment_id: t.paymentId ?? null, qr_code: qr, checked_in_at: null, status: amount > 0 && !t.paymentId ? 'reserved' : 'paid' });
    return { id, qr, amount };
  }
  async checkInTicket(schoolId: string, qr: string) {
    const t = await this.db.findOne<Row>('event_tickets', { school_id: schoolId, qr_code: qr.trim().toUpperCase() });
    if (!t) throw notFound('ticket');
    if (t.checked_in_at) throw new HttpError(409, `this ticket was already used at ${String(t.checked_in_at).slice(11, 16)}`, 'used');
    if (t.status === 'cancelled') throw new HttpError(409, 'this ticket was cancelled', 'cancelled');
    await this.db.update('event_tickets', { checked_in_at: nowSql(), status: 'used', updated_at: nowSql() }, { id: String(t.id) });
    return { id: String(t.id), quantity: Number(t.quantity), holder: (t.holder_name as string) ?? null };
  }
  async events(schoolId: string, from?: string) {
    const where = from ? ' AND starts_at >= ?' : '';
    return this.db.query<Row>(`SELECT e.*, (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id AND r.response = 'yes') AS coming,
      (SELECT COALESCE(SUM(quantity), 0) FROM event_tickets t WHERE t.event_id = e.id AND t.status <> 'cancelled') AS tickets
      FROM events e WHERE e.school_id = ?${where} ORDER BY e.starts_at DESC LIMIT 200`, from ? [schoolId, from] : [schoolId]);
  }

  // ---------- what happens inside an event ----------
  /** The programme: what happens when, so the printed sheet and the app say the same thing. */
  async setSchedule(schoolId: string, eventId: string, items: { startsAt: string; title: string; presenter?: string | null }[]) {
    if (!(await this.db.findOne('events', { id: eventId, school_id: schoolId }))) throw notFound('event');
    await this.db.delete('event_schedule_items', { event_id: eventId });
    const sorted = [...items].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    if (sorted.length) await this.db.insertMany('event_schedule_items', sorted.map((i, n) => ({ id: ulid(), school_id: schoolId, event_id: eventId, starts_at: i.startsAt, title: i.title.slice(0, 200), presenter: i.presenter ?? null, sequence: n + 1 })));
    return { eventId, items: sorted.length };
  }
  async schedule(schoolId: string, eventId: string) {
    return this.db.findMany<Row>('event_schedule_items', { school_id: schoolId, event_id: eventId }, { orderBy: 'sequence ASC' });
  }
  /**
   * Volunteering. Anyone may offer; the organiser confirms. A confirmation is what tells somebody to
   * turn up, so it is the only thing that notifies — an application does not.
   */
  async volunteer(schoolId: string, eventId: string, userId: string, role?: string | null) {
    const event = await this.db.findOne<Row>('events', { id: eventId, school_id: schoolId });
    if (!event) throw notFound('event');
    const ex = await this.db.findOne<Row>('event_volunteers', { event_id: eventId, user_id: userId });
    if (ex) { await this.db.update('event_volunteers', { role: role ?? ex.role, status: 'applied' }, { id: String(ex.id) }); return { id: String(ex.id), status: 'applied' as const }; }
    const id = ulid();
    await this.db.insert('event_volunteers', { id, school_id: schoolId, event_id: eventId, user_id: userId, role: role ?? null, status: 'applied' });
    return { id, status: 'applied' as const };
  }
  async decideVolunteer(schoolId: string, volunteerId: string, status: 'confirmed' | 'declined') {
    const v = await this.db.findOne<Row>('event_volunteers', { id: volunteerId, school_id: schoolId });
    if (!v) throw notFound('volunteer');
    await this.db.update('event_volunteers', { status }, { id: volunteerId });
    if (status === 'confirmed') {
      const event = await this.db.findOne<Row>('events', { id: String(v.event_id) });
      await this.notifications.notify({ schoolId, userId: String(v.user_id), channels: ['in_app', 'push'], eventKey: 'engagement.volunteer_confirmed', title: 'You are on the team', body: `${event?.title} on ${String(event?.starts_at).slice(0, 16)}${v.role ? ` — ${v.role}` : ''}.`, entityType: 'engagement.event', entityId: String(v.event_id) });
    }
    return { id: volunteerId, status };
  }
  async volunteers(schoolId: string, eventId: string) {
    return this.db.query<Row>(`SELECT v.*, u.display_name, u.phone FROM event_volunteers v JOIN users u ON u.id = v.user_id WHERE v.school_id = ? AND v.event_id = ? ORDER BY v.status, u.display_name`, [schoolId, eventId]);
  }

  // ---------- competitions ----------
  /**
   * Competitions, from the intra-house quiz to a national olympiad. Recording a result does three
   * things at once, because otherwise two of them never happen: it goes on the child's portfolio, it
   * adds to the house table, and — for a placed competitor — it prints a certificate they can keep.
   */
  async createCompetition(schoolId: string, c: { name: string; kind?: 'sports' | 'academic' | 'cultural' | 'science' | 'debate' | 'olympiad' | 'other'; level?: 'intra' | 'inter_school' | 'district' | 'national' | 'international'; heldOn?: string | null; venue?: string | null; organiser?: string | null; eventId?: string | null }) {
    const id = ulid();
    await this.db.insert('competitions', { id, school_id: schoolId, name: c.name, kind: c.kind ?? 'other', level: c.level ?? 'intra', held_on: c.heldOn ?? null, venue: c.venue ?? null, organiser: c.organiser ?? null, event_id: c.eventId ?? null });
    return id;
  }
  async competitions(schoolId: string) {
    return this.db.query<Row>(`SELECT c.*, (SELECT COUNT(*) FROM competition_results r WHERE r.competition_id = c.id) AS entries FROM competitions c WHERE c.school_id = ? ORDER BY c.held_on DESC, c.created_at DESC LIMIT 200`, [schoolId]);
  }
  async recordResults(schoolId: string, competitionId: string, rows: { studentId?: string | null; clubId?: string | null; houseId?: string | null; position?: number | null; award?: string | null; points?: number }[], opts: { certificates?: boolean } = {}) {
    const competition = await this.db.findOne<Row>('competitions', { id: competitionId, school_id: schoolId });
    if (!competition) throw notFound('competition');
    let saved = 0, certificates = 0;
    for (const r of rows) {
      if (!r.studentId && !r.clubId && !r.houseId) throw badRequest('a result belongs to a student, a club or a house');
      const points = r.points ?? (r.position === 1 ? 10 : r.position === 2 ? 6 : r.position === 3 ? 3 : 1);
      const ex = r.studentId ? await this.db.findOne<Row>('competition_results', { competition_id: competitionId, student_id: r.studentId }) : null;
      const id = ex ? String(ex.id) : ulid();
      const row = { school_id: schoolId, competition_id: competitionId, student_id: r.studentId ?? null, club_id: r.clubId ?? null, house_id: r.houseId ?? null, position: r.position ?? null, award: r.award ?? null, points };
      if (ex) await this.db.update('competition_results', row, { id });
      else await this.db.insert('competition_results', { id, ...row });
      saved++;
      // the house table is a ledger, so the same competition never adds its points twice
      const house = r.houseId ?? (r.studentId ? (await this.db.findOne<Row>('students', { id: r.studentId }))?.house_id as string | undefined : undefined);
      if (house && !(await this.db.findOne('house_points', { source_type: 'engagement.competition', source_id: id }))) {
        await this.awardHousePoints(schoolId, { houseId: String(house), studentId: r.studentId ?? null, points, reason: `${competition.name}${r.position ? ` — position ${r.position}` : ''}`, sourceType: 'engagement.competition', sourceId: id });
      }
      if (r.studentId && !ex) {
        await this.addAchievement(schoolId, { studentId: r.studentId, title: `${competition.name}${r.award ? ` — ${r.award}` : r.position ? ` — position ${r.position}` : ''}`, category: String(competition.kind), achievedOn: (competition.held_on as string) ?? nowSql().slice(0, 10), isPublic: true });
      }
      if (opts.certificates && r.studentId && r.position && r.position <= 3) {
        const student = await this.db.findOne<Row>('students', { id: r.studentId });
        const issued = await this.documents.issue(schoolId, {
          docType: 'certificate', personType: 'student', studentId: r.studentId,
          data: { name: `${student?.first_name ?? ''} ${student?.last_name ?? ''}`.trim(), admission_no: String(student?.admission_no ?? ''), course: `${competition.name} (${competition.level})`, completed_on: String(competition.held_on ?? nowSql()).slice(0, 10) },
          entityType: 'engagement.competition', entityId: competitionId,
        });
        await this.db.update('competition_results', { certificate_doc_id: issued.id }, { id });
        certificates++;
      }
    }
    await this.outbox.emitNow({ type: 'competition.results_recorded', schoolId, aggregateType: 'engagement.competition', aggregateId: competitionId, payload: { competitionId, name: String(competition.name), results: saved } });
    return { saved, certificates };
  }
  async competitionResults(schoolId: string, competitionId: string) {
    return this.db.query<Row>(`SELECT r.*, s.first_name, s.last_name, s.admission_no, h.name AS house_name, c.name AS club_name FROM competition_results r LEFT JOIN students s ON s.id = r.student_id LEFT JOIN houses h ON h.id = r.house_id LEFT JOIN clubs c ON c.id = r.club_id WHERE r.school_id = ? AND r.competition_id = ? ORDER BY r.position, r.points DESC`, [schoolId, competitionId]);
  }

  // ---------- clubs, houses, portfolio ----------
  async createClub(schoolId: string, c: { name: string; category?: 'academic' | 'sports' | 'arts' | 'social' | 'tech' | 'religious' | 'other'; advisorId?: string | null; meetingSchedule?: string | null; description?: string | null }) {
    const id = ulid();
    await this.db.insert('clubs', { id, school_id: schoolId, name: c.name, category: c.category ?? 'other', advisor_id: c.advisorId ?? null, description: c.description ?? null, meeting_schedule: c.meetingSchedule ?? null, status: 'active' });
    return id;
  }
  async joinClub(schoolId: string, clubId: string, studentId: string, role: 'member' | 'secretary' | 'president' | 'captain' = 'member') {
    if (await this.db.findOne('club_memberships', { club_id: clubId, student_id: studentId })) throw new HttpError(409, 'already a member', 'duplicate');
    const id = ulid();
    await this.db.insert('club_memberships', { id, school_id: schoolId, club_id: clubId, student_id: studentId, role, joined_on: nowSql().slice(0, 10), left_on: null });
    return id;
  }
  async clubs(schoolId: string) {
    return this.db.query<Row>(`SELECT c.*, (SELECT COUNT(*) FROM club_memberships m WHERE m.club_id = c.id AND m.left_on IS NULL) AS members FROM clubs c WHERE c.school_id = ? ORDER BY c.name`, [schoolId]);
  }
  async awardHousePoints(schoolId: string, p: { houseId: string; studentId?: string | null; points: number; reason: string; sourceType?: string | null; sourceId?: string | null; awardedBy?: string | null }) {
    const id = ulid();
    await this.db.insert('house_points', { id, school_id: schoolId, house_id: p.houseId, student_id: p.studentId ?? null, points: p.points, reason: p.reason.slice(0, 160), source_type: p.sourceType ?? null, source_id: p.sourceId ?? null, awarded_by: p.awardedBy ?? null, awarded_at: nowSql() });
    return id;
  }
  async houseTable(schoolId: string) {
    return this.db.query<Row>(`SELECT h.id, h.name, h.color, COALESCE(SUM(p.points), 0) AS points FROM houses h LEFT JOIN house_points p ON p.house_id = h.id WHERE h.school_id = ? GROUP BY h.id, h.name, h.color ORDER BY points DESC`, [schoolId]);
  }
  async addAchievement(schoolId: string, a: { studentId: string; title: string; category?: string | null; achievedOn?: string | null; description?: string | null; verifiedBy?: string | null; isPublic?: boolean }) {
    const id = ulid();
    await this.db.insert('achievements', { id, school_id: schoolId, student_id: a.studentId, title: a.title, category: a.category ?? null, achieved_on: a.achievedOn ?? nowSql().slice(0, 10), description: a.description ?? null, file_id: null, verified_by: a.verifiedBy ?? null, is_public: !!a.isPublic });
    await this.notifyGuardians(schoolId, a.studentId, 'engagement.achievement', 'Something to be proud of', `${a.title}`, id);
    return id;
  }
  async awardBadge(schoolId: string, badgeId: string, studentId: string, awardedBy?: string | null) {
    if (await this.db.findOne('student_badges', { badge_id: badgeId, student_id: studentId })) return null;
    const id = ulid();
    await this.db.insert('student_badges', { id, school_id: schoolId, badge_id: badgeId, student_id: studentId, awarded_by: awardedBy ?? null, awarded_at: nowSql() });
    const badge = await this.db.findOne<Row>('skill_badges', { id: badgeId });
    await this.notifyGuardians(schoolId, studentId, 'engagement.badge', 'A badge earned', `${badge?.name}`, id);
    return id;
  }
  async portfolio(schoolId: string, studentId: string) {
    const [achievements, badges, clubs, competitions] = await Promise.all([
      this.db.findMany<Row>('achievements', { school_id: schoolId, student_id: studentId }, { orderBy: 'achieved_on DESC', limit: 100 }),
      this.db.query<Row>(`SELECT b.*, k.name, k.criteria FROM student_badges b JOIN skill_badges k ON k.id = b.badge_id WHERE b.school_id = ? AND b.student_id = ? ORDER BY b.awarded_at DESC`, [schoolId, studentId]),
      this.db.query<Row>(`SELECT m.*, c.name AS club_name, c.category FROM club_memberships m JOIN clubs c ON c.id = m.club_id WHERE m.school_id = ? AND m.student_id = ?`, [schoolId, studentId]),
      this.db.query<Row>(`SELECT r.*, c.name AS competition_name, c.level FROM competition_results r JOIN competitions c ON c.id = r.competition_id WHERE r.school_id = ? AND r.student_id = ? ORDER BY c.held_on DESC`, [schoolId, studentId]),
    ]);
    return { achievements, badges, clubs, competitions };
  }

  private async notifyGuardians(schoolId: string, studentId: string, eventKey: string, title: string, body: string, entityId: string) {
    const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [studentId]);
    for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['push', 'in_app'], eventKey, title, body, entityType: 'engagement.achievement', entityId });
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // M5: one message a week per guardian, with the week that actually happened
      'comms.weekly_digest': async ({ schoolId }) => {
        const to = nowSql().slice(0, 10), from = addDays(to, -7);
        const children = await this.db.query<Row>(`SELECT DISTINCT sg.student_id, g.user_id, g.phone, s.first_name FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id JOIN students s ON s.id = sg.student_id
          WHERE g.school_id = ? AND sg.receives_notifications = TRUE AND s.status = 'active' AND g.user_id IS NOT NULL LIMIT 5000`, [schoolId]);
        let sent = 0;
        for (const c of children) {
          const attendance = await this.db.query<{ present: number; total: number }>(`SELECT SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS present, COUNT(*) AS total FROM student_attendance WHERE student_id = ? AND on_date BETWEEN ? AND ?`, [String(c.student_id), from, to]);
          const homework = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM assignments a JOIN student_enrollments e ON e.section_id = a.section_id WHERE e.student_id = ? AND a.due_at BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.student_id = e.student_id)`, [String(c.student_id), `${from} 00:00:00`, `${to} 23:59:59`]);
          const dues = await this.db.query<{ due: number }>(`SELECT COALESCE(SUM(balance), 0) AS due FROM invoices WHERE student_id = ? AND balance > 0`, [String(c.student_id)]);
          const present = Number(attendance[0]?.present ?? 0), total = Number(attendance[0]?.total ?? 0);
          if (!total && !Number(homework[0]?.n) && !Number(dues[0]?.due)) continue;    // nothing to say is better than a hollow message
          await this.notifications.notify({
            schoolId, userId: String(c.user_id), address: String(c.phone), channels: ['push', 'in_app'], eventKey: 'engagement.weekly_digest',
            title: `${c.first_name}: this week`, body: `Attendance ${total ? `${present}/${total} days` : 'not marked'}${Number(homework[0]?.n) ? ` · ${homework[0]!.n} homework not handed in` : ''}${Number(dues[0]?.due) ? ` · ${Number(dues[0]!.due)} outstanding` : ''}.`,
            entityType: 'people.student', entityId: String(c.student_id),
          });
          sent++;
        }
        return { sent };
      },
    };
  }
}

const addDays = (date: string, days: number) => { const d = new Date(`${date.slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
