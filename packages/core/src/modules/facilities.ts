import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters, ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { TaskService } from '../tasks.js';
import type { AccountingService } from './accounting.js';
import { round } from './accounting.js';
import { HttpError, badRequest, notFound } from '../context.js';

/**
 * The building itself: who has the hall on Thursday, what is broken, who cleans what, what the meter
 * says, and when the fire drill last happened.
 *
 * The rules here come from what goes wrong in a school without them. A room booking that overlaps the
 * timetable is refused, because the class was there first. A work order carries a deadline set by its
 * priority, and the ones that pass it are chased rather than forgotten. A utility reading lower than
 * the last one is refused — meters go up; a reading that goes down is a typo or a new meter, and
 * either way somebody should say so. And a drill that is overdue is the school's problem before it is
 * an inspector's.
 */
export class FacilitiesService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService,
    private tasks: TaskService, private accounting: AccountingService, private adapters: Adapters,
  ) {}

  // ---------- rooms and bookings ----------
  /**
   * Books a room. Two things can already be using it: another booking, or the timetable — and the
   * timetable wins, because a class has nowhere else to go.
   */
  async book(schoolId: string, b: { roomId: string; purpose: string; startsAt: string; endsAt: string; bookedBy: string; autoApprove?: boolean }) {
    const room = await this.db.findOne<Row>('rooms', { id: b.roomId, school_id: schoolId });
    if (!room) throw notFound('room');
    if (b.endsAt <= b.startsAt) throw badRequest('the booking ends before it starts');
    const clash = await this.db.query<Row>(`SELECT id, purpose, starts_at, ends_at FROM room_bookings WHERE school_id = ? AND room_id = ? AND status IN ('pending','approved') AND starts_at < ? AND ends_at > ? LIMIT 1`, [schoolId, b.roomId, b.endsAt, b.startsAt]);
    if (clash[0]) throw new HttpError(409, `${room.name} is already booked for ${clash[0].purpose} from ${String(clash[0].starts_at).slice(11, 16)}`, 'room_busy');
    const timetabled = await this.timetableClash(schoolId, b.roomId, b.startsAt, b.endsAt);
    if (timetabled) throw new HttpError(409, `${room.name} has ${timetabled} in the timetable at that time`, 'room_busy');
    const id = ulid();
    await this.db.insert('room_bookings', { id, school_id: schoolId, room_id: b.roomId, booked_by: b.bookedBy, purpose: b.purpose.slice(0, 160), starts_at: b.startsAt, ends_at: b.endsAt, status: b.autoApprove ? 'approved' : 'pending', approved_by: b.autoApprove ? b.bookedBy : null });
    if (!b.autoApprove) await this.notifications.notifyRole(schoolId, 'admin', { channels: ['in_app'], eventKey: 'facilities.booking_requested', title: 'Room booking to approve', body: `${room.name}: ${b.purpose} on ${b.startsAt.slice(0, 16)}.`, entityType: 'facilities.booking', entityId: id });
    return { id, status: b.autoApprove ? 'approved' : 'pending' };
  }
  /** The class that is timetabled into a room at that moment, if there is one. */
  private async timetableClash(schoolId: string, roomId: string, startsAt: string, endsAt: string) {
    const day = new Date(`${startsAt.slice(0, 10)}T00:00:00Z`).getUTCDay();
    const from = startsAt.slice(11, 19), to = endsAt.slice(11, 19);
    const rows = await this.db.query<Row>(`SELECT sub.name AS subject, c.name AS class_name FROM timetable_slots ts
      JOIN timetable_versions v ON v.id = ts.version_id AND v.status = 'published'
      JOIN periods p ON p.id = ts.period_id
      JOIN class_subjects cs ON cs.id = ts.class_subject_id JOIN subjects sub ON sub.id = cs.subject_id JOIN classes c ON c.id = cs.class_id
      WHERE ts.school_id = ? AND ts.room_id = ? AND ts.day_of_week = ? AND p.start_time < ? AND p.end_time > ? LIMIT 1`, [schoolId, roomId, day, to, from]);
    return rows[0] ? `${rows[0].class_name} ${rows[0].subject}` : null;
  }
  async decideBooking(schoolId: string, bookingId: string, status: 'approved' | 'rejected' | 'cancelled', approvedBy?: string | null) {
    const b = await this.db.findOne<Row>('room_bookings', { id: bookingId, school_id: schoolId });
    if (!b) throw notFound('booking');
    await this.db.update('room_bookings', { status, approved_by: approvedBy ?? null, updated_at: nowSql() }, { id: bookingId });
    await this.notifications.notify({ schoolId, userId: String(b.booked_by), channels: ['in_app', 'push'], eventKey: 'facilities.booking_decided', title: `Room booking ${status}`, body: `${b.purpose} on ${String(b.starts_at).slice(0, 16)} was ${status}.`, entityType: 'facilities.booking', entityId: bookingId });
    return { id: bookingId, status };
  }
  async bookings(schoolId: string, f: { from?: string; roomId?: string; status?: string } = {}) {
    const where: string[] = ['b.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.roomId) { where.push('b.room_id = ?'); params.push(f.roomId); }
    if (f.status) { where.push('b.status = ?'); params.push(f.status); }
    if (f.from) { where.push('b.ends_at >= ?'); params.push(`${f.from} 00:00:00`); }
    return this.db.query<Row>(`SELECT b.*, r.name AS room_name, u.display_name AS booked_by_name FROM room_bookings b JOIN rooms r ON r.id = b.room_id LEFT JOIN users u ON u.id = b.booked_by WHERE ${where.join(' AND ')} ORDER BY b.starts_at LIMIT 200`, params);
  }

  // ---------- work orders ----------
  /** Hours a job of each priority gets before somebody has to answer for it. */
  private static readonly SLA_HOURS: Record<string, number> = { urgent: 4, high: 24, normal: 72, low: 168 };
  /**
   * Something is broken. The deadline comes from the priority rather than from whoever is typing, and
   * the person who reported it is told when it is done — the two halves people skip by hand.
   */
  async raiseWorkOrder(schoolId: string, w: { title: string; category?: 'electrical' | 'plumbing' | 'civil' | 'it' | 'furniture' | 'cleaning' | 'other'; priority?: 'low' | 'normal' | 'high' | 'urgent'; description?: string | null; roomId?: string | null; assetId?: string | null; assignedTo?: string | null; reportedBy?: string | null; dueAt?: string | null }) {
    const priority = w.priority ?? 'normal';
    const id = ulid();
    const dueAt = w.dueAt ?? nowSql(new Date(Date.now() + (FacilitiesService.SLA_HOURS[priority] ?? 72) * 3600_000));
    await this.db.insert('work_orders', { id, school_id: schoolId, title: w.title.slice(0, 160), description: w.description ?? null, location_room_id: w.roomId ?? null, asset_id: w.assetId ?? null, category: w.category ?? 'other', priority, reported_by: w.reportedBy ?? null, assigned_to: w.assignedTo ?? null, vendor_id: null, status: w.assignedTo ? 'assigned' : 'open', due_at: dueAt, cost: null, expense_id: null, completed_at: null });
    // the work order holds a staff id; the task holds that person's user account, or nobody's
    const owner = w.assignedTo ? ((await this.db.findOne<Row>('staff', { id: w.assignedTo }))?.user_id as string) ?? null : null;
    await this.tasks.create({ schoolId, title: `Work order: ${w.title}`, description: w.description ?? null, taskType: 'maintenance', assignedTo: owner, assignedRole: owner ? null : 'admin', entityType: 'facilities.work_order', entityId: id, dueAt, priority });
    await this.outbox.emitNow({ type: 'work_order.raised', schoolId, aggregateType: 'facilities.work_order', aggregateId: id, payload: { workOrderId: id, title: w.title, category: w.category ?? 'other', priority, dueAt } });
    return { id, dueAt, priority };
  }
  async assignWorkOrder(schoolId: string, id: string, staffId: string) {
    if (!(await this.db.update('work_orders', { assigned_to: staffId, status: 'assigned', updated_at: nowSql() }, { id, school_id: schoolId }))) throw notFound('work order');
    const staff = await this.db.findOne<Row>('staff', { id: staffId });
    if (staff?.user_id) await this.notifications.notify({ schoolId, userId: String(staff.user_id), channels: ['push', 'in_app'], eventKey: 'facilities.work_assigned', title: 'A job to do', body: String((await this.db.findOne<Row>('work_orders', { id }))?.title ?? ''), entityType: 'facilities.work_order', entityId: id });
    return { id, assignedTo: staffId };
  }
  /**
   * Finished. A job that cost money books the expense through accounting, so maintenance spending is
   * in the same books as everything else instead of a note in somebody's diary.
   */
  async completeWorkOrder(schoolId: string, id: string, p: { cost?: number | null; note?: string | null; completedBy?: string | null } = {}) {
    const w = await this.db.findOne<Row>('work_orders', { id, school_id: schoolId });
    if (!w) throw notFound('work order');
    if (w.status === 'done') return { id, status: 'done' as const, alreadyDone: true };
    let expenseId: string | null = null;
    if (p.cost && p.cost > 0) {
      const categoryId = await this.expenseCategory(schoolId, 'Repairs & maintenance');
      expenseId = (await this.accounting.createExpense(schoolId, { categoryId, amount: round(p.cost), description: `Work order: ${w.title}`, expenseDate: nowSql().slice(0, 10), requestedBy: p.completedBy ?? null })).id;
    }
    await this.db.update('work_orders', { status: 'done', completed_at: nowSql(), cost: p.cost ?? null, expense_id: expenseId, updated_at: nowSql() }, { id });
    await this.db.execute(`UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE school_id = ? AND entity_type = 'facilities.work_order' AND entity_id = ? AND status = 'open'`, [nowSql(), nowSql(), schoolId, id]);
    if (w.reported_by) await this.notifications.notify({ schoolId, userId: String(w.reported_by), channels: ['in_app', 'push'], eventKey: 'facilities.work_done', title: 'Fixed', body: `${w.title}${p.note ? ` — ${p.note}` : ''}.`, entityType: 'facilities.work_order', entityId: id });
    await this.outbox.emitNow({ type: 'work_order.done', schoolId, aggregateType: 'facilities.work_order', aggregateId: id, payload: { workOrderId: id, cost: round(p.cost ?? 0), expenseId: expenseId ?? '' } });
    return { id, status: 'done' as const, expenseId };
  }
  async workOrders(schoolId: string, f: { status?: string; category?: string; overdueOnly?: boolean } = {}) {
    const where: string[] = ['w.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.status) { where.push('w.status = ?'); params.push(f.status); }
    if (f.category) { where.push('w.category = ?'); params.push(f.category); }
    if (f.overdueOnly) { where.push(`w.status NOT IN ('done','cancelled') AND w.due_at < ?`); params.push(nowSql()); }
    return this.db.query<Row>(`SELECT w.*, r.name AS room_name, s.first_name, s.last_name FROM work_orders w LEFT JOIN rooms r ON r.id = w.location_room_id LEFT JOIN staff s ON s.id = w.assigned_to WHERE ${where.join(' AND ')} ORDER BY w.due_at LIMIT 300`, params);
  }

  // ---------- cleaning ----------
  async setCleaningSchedule(schoolId: string, c: { area: string; frequency: 'daily' | 'weekly' | 'monthly'; assignedTo?: string | null; checklist?: string[] | null }) {
    const ex = await this.db.findOne<Row>('cleaning_schedules', { school_id: schoolId, area: c.area });
    const row = { school_id: schoolId, area: c.area.slice(0, 120), frequency: c.frequency, assigned_to: c.assignedTo ?? null, checklist: (c.checklist ?? null) as never };
    if (ex) { await this.db.update('cleaning_schedules', { ...row, updated_at: nowSql() }, { id: String(ex.id) }); return String(ex.id); }
    const id = ulid();
    await this.db.insert('cleaning_schedules', { id, ...row, last_done_at: null });
    return id;
  }
  async markCleaned(schoolId: string, id: string) {
    if (!(await this.db.update('cleaning_schedules', { last_done_at: nowSql(), updated_at: nowSql() }, { id, school_id: schoolId }))) throw notFound('cleaning schedule');
    // the round is done, so the chase for it is done: the next one is a new task, not this one again
    await this.db.execute(`UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE school_id = ? AND entity_type = 'facilities.cleaning' AND entity_id = ? AND status = 'open'`, [nowSql(), nowSql(), schoolId, id]);
    return { id, lastDoneAt: nowSql() };
  }
  /** Areas whose turn has come round again, worked out from when each was last done. */
  async cleaningDue(schoolId: string) {
    const rows = await this.db.findMany<Row>('cleaning_schedules', { school_id: schoolId }, { limit: 200 });
    const hours = { daily: 24, weekly: 24 * 7, monthly: 24 * 30 };
    const now = Date.now();
    return rows.map(r => {
      const last = r.last_done_at ? Date.parse(`${String(r.last_done_at).replace(' ', 'T')}Z`) : 0;
      const dueIn = last ? (last + hours[r.frequency as keyof typeof hours] * 3600_000 - now) / 3600_000 : -1;
      return { ...r, checklist: json(r.checklist), overdue: dueIn < 0, hoursLate: dueIn < 0 ? Math.round(-dueIn) : 0 } as Row & { overdue: boolean; hoursLate: number };
    }).filter(r => r.overdue);
  }

  // ---------- meters ----------
  /**
   * A meter reading. It must be at least the last one: meters count up, so a smaller number is a typo
   * or a replaced meter, and either way it should be said out loud rather than averaged into a chart.
   */
  async recordReading(schoolId: string, r: { utility: 'electricity' | 'water' | 'gas' | 'internet' | 'generator_fuel'; reading: number; readAt?: string; cost?: number | null; campusId?: string | null; allowReset?: boolean }) {
    const last = (await this.db.query<Row>(`SELECT * FROM utility_readings WHERE school_id = ? AND utility = ? ORDER BY read_at DESC, id DESC LIMIT 1`, [schoolId, r.utility]))[0];
    if (last && r.reading < Number(last.reading) && !r.allowReset) throw badRequest(`the last ${r.utility} reading was ${Number(last.reading)}; a lower one needs the meter-replaced flag`);
    const id = ulid();
    const readAt = r.readAt ?? nowSql().slice(0, 10);
    let expenseId: string | null = null;
    if (r.cost && r.cost > 0) expenseId = (await this.accounting.createExpense(schoolId, { categoryId: await this.expenseCategory(schoolId, 'Utilities'), amount: round(r.cost), description: `${r.utility} bill to ${readAt}`, expenseDate: readAt })).id;
    await this.db.insert('utility_readings', { id, school_id: schoolId, utility: r.utility, campus_id: r.campusId ?? null, read_at: readAt, reading: round(r.reading), cost: r.cost ?? null, expense_id: expenseId });
    const used = last && r.reading >= Number(last.reading) ? round(r.reading - Number(last.reading)) : null;
    return { id, used, since: last ? String(last.read_at) : null, expenseId };
  }
  /** Consumption between readings, and what each period cost, for whoever is arguing about the bill. */
  async utilityHistory(schoolId: string, utility: string, limit = 24) {
    const rows = await this.db.query<Row>(`SELECT * FROM utility_readings WHERE school_id = ? AND utility = ? ORDER BY read_at DESC LIMIT ?`, [schoolId, utility, limit]);
    return rows.map((r, i) => ({ ...r, used: rows[i + 1] ? round(Number(r.reading) - Number(rows[i + 1].reading)) : null }));
  }

  // ---------- drills ----------
  async recordDrill(schoolId: string, d: { kind: 'fire' | 'earthquake' | 'evacuation' | 'first_aid' | 'inspection'; heldOn?: string; participants?: number | null; findings?: string | null; fileId?: string | null }) {
    const id = ulid();
    await this.db.insert('safety_drills', { id, school_id: schoolId, kind: d.kind, held_on: d.heldOn ?? nowSql().slice(0, 10), participants: d.participants ?? null, findings: d.findings ?? null, file_id: d.fileId ?? null });
    await this.db.execute(`UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE school_id = ? AND entity_type = 'facilities.drill' AND entity_id = ? AND status = 'open'`, [nowSql(), nowSql(), schoolId, d.kind]);
    return id;
  }
  /** Each kind of drill, when it last happened, and whether that is too long ago. */
  async drillStatus(schoolId: string) {
    const every = (await this.db.findOne<Row>('settings', { school_id: schoolId, key_name: 'facilities.drill_months' }))?.value;
    const months = Number(json<number>(every) ?? 6);
    const kinds: ('fire' | 'earthquake' | 'evacuation' | 'first_aid' | 'inspection')[] = ['fire', 'earthquake', 'evacuation', 'first_aid', 'inspection'];
    const out = [];
    for (const kind of kinds) {
      const last = (await this.db.query<Row>(`SELECT held_on FROM safety_drills WHERE school_id = ? AND kind = ? ORDER BY held_on DESC LIMIT 1`, [schoolId, kind]))[0];
      const lastOn = last ? String(last.held_on).slice(0, 10) : null;
      const dueOn = lastOn ? new Date(Date.parse(`${lastOn}T00:00:00Z`) + months * 30 * 86_400_000).toISOString().slice(0, 10) : nowSql().slice(0, 10);
      out.push({ kind, lastOn, dueOn, overdue: !lastOn || dueOn < nowSql().slice(0, 10) });
    }
    return { everyMonths: months, drills: out };
  }

  /** The expense category by name, or miscellaneous, so a cost is never lost for want of a heading. */
  private async expenseCategory(schoolId: string, name: string) {
    await this.accounting.ensureExpenseCategories(schoolId);
    const found = await this.db.findOne<Row>('expense_categories', { school_id: schoolId, name });
    if (found) return String(found.id);
    const misc = await this.db.findOne<Row>('expense_categories', { school_id: schoolId, name: 'Miscellaneous' });
    if (misc) return String(misc.id);
    const id = ulid();
    await this.db.insert('expense_categories', { id, school_id: schoolId, name, gl_account_id: null, requires_approval_above: null });
    return id;
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      /**
       * L6, L8: the building's own to-do list, chased rather than repeated.
       *
       * The old pass told the office about the same overdue work order every single night, which is
       * how a school learns to ignore the message. Escalation now reaches a person once — the one it
       * is assigned to, not only the admin role — and comes back at most every other day. The drill
       * that is due is said once a fortnight, not fifty times. Cleaning rounds nobody had ever looked
       * at (`cleaningDue` existed and nothing called it) now become one open task per area, which
       * closes when somebody marks the area done.
       */
      'facilities.sla_watch': async ({ schoolId }) => {
        const late = await this.workOrders(schoolId, { overdueOnly: true });
        for (const w of late) {
          const body = `${w.title} was due ${String(w.due_at).slice(0, 16)} and is still ${w.status}.`;
          // the person holding the job hears first; the office hears in any case
          const staff = w.assigned_to ? await this.db.findOne<Row>('staff', { id: String(w.assigned_to) }) : null;
          if (staff?.user_id) await this.notifications.notifyOnce({ schoolId, userId: String(staff.user_id), channels: ['in_app', 'push'], eventKey: 'facilities.work_assignee_overdue', title: 'A job of yours is overdue', body, entityType: 'facilities.work_order', entityId: String(w.id), withinHours: 48 });
          await this.notifications.notifyRoleOnce(schoolId, 'admin', { channels: ['in_app', 'push'], eventKey: 'facilities.work_overdue', title: 'Maintenance overdue', body, entityType: 'facilities.work_order', entityId: String(w.id), withinHours: 48 });
        }
        const drills = await this.drillStatus(schoolId);
        const overdue = drills.drills.filter(d => d.overdue);
        for (const d of overdue) {
          await this.notifications.notifyRoleOnce(schoolId, 'admin', { channels: ['in_app'], eventKey: 'facilities.drill_due', title: `${d.kind} drill is due`, body: d.lastOn ? `The last one was ${d.lastOn}.` : 'There is no record of one ever being held.', entityType: 'facilities.drill', entityId: d.kind, withinHours: 24 * 14 });
          await this.tasks.ensure({ schoolId, title: `Hold the ${d.kind} drill`, description: d.lastOn ? `The last one was on ${d.lastOn}; the school holds one every ${drills.everyMonths} months.` : 'There is no record of one ever being held.', taskType: 'facilities.drill', assignedRole: 'admin', entityType: 'facilities.drill', entityId: d.kind, priority: d.kind === 'fire' ? 'high' : 'normal' });
        }
        const dirty = await this.cleaningDue(schoolId);
        for (const c of dirty) {
          // `cleaning_schedules.assigned_to` is a staff row and `tasks.assigned_to` is a user account
          const staff = c.assigned_to ? await this.db.findOne<Row>('staff', { id: String(c.assigned_to) }) : null;
          const owner = (staff?.user_id as string) ?? null;
          await this.tasks.ensure({ schoolId, title: `Clean ${c.area}`, description: c.last_done_at ? `Last done ${String(c.last_done_at).slice(0, 16)}; it is on a ${c.frequency} round.` : 'It has never been marked done.', taskType: 'facilities.cleaning', assignedTo: owner, assignedRole: owner ? null : 'admin', entityType: 'facilities.cleaning', entityId: String(c.id) });
        }
        return { overdue: late.length, drills: overdue.length, cleaning: dirty.length };
      },
    };
  }
}
