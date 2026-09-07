import { randomBytes } from 'node:crypto';
import type { Db, Row } from '@pathshala/db';
import { nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { NumberingService } from './numbering.js';
import type { TaskService } from '../tasks.js';
import { HttpError, badRequest, notFound } from '../context.js';

/** Appends a line to a running note, unless it repeats the line already at the end (a retried step). */
function appendLine(existing: string | null, line: string | null) {
  if (!line) return existing;
  const lines = (existing ?? '').split('\n').filter(Boolean);
  if (lines.at(-1) === line) return existing;
  lines.push(line);
  return lines.join('\n').slice(-4000);
}

/** How long a ticket may sit before it breaches, by priority. */
const SLA_HOURS: Record<string, number> = { urgent: 4, high: 24, normal: 48, low: 96 };
/** Which role a complaint lands on, by what it is about. */
const OWNER_ROLE: Record<string, string> = { fees: 'accountant', transport: 'admin', hostel: 'admin', academic: 'principal', staff_behaviour: 'principal', facility: 'admin', safety: 'principal', it: 'admin', other: 'admin' };

/**
 * Front office: the visitor book with a badge and a push to the person being visited, gate passes
 * for early pickup that only a guardian authorised to collect the child can use, the call and post
 * registers, the helpdesk with a deadline per priority and an escalation when it passes, and lost
 * property.
 */
export class FrontOfficeService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService, private numbering: NumberingService, private tasks: TaskService) {}

  // ---------- visitors ----------
  /** N7: the host is told at once; the badge number is what the visitor wears. */
  async checkIn(schoolId: string, v: { visitorName: string; phone?: string | null; idProof?: string | null; purpose?: 'admission' | 'meeting' | 'delivery' | 'pickup' | 'interview' | 'vendor' | 'other'; toMeetStaffId?: string | null; studentId?: string | null; photoFileId?: string | null; loggedBy?: string | null }) {
    const id = ulid();
    const badge = await this.numbering.next(schoolId, 'visitor_badge_no', { prefix: 'V-', padding: 4, resetYearly: false });
    await this.db.insert('visitor_logs', { id, school_id: schoolId, campus_id: null, visitor_name: v.visitorName, phone: v.phone ?? null, id_proof: v.idProof ?? null, purpose: v.purpose ?? 'other', to_meet_staff_id: v.toMeetStaffId ?? null, student_id: v.studentId ?? null, badge_no: badge, photo_file_id: v.photoFileId ?? null, in_at: nowSql(), out_at: null, host_notified_at: null, logged_by: v.loggedBy ?? null });
    if (v.toMeetStaffId) {
      const host = await this.db.findOne<{ user_id: string | null; first_name: string }>('staff', { id: v.toMeetStaffId, school_id: schoolId });
      if (host?.user_id) {
        await this.notifications.notify({ schoolId, userId: host.user_id, channels: ['push', 'in_app'], eventKey: 'frontoffice.visitor_waiting', data: { visitor: v.visitorName, badge }, title: 'A visitor is waiting', body: `${v.visitorName} is at reception to see you (badge ${badge}).`, entityType: 'frontoffice.visitor', entityId: id });
        await this.db.update('visitor_logs', { host_notified_at: nowSql(), updated_at: nowSql() }, { id });
      }
    }
    return { id, badgeNo: badge };
  }
  async checkOut(schoolId: string, id: string) {
    const n = await this.db.update('visitor_logs', { out_at: nowSql(), updated_at: nowSql() }, { id, school_id: schoolId });
    if (!n) throw notFound('visitor');
    return { id, outAt: nowSql() };
  }
  async visitors(schoolId: string, onDate = nowSql().slice(0, 10)) {
    return this.db.query<Row>(`SELECT v.*, s.first_name AS host_first, s.last_name AS host_last FROM visitor_logs v LEFT JOIN staff s ON s.id = v.to_meet_staff_id WHERE v.school_id = ? AND v.in_at >= ? AND v.in_at < ? ORDER BY v.in_at DESC`, [schoolId, `${onDate} 00:00:00`, `${onDate} 23:59:59`]);
  }

  // ---------- gate passes ----------
  /**
   * Early pickup. A child is only released to somebody the guardians have authorised to collect
   * them; anyone else has to be approved by a person, not by this code.
   */
  async gatePass(schoolId: string, g: { personType: 'student' | 'staff'; studentId?: string | null; staffId?: string | null; reason: string; outAt?: string; expectedIn?: string | null; pickedBy?: string | null; pickerPhone?: string | null; approvedBy?: string | null }) {
    if (g.personType === 'student' && !g.studentId) throw badRequest('which student?');
    let authorisationId: string | null = null;
    if (g.personType === 'student' && g.pickerPhone) {
      const today = nowSql().slice(0, 10);
      const auth = await this.db.query<Row>(`SELECT * FROM pickup_authorisations WHERE school_id = ? AND student_id = ? AND phone = ? AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)`, [schoolId, String(g.studentId), g.pickerPhone, today, today]);
      const guardian = await this.db.query<Row>(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ? AND g.phone = ? AND sg.can_pickup = TRUE`, [String(g.studentId), g.pickerPhone]);
      if (!auth[0] && !guardian[0]) throw new HttpError(403, 'that number is not authorised to collect this child', 'not_authorised');
      authorisationId = auth[0] ? String(auth[0].id) : null;
    }
    const id = ulid();
    const qr = randomBytes(8).toString('hex').toUpperCase();
    await this.db.insert('gate_passes', { id, school_id: schoolId, person_type: g.personType, student_id: g.studentId ?? null, staff_id: g.staffId ?? null, reason: g.reason.slice(0, 160), out_at: g.outAt ?? nowSql(), expected_in: g.expectedIn ?? null, actual_in: null, picked_by: g.pickedBy ?? null, authorisation_id: authorisationId, approved_by: g.approvedBy ?? null, qr_code: qr, status: 'approved' });
    if (g.personType === 'student' && g.studentId) {
      const student = await this.db.findOne<Row>('students', { id: g.studentId });
      const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [g.studentId]);
      for (const gu of guardians) await this.notifications.notify({ schoolId, userId: gu.user_id, address: gu.phone, channels: ['sms', 'push', 'in_app'], eventKey: 'frontoffice.gate_pass', data: { student: String(student?.first_name ?? '') }, title: 'Early leave', body: `${student?.first_name} left at ${nowSql().slice(11, 16)} with ${g.pickedBy ?? 'a guardian'}. Reason: ${g.reason}.`, entityType: 'frontoffice.gate_pass', entityId: id });
    }
    return { id, qr };
  }
  async returnFromPass(schoolId: string, id: string) {
    const n = await this.db.update('gate_passes', { status: 'returned', actual_in: nowSql(), updated_at: nowSql() }, { id, school_id: schoolId });
    if (!n) throw notFound('gate pass');
    return { id };
  }
  async gatePasses(schoolId: string, onDate = nowSql().slice(0, 10)) {
    return this.db.query<Row>(`SELECT p.*, s.first_name, s.last_name FROM gate_passes p LEFT JOIN students s ON s.id = p.student_id WHERE p.school_id = ? AND p.out_at >= ? AND p.out_at < ? ORDER BY p.out_at DESC`, [schoolId, `${onDate} 00:00:00`, `${onDate} 23:59:59`]);
  }

  // ---------- registers ----------
  async logCall(schoolId: string, c: { direction: 'inbound' | 'outbound'; callerName?: string | null; phone: string; purpose?: string | null; notes?: string | null; followUpAt?: string | null; loggedBy?: string | null }) {
    const id = ulid();
    await this.db.insert('call_logs', { id, school_id: schoolId, direction: c.direction, caller_name: c.callerName ?? null, phone: c.phone, purpose: c.purpose ?? null, notes: c.notes ?? null, related_type: null, related_id: null, follow_up_at: c.followUpAt ?? null, logged_by: c.loggedBy ?? null, called_at: nowSql() });
    if (c.followUpAt) await this.tasks.create({ schoolId, title: `Call back ${c.callerName ?? c.phone}`, taskType: 'frontoffice.callback', assignedRole: 'admin', entityType: 'frontoffice.call', entityId: id, dueAt: c.followUpAt });
    return id;
  }
  /**
   * Upserts one line of the call register and keeps it up to date while the call is still going on.
   * The voice line uses it: a caller works through the menu over several HTTP requests, and the
   * office should see one line saying what was asked and what was answered, not one line per key
   * pressed. `id` therefore comes from the caller's own call id, not from `ulid()`.
   *
   * Two things make a replayed step harmless: a note that repeats the last line is not written
   * again, and a follow-up is only ever set once — so the callback task is raised once however many
   * times a gateway retries.
   */
  async recordCall(schoolId: string, id: string, c: { direction: 'inbound' | 'outbound'; phone: string; callerName?: string | null; purpose?: string | null; note?: string | null; followUpAt?: string | null; relatedType?: string | null; relatedId?: string | null }) {
    let existing = await this.db.findOne<Row>('call_logs', { id, school_id: schoolId });
    if (!existing) {
      try {
        await this.db.insert('call_logs', { id, school_id: schoolId, direction: c.direction, caller_name: c.callerName ?? null, phone: c.phone, purpose: c.purpose ?? null, notes: appendLine(null, c.note ?? null), related_type: c.relatedType ?? null, related_id: c.relatedId ?? null, follow_up_at: c.followUpAt ?? null, logged_by: null, called_at: nowSql() });
      } catch (e) {
        // a step the gateway timed out on and sent again can race this one to the same row; if the
        // row is there now, carry on and update it, and if it is not, the insert failed for a real reason
        existing = await this.db.findOne<Row>('call_logs', { id, school_id: schoolId });
        if (!existing) throw e;
      }
    }
    const notes = appendLine((existing?.notes as string) ?? null, c.note ?? null);
    if (existing) {
      const set: Row = { updated_at: nowSql(), notes };
      if (c.purpose) set.purpose = c.purpose;
      if (c.callerName) set.caller_name = c.callerName;
      if (c.relatedId) set.related_id = c.relatedId;
      if (c.followUpAt && !existing.follow_up_at) set.follow_up_at = c.followUpAt;
      await this.db.update('call_logs', set, { id });
    }
    const followUpRaised = !!c.followUpAt && !existing?.follow_up_at;
    if (followUpRaised) await this.tasks.create({ schoolId, title: `Call back ${c.callerName || c.phone}`, taskType: 'frontoffice.callback', assignedRole: 'admin', entityType: 'frontoffice.call', entityId: id, dueAt: c.followUpAt });
    return { id, created: !existing, followUpRaised };
  }
  async calls(schoolId: string, limit = 200, relatedType?: string) {
    const where: Row = { school_id: schoolId };
    if (relatedType) where.related_type = relatedType;
    return this.db.findMany<Row>('call_logs', where, { orderBy: 'called_at DESC', limit });
  }
  async logPost(schoolId: string, p: { direction: 'dispatch' | 'receive'; referenceNo?: string | null; fromParty?: string | null; toParty?: string | null; subject?: string | null; recordDate?: string; fileId?: string | null; loggedBy?: string | null }) {
    const id = ulid();
    await this.db.insert('postal_records', { id, school_id: schoolId, direction: p.direction, reference_no: p.referenceNo ?? null, from_party: p.fromParty ?? null, to_party: p.toParty ?? null, subject: p.subject ?? null, record_date: p.recordDate ?? nowSql().slice(0, 10), file_id: p.fileId ?? null, logged_by: p.loggedBy ?? null });
    return id;
  }
  async post(schoolId: string, limit = 200) { return this.db.findMany<Row>('postal_records', { school_id: schoolId }, { orderBy: 'record_date DESC', limit }); }

  // ---------- helpdesk ----------
  /** N8: a ticket number, an owner by category, and a deadline set by its priority. */
  async raiseComplaint(schoolId: string, c: { category: 'academic' | 'fees' | 'transport' | 'hostel' | 'staff_behaviour' | 'facility' | 'safety' | 'it' | 'other'; subject: string; description: string; priority?: 'low' | 'normal' | 'high' | 'urgent'; complainantUserId?: string | null; complainantName?: string | null; complainantPhone?: string | null; studentId?: string | null }) {
    const id = ulid();
    const ticketNo = await this.numbering.next(schoolId, 'ticket_no', { prefix: 'TKT-', padding: 5, resetYearly: true });
    const priority = c.priority ?? (c.category === 'safety' ? 'urgent' : 'normal');
    const slaDue = nowSql(new Date(Date.now() + (SLA_HOURS[priority] ?? 48) * 3600_000));
    const role = OWNER_ROLE[c.category] ?? 'admin';
    const owner = await this.db.query<{ id: string }>(`SELECT s.id FROM staff s JOIN users u ON u.id = s.user_id JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE s.school_id = ? AND r.slug = ? AND s.status IN ('active','probation') ORDER BY s.id LIMIT 1`, [schoolId, role]);
    await this.db.insert('complaints', {
      id, school_id: schoolId, ticket_no: ticketNo, complainant_user_id: c.complainantUserId ?? null, complainant_name: c.complainantName ?? null, complainant_phone: c.complainantPhone ?? null,
      student_id: c.studentId ?? null, category: c.category, subject: c.subject.slice(0, 200), description: c.description, priority, assigned_to: owner[0]?.id ?? null,
      sla_due_at: slaDue, escalated_at: null, status: 'open', resolution: null, resolved_at: null, satisfaction: null,
    });
    await this.notifications.notifyRole(schoolId, role, { channels: ['in_app', 'push'], eventKey: 'frontoffice.complaint_raised', title: `New ${priority} ticket`, body: `${ticketNo}: ${c.subject}`, entityType: 'frontoffice.complaint', entityId: id });
    await this.outbox.emitNow({ type: 'complaint.created', schoolId, aggregateType: 'frontoffice.complaint', aggregateId: id, payload: { complaintId: id, ticketNo, category: c.category, priority, slaDueAt: slaDue } });
    return { id, ticketNo, slaDueAt: slaDue };
  }
  async updateComplaint(schoolId: string, id: string, u: { note?: string; isInternal?: boolean; status?: 'open' | 'in_progress' | 'resolved' | 'closed' | 'reopened'; resolution?: string | null; assignedTo?: string | null; byUserId?: string | null }) {
    const c = await this.db.findOne<Row>('complaints', { id, school_id: schoolId });
    if (!c) throw notFound('complaint');
    if (u.note) await this.db.insert('complaint_updates', { id: ulid(), school_id: schoolId, complaint_id: id, by_user_id: u.byUserId ?? null, note: u.note, is_internal: !!u.isInternal, created_at: nowSql() });
    const set: Row = { updated_at: nowSql() };
    if (u.status) set.status = u.status;
    if (u.assignedTo !== undefined) set.assigned_to = u.assignedTo;
    if (u.status === 'resolved' || u.status === 'closed') { set.resolution = u.resolution ?? c.resolution; set.resolved_at = nowSql(); }
    await this.db.update('complaints', set, { id });
    // the person who complained hears back, and is asked how it went
    if ((u.status === 'resolved' || u.status === 'closed') && (c.complainant_user_id || c.complainant_phone)) {
      await this.notifications.notify({ schoolId, userId: (c.complainant_user_id as string) ?? null, address: (c.complainant_phone as string) ?? null, channels: ['in_app', 'push', 'sms'], eventKey: 'frontoffice.complaint_resolved', data: { ticket: String(c.ticket_no) }, title: 'Your complaint is resolved', body: `${c.ticket_no}: ${u.resolution ?? 'resolved'}. Please rate how we did.`, entityType: 'frontoffice.complaint', entityId: id });
    }
    return { id, status: u.status ?? String(c.status) };
  }
  async rateComplaint(schoolId: string, id: string, satisfaction: number) {
    if (satisfaction < 1 || satisfaction > 5) throw badRequest('rate between 1 and 5');
    return this.db.update('complaints', { satisfaction, updated_at: nowSql() }, { id, school_id: schoolId });
  }
  async complaints(schoolId: string, f: { status?: string; category?: string; overdueOnly?: boolean } = {}) {
    const where = ['c.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.status) { where.push('c.status = ?'); params.push(f.status); }
    if (f.category) { where.push('c.category = ?'); params.push(f.category); }
    if (f.overdueOnly) { where.push(`c.status IN ('open','in_progress') AND c.sla_due_at < ?`); params.push(nowSql()); }
    return this.db.query<Row>(`SELECT c.*, s.first_name AS owner_first, s.last_name AS owner_last FROM complaints c LEFT JOIN staff s ON s.id = c.assigned_to WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT 300`, params);
  }
  async complaint(schoolId: string, id: string) {
    const c = await this.db.findOne<Row>('complaints', { id, school_id: schoolId });
    if (!c) throw notFound('complaint');
    return { complaint: c, updates: await this.db.findMany<Row>('complaint_updates', { complaint_id: id }, { orderBy: 'created_at ASC' }) };
  }

  // ---------- lost and found ----------
  async logFound(schoolId: string, f: { description: string; location?: string | null; foundAt?: string; photoFileId?: string | null }) {
    const id = ulid();
    await this.db.insert('lost_found_items', { id, school_id: schoolId, description: f.description.slice(0, 200), found_at: f.foundAt ?? nowSql(), location: f.location ?? null, photo_file_id: f.photoFileId ?? null, claimed_by: null, claimed_at: null, status: 'found' });
    return id;
  }
  async claimFound(schoolId: string, id: string, claimedBy: string) {
    const n = await this.db.update('lost_found_items', { claimed_by: claimedBy.slice(0, 160), claimed_at: nowSql(), status: 'claimed', updated_at: nowSql() }, { id, school_id: schoolId });
    if (!n) throw notFound('item');
    return { id };
  }
  async lostFound(schoolId: string) { return this.db.findMany<Row>('lost_found_items', { school_id: schoolId }, { orderBy: 'found_at DESC', limit: 200 }); }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // N8's second half: a ticket past its deadline goes up, once
      'frontoffice.sla_escalation': async ({ schoolId }) => {
        const breached = await this.db.query<Row>(`SELECT * FROM complaints WHERE school_id = ? AND status IN ('open','in_progress') AND sla_due_at < ? AND escalated_at IS NULL`, [schoolId, nowSql()]);
        for (const c of breached) {
          await this.db.update('complaints', { escalated_at: nowSql(), priority: c.priority === 'urgent' ? 'urgent' : 'high', updated_at: nowSql() }, { id: String(c.id) });
          await this.notifications.notifyRole(schoolId, 'principal', { channels: ['in_app', 'push'], eventKey: 'frontoffice.complaint_escalated', title: 'Ticket past its deadline', body: `${c.ticket_no} (${c.category}) has passed its ${c.priority} deadline: ${c.subject}`, entityType: 'frontoffice.complaint', entityId: String(c.id) });
          await this.tasks.create({ schoolId, title: `Overdue ticket ${c.ticket_no}: ${String(c.subject).slice(0, 60)}`, taskType: 'frontoffice.sla', assignedRole: 'principal', entityType: 'frontoffice.complaint', entityId: String(c.id), priority: 'high' });
        }
        return { escalated: breached.length };
      },
    };
  }
}
