import { randomBytes } from 'node:crypto';
import type { Db, Row } from '@pathshala/db';
import { nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { TaskService } from '../tasks.js';
import type { ApprovalService } from '../approvals.js';
import type { FeesService } from './fees.js';
import type { SettingsService } from '../settings.js';
import { round } from './accounting.js';
import { HttpError, badRequest, notFound } from '../context.js';

/**
 * Hostel: buildings, rooms and beds, allocations that cannot overlap on a bed, out-passes that need
 * the guardian's consent before the warden can approve them, morning and night roll calls, the mess
 * menu with optional per-meal billing, and complaints that raise maintenance tasks. Two watches run
 * on the scheduler: a resident who is late back, and a resident missing from the night roll call.
 */
export class HostelService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService, private tasks: TaskService, private approvals: ApprovalService, private fees: FeesService, private settings: SettingsService) {}

  // ---------- buildings ----------
  async hostels(schoolId: string) {
    return this.db.query<Row>(`SELECT h.*, (SELECT COUNT(*) FROM hostel_rooms r WHERE r.hostel_id = h.id) AS rooms,
      (SELECT COUNT(*) FROM hostel_beds b JOIN hostel_rooms r ON r.id = b.room_id WHERE r.hostel_id = h.id) AS beds,
      (SELECT COUNT(*) FROM hostel_beds b JOIN hostel_rooms r ON r.id = b.room_id WHERE r.hostel_id = h.id AND b.status = 'occupied') AS occupied
      FROM hostels h WHERE h.school_id = ? ORDER BY h.name`, [schoolId]);
  }
  async createHostel(schoolId: string, h: { name: string; hostelType: 'boys' | 'girls' | 'staff'; wardenId?: string | null; curfewTime?: string | null; rooms?: { roomNo: string; capacity: number; monthlyFee?: number; roomType?: 'single' | 'double' | 'shared' | 'dorm'; floor?: string | null }[] }) {
    const id = ulid();
    const head = await this.db.findOne<{ id: string }>('fee_heads', { school_id: schoolId, code: 'HOSTEL' });
    await this.db.transaction(async tx => {
      await tx.insert('hostels', { id, school_id: schoolId, campus_id: null, name: h.name, hostel_type: h.hostelType, warden_id: h.wardenId ?? null, address: null, curfew_time: h.curfewTime ?? '21:00:00', fee_head_id: head?.id ?? null, status: 'active' });
      for (const r of h.rooms ?? []) {
        const roomId = ulid();
        await tx.insert('hostel_rooms', { id: roomId, school_id: schoolId, hostel_id: id, room_no: r.roomNo, floor: r.floor ?? null, room_type: r.roomType ?? 'shared', capacity: r.capacity, monthly_fee: r.monthlyFee ?? 0, amenities: null, status: 'active' });
        for (let i = 1; i <= r.capacity; i++) await tx.insert('hostel_beds', { id: ulid(), school_id: schoolId, room_id: roomId, bed_no: String(i), status: 'vacant' });
      }
    });
    return id;
  }
  async rooms(schoolId: string, hostelId: string) {
    return this.db.query<Row>(`SELECT r.*, (SELECT COUNT(*) FROM hostel_beds b WHERE b.room_id = r.id AND b.status = 'vacant') AS vacant FROM hostel_rooms r WHERE r.school_id = ? AND r.hostel_id = ? ORDER BY r.room_no`, [schoolId, hostelId]);
  }
  async vacantBeds(schoolId: string, hostelId: string) {
    return this.db.query<Row>(`SELECT b.*, r.room_no, r.monthly_fee FROM hostel_beds b JOIN hostel_rooms r ON r.id = b.room_id WHERE b.school_id = ? AND r.hostel_id = ? AND b.status = 'vacant' ORDER BY r.room_no, b.bed_no`, [schoolId, hostelId]);
  }

  // ---------- allocation ----------
  /** K1: one resident per bed at a time; the room's fee is snapshotted onto the allocation. */
  async allocate(schoolId: string, a: { studentId: string; bedId: string; academicYearId: string; fromDate?: string; monthlyFee?: number }) {
    const bed = await this.db.findOne<Row>('hostel_beds', { id: a.bedId, school_id: schoolId });
    if (!bed) throw notFound('bed');
    if (bed.status !== 'vacant') throw new HttpError(409, `that bed is ${bed.status}`, 'occupied');
    const room = await this.db.findOne<Row>('hostel_rooms', { id: String(bed.room_id) });
    const live = await this.db.findOne('hostel_allocations', { student_id: a.studentId, status: 'active' });
    if (live) throw new HttpError(409, 'this student already has a bed', 'conflict');
    const id = ulid();
    const fee = round(a.monthlyFee ?? Number(room?.monthly_fee ?? 0));
    await this.db.transaction(async tx => {
      await tx.insert('hostel_allocations', { id, school_id: schoolId, student_id: a.studentId, bed_id: a.bedId, academic_year_id: a.academicYearId, from_date: a.fromDate ?? nowSql().slice(0, 10), to_date: null, monthly_fee: fee, status: 'active' });
      await tx.update('hostel_beds', { status: 'occupied' }, { id: a.bedId });   // beds carry no timestamps
    });
    await this.outbox.emitNow({ type: 'hostel.allocated', schoolId, aggregateType: 'hostel.allocation', aggregateId: id, payload: { allocationId: id, studentId: a.studentId, bedId: a.bedId, monthlyFee: fee } });
    await this.notifyGuardians(schoolId, a.studentId, 'hostel.allocated', 'Hostel seat allotted', `A hostel seat has been allotted (room ${room?.room_no}). The monthly hostel fee is ${fee}.`, id, ['sms', 'push', 'in_app']);
    return { id, monthlyFee: fee };
  }
  async vacate(schoolId: string, allocationId: string, toDate?: string) {
    const a = await this.db.findOne<Row>('hostel_allocations', { id: allocationId, school_id: schoolId });
    if (!a) throw notFound('allocation');
    await this.db.transaction(async tx => {
      await tx.update('hostel_allocations', { status: 'ended', to_date: toDate ?? nowSql().slice(0, 10), updated_at: nowSql() }, { id: allocationId });
      await tx.update('hostel_beds', { status: 'vacant' }, { id: String(a.bed_id) });
    });
    return { id: allocationId };
  }
  async residents(schoolId: string, hostelId?: string) {
    const where = hostelId ? ' AND r.hostel_id = ?' : '';
    const params = hostelId ? [schoolId, hostelId] : [schoolId];
    return this.db.query<Row>(`SELECT a.*, s.first_name, s.last_name, s.admission_no, r.room_no, b.bed_no, h.name AS hostel_name, h.id AS hostel_id FROM hostel_allocations a JOIN students s ON s.id = a.student_id JOIN hostel_beds b ON b.id = a.bed_id JOIN hostel_rooms r ON r.id = b.room_id JOIN hostels h ON h.id = r.hostel_id WHERE a.school_id = ? AND a.status = 'active'${where} ORDER BY h.name, r.room_no, b.bed_no`, params);
  }

  // ---------- out-passes ----------
  /** K2: the guardian consents first, then the warden approves; the pass carries a QR for the gate. */
  async applyOutpass(schoolId: string, o: { studentId: string; leaveFrom: string; expectedReturn: string; reason: string; destination?: string | null }) {
    const allocation = await this.db.query<Row>(`SELECT a.*, r.hostel_id FROM hostel_allocations a JOIN hostel_beds b ON b.id = a.bed_id JOIN hostel_rooms r ON r.id = b.room_id WHERE a.school_id = ? AND a.student_id = ? AND a.status = 'active' LIMIT 1`, [schoolId, o.studentId]);
    if (!allocation[0]) throw badRequest('this student is not a hostel resident');
    if (o.expectedReturn <= o.leaveFrom) throw badRequest('the return time must be after leaving');
    const id = ulid();
    await this.db.insert('hostel_outpasses', { id, school_id: schoolId, student_id: o.studentId, hostel_id: String(allocation[0].hostel_id), leave_from: o.leaveFrom, expected_return: o.expectedReturn, actual_out_at: null, actual_return_at: null, reason: o.reason.slice(0, 200), destination: o.destination ?? null, guardian_consent_at: null, status: 'pending', approved_by: null, qr_code: null, late_alert_sent_at: null });
    await this.notifyGuardians(schoolId, o.studentId, 'hostel.consent_needed', 'Out-pass needs your consent', `Your child has asked to leave the hostel from ${o.leaveFrom.slice(0, 16)} until ${o.expectedReturn.slice(0, 16)}. Reason: ${o.reason}. Please confirm in the app.`, id, ['sms', 'push', 'in_app']);
    await this.outbox.emitNow({ type: 'outpass.applied', schoolId, aggregateType: 'hostel.outpass', aggregateId: id, payload: { outpassId: id, studentId: o.studentId, expectedReturn: o.expectedReturn } });
    return id;
  }
  async guardianConsent(schoolId: string, outpassId: string, guardianUserId: string) {
    const o = await this.db.findOne<Row>('hostel_outpasses', { id: outpassId, school_id: schoolId });
    if (!o) throw notFound('out-pass');
    const guardian = await this.db.findOne<{ id: string }>('guardians', { school_id: schoolId, user_id: guardianUserId });
    if (!guardian || !(await this.db.findOne('student_guardians', { student_id: String(o.student_id), guardian_id: guardian.id }))) throw new HttpError(403, 'not your child', 'forbidden');
    await this.db.update('hostel_outpasses', { guardian_consent_at: nowSql(), updated_at: nowSql() }, { id: outpassId });
    const ap = await this.approvals.request({ schoolId, entityType: 'hostel.outpass', entityId: outpassId, summary: { studentId: String(o.student_id) } });
    if (ap.status === 'approved') await this.approveOutpass(schoolId, outpassId);
    return { id: outpassId, approval: ap.status };
  }
  /** The warden's decision. Nothing is approved before the guardian has consented. */
  async approveOutpass(schoolId: string, outpassId: string, approvedBy?: string | null) {
    const o = await this.db.findOne<Row>('hostel_outpasses', { id: outpassId, school_id: schoolId });
    if (!o) throw notFound('out-pass');
    if (!o.guardian_consent_at) throw new HttpError(409, 'the guardian has not consented yet', 'no_consent');
    if (o.status === 'approved' || o.status === 'out') return { id: outpassId, qr: String(o.qr_code) };
    const qr = randomBytes(8).toString('hex').toUpperCase();
    await this.db.update('hostel_outpasses', { status: 'approved', approved_by: approvedBy ?? null, qr_code: qr, updated_at: nowSql() }, { id: outpassId });
    await this.notifyGuardians(schoolId, String(o.student_id), 'hostel.outpass_approved', 'Out-pass approved', `The out-pass is approved until ${String(o.expected_return).slice(0, 16)}.`, outpassId, ['sms', 'push', 'in_app']);
    return { id: outpassId, qr };
  }
  async rejectOutpass(schoolId: string, outpassId: string, reason?: string) {
    await this.db.update('hostel_outpasses', { status: 'rejected', updated_at: nowSql() }, { id: outpassId, school_id: schoolId });
    return { id: outpassId, reason: reason ?? null };
  }
  /** The gate scans the pass on the way out and again on the way back. */
  async scanOutpass(schoolId: string, qr: string) {
    const o = await this.db.findOne<Row>('hostel_outpasses', { school_id: schoolId, qr_code: qr.trim().toUpperCase() });
    if (!o) throw notFound('out-pass');
    if (o.status === 'approved') {
      await this.db.update('hostel_outpasses', { status: 'out', actual_out_at: nowSql(), updated_at: nowSql() }, { id: String(o.id) });
      await this.notifyGuardians(schoolId, String(o.student_id), 'hostel.left', 'Left the hostel', `Left the hostel at ${nowSql().slice(11, 16)}, due back by ${String(o.expected_return).slice(0, 16)}.`, String(o.id), ['push', 'in_app']);
      return { id: String(o.id), direction: 'out' as const };
    }
    if (o.status === 'out' || o.status === 'late') {
      const late = nowSql() > String(o.expected_return);
      await this.db.update('hostel_outpasses', { status: 'returned', actual_return_at: nowSql(), updated_at: nowSql() }, { id: String(o.id) });
      await this.notifyGuardians(schoolId, String(o.student_id), 'hostel.returned', 'Back in the hostel', `Returned at ${nowSql().slice(11, 16)}${late ? ', later than expected' : ''}.`, String(o.id), ['push', 'in_app']);
      return { id: String(o.id), direction: 'in' as const, late };
    }
    throw new HttpError(409, `this pass is ${o.status}`, 'invalid');
  }
  async outpasses(schoolId: string, f: { status?: string; hostelId?: string } = {}) {
    const where = ['o.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.status) { where.push('o.status = ?'); params.push(f.status); }
    if (f.hostelId) { where.push('o.hostel_id = ?'); params.push(f.hostelId); }
    return this.db.query<Row>(`SELECT o.*, s.first_name, s.last_name FROM hostel_outpasses o JOIN students s ON s.id = o.student_id WHERE ${where.join(' AND ')} ORDER BY o.leave_from DESC LIMIT 300`, params);
  }

  // ---------- roll call, mess, complaints ----------
  async rollCall(schoolId: string, hostelId: string, onDate: string, call: 'morning' | 'night', marks: { studentId: string; status: 'present' | 'absent' | 'on_outpass' | 'sick' }[], markedBy?: string | null) {
    let saved = 0;
    for (const m of marks) {
      const ex = await this.db.findOne<Row>('hostel_attendance', { student_id: m.studentId, on_date: onDate, roll_call: call });
      const row = { school_id: schoolId, hostel_id: hostelId, student_id: m.studentId, on_date: onDate, roll_call: call, status: m.status, marked_by: markedBy ?? null };
      if (ex) await this.db.update('hostel_attendance', { ...row, updated_at: nowSql() }, { id: String(ex.id) });
      else await this.db.insert('hostel_attendance', { id: ulid(), ...row });
      saved++;
    }
    // K4: an unexplained absence at night is escalated immediately, not in the morning
    if (call === 'night') {
      // the call has been taken, so the chase for it is over
      await this.db.execute(`UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE school_id = ? AND entity_type = 'hostel.rollcall' AND entity_id = ? AND status = 'open'`, [nowSql(), nowSql(), schoolId, `${hostelId}:${onDate}`]);
      for (const m of marks.filter(x => x.status === 'absent')) {
        const pass = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM hostel_outpasses WHERE student_id = ? AND status IN ('approved','out') AND leave_from <= ? AND expected_return >= ?`, [m.studentId, nowSql(), nowSql()]);
        if (Number(pass[0]?.n ?? 0) > 0) continue;
        const student = await this.db.findOne<Row>('students', { id: m.studentId });
        await this.notifications.notifyRole(schoolId, 'admin', { channels: ['push', 'in_app', 'sms'], eventKey: 'hostel.missing_at_rollcall', title: 'Resident missing at roll call', body: `${student?.first_name} was absent at the night roll call with no out-pass.`, entityType: 'hostel.attendance', entityId: m.studentId });
        await this.notifyGuardians(schoolId, m.studentId, 'hostel.missing_at_rollcall', 'Your child missed roll call', `${student?.first_name} was not in the hostel at the night roll call. The warden is looking into it.`, m.studentId, ['sms', 'push', 'in_app']);
      }
    }
    return { saved };
  }
  async setMenu(schoolId: string, hostelId: string, rows: { dayOfWeek: number; meal: 'breakfast' | 'lunch' | 'snack' | 'dinner'; items: string }[]) {
    for (const r of rows) {
      const ex = await this.db.findOne<Row>('mess_menus', { hostel_id: hostelId, day_of_week: r.dayOfWeek, meal: r.meal });
      if (ex) await this.db.update('mess_menus', { items: r.items.slice(0, 255) }, { id: String(ex.id) });
      else await this.db.insert('mess_menus', { id: ulid(), school_id: schoolId, hostel_id: hostelId, day_of_week: r.dayOfWeek, meal: r.meal, items: r.items.slice(0, 255) });
    }
    return { rows: rows.length };
  }
  async menu(schoolId: string, hostelId: string) { return this.db.findMany<Row>('mess_menus', { school_id: schoolId, hostel_id: hostelId }, { orderBy: 'day_of_week ASC, meal ASC' }); }
  async recordMeals(schoolId: string, hostelId: string, onDate: string, meal: 'breakfast' | 'lunch' | 'snack' | 'dinner', rows: { studentId: string; taken?: boolean; cost?: number }[]) {
    let saved = 0;
    for (const r of rows) {
      const ex = await this.db.findOne<Row>('meal_records', { student_id: r.studentId, on_date: onDate, meal });
      const row = { school_id: schoolId, hostel_id: hostelId, student_id: r.studentId, on_date: onDate, meal, taken: r.taken ?? true, cost: r.cost ?? null };
      if (ex) await this.db.update('meal_records', row, { id: String(ex.id) });
      else await this.db.insert('meal_records', { id: ulid(), ...row });
      saved++;
    }
    return { saved };
  }
  /** K5: a maintenance complaint becomes somebody's job, with a two-day deadline. */
  async complain(schoolId: string, c: { hostelId: string; studentId?: string | null; category: 'maintenance' | 'food' | 'safety' | 'cleanliness' | 'other'; description: string }) {
    const id = ulid();
    await this.db.insert('hostel_complaints', { id, school_id: schoolId, hostel_id: c.hostelId, student_id: c.studentId ?? null, category: c.category, description: c.description, status: 'open', resolved_at: null });
    if (c.category === 'maintenance' || c.category === 'safety') {
      await this.tasks.create({ schoolId, title: `Hostel ${c.category}: ${c.description.slice(0, 80)}`, taskType: 'hostel.complaint', assignedRole: 'admin', entityType: 'hostel.complaint', entityId: id, dueAt: nowSql(new Date(Date.now() + 48 * 3600_000)), priority: c.category === 'safety' ? 'urgent' : 'high' });
    }
    return id;
  }
  async resolveComplaint(schoolId: string, id: string) { return this.db.update('hostel_complaints', { status: 'resolved', resolved_at: nowSql(), updated_at: nowSql() }, { id, school_id: schoolId }); }
  async complaints(schoolId: string, hostelId?: string) {
    const where: Row = { school_id: schoolId };
    if (hostelId) where.hostel_id = hostelId;
    return this.db.findMany<Row>('hostel_complaints', where, { orderBy: 'created_at DESC', limit: 200 });
  }

  /**
   * Per-meal mess billing. A hostel that charges a flat monthly rate bills through the fee structure
   * like anything else; one that charges for what was actually eaten needs this. Each meal keeps the
   * price it was charged at, so re-running the month after a rate change does not rewrite history, and
   * a student already billed for the month is skipped rather than billed twice.
   */
  async billMeals(schoolId: string, p: { month?: string; hostelId?: string | null } = {}) {
    const month = (p.month ?? nowSql().slice(0, 7)).slice(0, 7);
    const from = `${month}-01`;
    const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const rates = (await this.settings.get<Record<string, number>>(schoolId, 'hostel.meal_rates')) ?? { breakfast: 25, lunch: 60, snack: 15, dinner: 55 };
    const head = await this.db.findOne<{ id: string }>('fee_heads', { school_id: schoolId, code: 'MESS' });
    const rows = await this.db.query<Row>(`SELECT * FROM meal_records WHERE school_id = ? AND on_date BETWEEN ? AND ? AND taken = TRUE${p.hostelId ? ' AND hostel_id = ?' : ''} ORDER BY student_id`, p.hostelId ? [schoolId, from, to, p.hostelId] : [schoolId, from, to]);
    const byStudent = new Map<string, Row[]>();
    for (const r of rows) byStudent.set(String(r.student_id), [...(byStudent.get(String(r.student_id)) ?? []), r]);
    let billed = 0, skipped = 0, total = 0;
    for (const [studentId, meals] of byStudent) {
      const note = `mess:${month}`;
      if (await this.db.findOne('invoices', { school_id: schoolId, student_id: studentId, notes: note })) { skipped++; continue; }
      const counts = new Map<string, { n: number; amount: number }>();
      for (const m of meals) {
        const meal = String(m.meal);
        const cost = m.cost != null ? Number(m.cost) : Number(rates[meal] ?? 0);
        if (m.cost == null && cost > 0) await this.db.update('meal_records', { cost }, { id: String(m.id) });
        const c = counts.get(meal) ?? { n: 0, amount: 0 };
        counts.set(meal, { n: c.n + 1, amount: Math.round((c.amount + cost) * 100) / 100 });
      }
      const items = [...counts.entries()].filter(([, c]) => c.amount > 0).map(([meal, c]) => ({ feeHeadId: head?.id ?? null, description: `Mess ${meal} × ${c.n} (${month})`, amount: c.amount }));
      if (!items.length) { skipped++; continue; }
      await this.fees.createInvoice(schoolId, { studentId, billingPeriod: from, issueDate: to, items, notes: note });
      billed++; total = Math.round((total + items.reduce((a, i) => a + i.amount, 0)) * 100) / 100;
    }
    return { month, billed, skipped, total };
  }
  /** What a resident has eaten this month, before anyone argues about the bill. */
  async mealSummary(schoolId: string, studentId: string, month = nowSql().slice(0, 7)) {
    const from = `${month.slice(0, 7)}-01`;
    const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const rows = await this.db.query<{ meal: string; n: number; cost: number }>(`SELECT meal, COUNT(*) AS n, COALESCE(SUM(cost), 0) AS cost FROM meal_records WHERE school_id = ? AND student_id = ? AND taken = TRUE AND on_date BETWEEN ? AND ? GROUP BY meal`, [schoolId, studentId, from, to]);
    return { month: month.slice(0, 7), meals: rows, total: Math.round(rows.reduce((a, r) => a + Number(r.cost), 0) * 100) / 100 };
  }

  private async notifyGuardians(schoolId: string, studentId: string, eventKey: string, title: string, body: string, entityId: string, channels: ('sms' | 'push' | 'in_app' | 'email')[]) {
    const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [studentId]);
    for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels, eventKey, title, body, entityType: 'hostel.outpass', entityId });
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // the mess bill for the month just gone, on the first of the next one
      'hostel.mess_billing': async ({ schoolId }) => {
        const d = new Date(); d.setUTCDate(0);
        return this.billMeals(schoolId, { month: d.toISOString().slice(0, 7) });
      },
      // K3: somebody who is not back when they said they would be
      'hostel.curfew_watch': async ({ schoolId }) => {
        const now = nowSql();
        const late = await this.db.query<Row>(`SELECT o.*, s.first_name, s.last_name, h.name AS hostel_name FROM hostel_outpasses o JOIN students s ON s.id = o.student_id JOIN hostels h ON h.id = o.hostel_id
          WHERE o.school_id = ? AND o.status = 'out' AND o.expected_return < ? AND o.late_alert_sent_at IS NULL`, [schoolId, now]);
        for (const o of late) {
          await this.db.update('hostel_outpasses', { status: 'late', late_alert_sent_at: now, updated_at: nowSql() }, { id: String(o.id) });
          await this.notifications.notifyRole(schoolId, 'admin', { channels: ['push', 'in_app', 'sms'], eventKey: 'hostel.late_return', title: 'Resident is late back', body: `${o.first_name} ${o.last_name ?? ''} was due back at ${String(o.expected_return).slice(0, 16)} in ${o.hostel_name}.`, entityType: 'hostel.outpass', entityId: String(o.id) });
          await this.notifyGuardians(schoolId, String(o.student_id), 'hostel.late_return', 'Your child is late back', `${o.first_name} was due back in the hostel at ${String(o.expected_return).slice(0, 16)} and has not returned.`, String(o.id), ['sms', 'push', 'in_app']);
        }
        return { late: late.length };
      },
      /**
       * K7: the two things a hostel discovers too late.
       *
       * The night roll call is the whole safety story of a boarding house, and K4 only fires when
       * somebody takes it — a warden who forgets produces no alert at all, which is exactly the night
       * you would want one. So the roll call itself is watched: if a hostel with residents has no
       * night call marked for tonight, the warden and the office are told, once for that night.
       *
       * And a room holding more residents than its capacity, which happens when a room is
       * re-designated rather than when a bed is allocated — allocation already refuses an occupied
       * bed. It is a task, not an alarm: somebody has to decide who moves.
       */
      'hostel.night_watch': async ({ schoolId, payload }) => {
        const onDate = typeof payload?.onDate === 'string' ? payload.onDate : nowSql().slice(0, 10);
        const hostels = await this.db.query<Row>(`SELECT h.*, (SELECT COUNT(*) FROM hostel_allocations a JOIN hostel_beds b ON b.id = a.bed_id JOIN hostel_rooms r ON r.id = b.room_id WHERE r.hostel_id = h.id AND a.status = 'active') AS residents
          FROM hostels h WHERE h.school_id = ? AND h.status = 'active'`, [schoolId]);
        let missing = 0;
        for (const h of hostels) {
          if (!Number(h.residents)) continue;
          const taken = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM hostel_attendance WHERE school_id = ? AND hostel_id = ? AND on_date = ? AND roll_call = 'night'`, [schoolId, String(h.id), onDate]);
          if (Number(taken[0]?.n ?? 0) > 0) continue;
          const warden = h.warden_id ? await this.db.findOne<Row>('staff', { id: String(h.warden_id) }) : null;
          const body = `No night roll call has been marked in ${h.name} for ${onDate}. ${Number(h.residents)} resident(s) are unaccounted for on paper.`;
          if (warden?.user_id) await this.notifications.notifyOnce({ schoolId, userId: String(warden.user_id), channels: ['push', 'in_app', 'sms'], eventKey: 'hostel.rollcall_missing', title: 'The night roll call has not been taken', body, entityType: 'hostel.rollcall', entityId: `${h.id}:${onDate}`, withinHours: 20 });
          await this.notifications.notifyRoleOnce(schoolId, 'admin', { channels: ['push', 'in_app'], eventKey: 'hostel.rollcall_missing', title: 'The night roll call has not been taken', body, entityType: 'hostel.rollcall', entityId: `${h.id}:${onDate}`, withinHours: 20 });
          const wardenUser = (warden?.user_id as string) ?? null;   // a task is held by a user account, not a staff row
          await this.tasks.ensure({ schoolId, title: `Take the night roll call in ${h.name} (${onDate})`, taskType: 'hostel.rollcall', assignedTo: wardenUser, assignedRole: wardenUser ? null : 'admin', entityType: 'hostel.rollcall', entityId: `${h.id}:${onDate}`, priority: 'urgent' });
          await this.outbox.emitNow({ type: 'hostel.rollcall_missing', schoolId, aggregateType: 'hostel.hostel', aggregateId: String(h.id), payload: { hostelId: String(h.id), onDate, call: 'night', residents: Number(h.residents) } });
          missing++;
        }
        const over = await this.db.query<Row>(`SELECT r.id, r.room_no, r.capacity, h.name AS hostel_name, COUNT(a.id) AS occupied
          FROM hostel_rooms r JOIN hostels h ON h.id = r.hostel_id JOIN hostel_beds b ON b.room_id = r.id JOIN hostel_allocations a ON a.bed_id = b.id AND a.status = 'active'
          WHERE r.school_id = ? GROUP BY r.id, r.room_no, r.capacity, h.name HAVING COUNT(a.id) > r.capacity`, [schoolId]);
        for (const r of over) {
          await this.tasks.ensure({ schoolId, title: `Room ${r.room_no} in ${r.hostel_name} holds ${Number(r.occupied)} against a capacity of ${Number(r.capacity)}`, description: 'Somebody has to be moved, or the room re-rated. Nothing has been changed automatically.', taskType: 'hostel.capacity', assignedRole: 'admin', entityType: 'hostel.room', entityId: String(r.id), priority: 'high' });
        }
        return { hostels: hostels.length, rollCallMissing: missing, overCapacity: over.length };
      },
    };
  }
}
