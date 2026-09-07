import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters, ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { AcademicService } from './academic.js';
import type { ApprovalService } from '../approvals.js';
import { localHHMM } from '../util.js';
import { HttpError, badRequest, notFound } from '../context.js';

export type StudentStatus = 'present' | 'absent' | 'late' | 'half_day' | 'excused' | 'holiday';
export interface MarkInput { studentId: string; status: StudentStatus; checkIn?: string | null; lateMinutes?: number | null; remarks?: string | null }
export interface PolicyInput { audience: 'student' | 'staff'; classId?: string | null; shiftId?: string | null; lateAfterMinutes?: number; halfDayAfterMinutes?: number; autoAbsentAt?: string | null; notifyOnArrival?: boolean; notifyOnAbsent?: boolean; notifyOnLate?: boolean; consecutiveAbsentAlert?: number; minAttendancePct?: number; blockExamBelowMin?: boolean }
export interface RegisterRow extends Row { student_id: string; first_name: string; last_name: string | null; name_bn: string | null; current_roll_no: string | null; photo_file_id: string | null; attendance_id: string | null; status: StudentStatus | null; check_in: string | null; late_minutes: number | null; remarks: string | null; source: string | null; on_leave: boolean }
export interface LeaveInput { applicantType: 'student' | 'staff'; studentId?: string | null; staffId?: string | null; leaveTypeId: string; fromDate: string; toDate: string; halfDay?: 'first' | 'second' | null; reason: string; documentFileId?: string | null }

/**
 * Attendance: one row per student per day (`student_attendance`), optional per-period rows, staff
 * attendance, device ingestion (ZKTeco/Hikvision push, RFID, QR/app), policies per class/shift, the
 * auto-absent cut-off job (C4: absent SMS within five minutes), leave with approval and substitutions,
 * and the monthly summary rollup that report cards and fee fines read.
 */
export class AttendanceService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService, private academic: AcademicService, private approvals: ApprovalService, private adapters: Adapters) {}

  // ---------- policies ----------
  async setPolicy(schoolId: string, p: PolicyInput) {
    const where: Row = { school_id: schoolId, audience: p.audience, class_id: p.classId ?? null, shift_id: p.shiftId ?? null };
    const row = { late_after_minutes: p.lateAfterMinutes ?? 15, half_day_after_minutes: p.halfDayAfterMinutes ?? 120, auto_absent_at: p.autoAbsentAt ?? null, notify_on_arrival: p.notifyOnArrival ?? true, notify_on_absent: p.notifyOnAbsent ?? true, notify_on_late: p.notifyOnLate ?? true, consecutive_absent_alert: p.consecutiveAbsentAlert ?? 3, min_attendance_pct: p.minAttendancePct ?? 75, block_exam_below_min: p.blockExamBelowMin ?? false, is_active: true };
    const ex = await this.db.findOne<{ id: string }>('attendance_policies', where);
    if (ex) { await this.db.update('attendance_policies', { ...row, updated_at: nowSql() }, { id: ex.id }); return ex.id; }
    const id = ulid(); await this.db.insert('attendance_policies', { id, ...where, ...row }); return id;
  }
  async policies(schoolId: string) { return this.db.findMany<Row>('attendance_policies', { school_id: schoolId, is_active: true }); }
  /** Most specific policy first: class+shift → class → shift → school-wide default. */
  async policyFor(schoolId: string, audience: 'student' | 'staff', classId?: string | null, shiftId?: string | null) {
    const all = await this.policies(schoolId);
    const mine = all.filter(p => p.audience === audience);
    const score = (p: Row) => (p.class_id === classId ? 2 : p.class_id == null ? 0 : -10) + (p.shift_id === shiftId ? 1 : p.shift_id == null ? 0 : -10);
    const best = mine.map(p => ({ p, s: score(p) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s)[0];
    return best?.p ?? { late_after_minutes: 15, half_day_after_minutes: 120, auto_absent_at: null, notify_on_absent: 1, notify_on_late: 1, notify_on_arrival: 1, consecutive_absent_alert: 3, min_attendance_pct: 75 } as Row;
  }
  async ensureDefaultPolicy(schoolId: string) {
    if (await this.db.count('attendance_policies', { school_id: schoolId })) return false;
    const cutoff = (await this.db.findOne<Row>('settings', { school_id: schoolId, key_name: 'attendance.cutoff_time' }));
    await this.setPolicy(schoolId, { audience: 'student', autoAbsentAt: (json<string>(cutoff?.value) ?? '10:30') + ':00' });
    await this.setPolicy(schoolId, { audience: 'staff', autoAbsentAt: '11:00:00' });
    return true;
  }

  // ---------- marking ----------
  /** Section register for one day: every enrolled student with the mark already made (if any). */
  async register(schoolId: string, sectionId: string, onDate: string): Promise<{ onDate: string; holiday: boolean; section: Row | null; students: RegisterRow[] }> {
    const rows = await this.db.query<Row>(`SELECT s.id AS student_id, s.first_name, s.last_name, s.name_bn, s.current_roll_no, s.photo_file_id, a.id AS attendance_id, a.status, a.check_in, a.late_minutes, a.remarks, a.source
      FROM student_enrollments e JOIN students s ON s.id = e.student_id LEFT JOIN student_attendance a ON a.student_id = s.id AND a.on_date = ?
      WHERE e.school_id = ? AND e.section_id = ? AND e.status = 'active' AND s.status = 'active' ORDER BY LENGTH(e.roll_no), e.roll_no, s.first_name`, [onDate, schoolId, sectionId]);
    const holiday = await this.academic.isHoliday(schoolId, onDate);
    const section = await this.db.findOne<Row>('sections', { id: sectionId, school_id: schoolId });
    const leaves = await this.db.query<{ student_id: string }>(`SELECT student_id FROM leave_applications WHERE school_id = ? AND applicant_type = 'student' AND status = 'approved' AND from_date <= ? AND to_date >= ?`, [schoolId, onDate, onDate]);
    const onLeave = new Set(leaves.map(l => l.student_id));
    return { onDate, holiday, section, students: rows.map(r => ({ ...r, on_leave: onLeave.has(String(r.student_id)) })) as RegisterRow[] };
  }

  /** Marks a whole section in one transaction — the teacher's 30-second flow on a phone. */
  async markSection(schoolId: string, sectionId: string, onDate: string, marks: MarkInput[], markedBy?: string | null) {
    if (await this.academic.isHoliday(schoolId, onDate)) throw new HttpError(409, 'that day is a holiday', 'holiday');
    const section = await this.db.findOne<Row>('sections', { id: sectionId, school_id: schoolId });
    if (!section) throw notFound('section');
    const policy = await this.policyFor(schoolId, 'student', String(section.class_id), section.shift_id as string | null);
    const changed: { studentId: string; status: StudentStatus }[] = [];
    await this.db.transaction(async tx => {
      for (const m of marks) {
        const ex = await tx.findOne<Row>('student_attendance', { student_id: m.studentId, on_date: onDate });
        const row: Row = { school_id: schoolId, student_id: m.studentId, section_id: sectionId, on_date: onDate, status: m.status, check_in: m.checkIn ?? null, late_minutes: m.lateMinutes ?? null, source: 'manual', marked_by: markedBy ?? null, remarks: m.remarks ?? null };
        if (ex) { if (ex.status === m.status) continue; await tx.update('student_attendance', { ...row, updated_at: nowSql() }, { id: ex.id as string }); }
        else await tx.insert('student_attendance', { id: ulid(), ...row });
        changed.push({ studentId: m.studentId, status: m.status });
      }
      if (changed.length) await this.outbox.emit(tx, { type: 'attendance.marked', schoolId, aggregateType: 'attendance.section', aggregateId: sectionId, payload: { sectionId, onDate, counts: countBy(changed) } as never });
    });
    for (const c of changed) if (c.status === 'absent' && Number(policy.notify_on_absent)) await this.notifyGuardians(schoolId, c.studentId, onDate, 'attendance.absent');
    else if (c.status === 'late' && Number(policy.notify_on_late)) await this.notifyGuardians(schoolId, c.studentId, onDate, 'attendance.late');
    return { marked: changed.length, counts: countBy(changed) };
  }

  /** One student, used by device ingestion and the app. Idempotent per (student, date). */
  async mark(schoolId: string, studentId: string, onDate: string, status: StudentStatus, opts: { checkIn?: string | null; source?: 'manual' | 'device' | 'app' | 'import' | 'system' | 'bus'; markedBy?: string | null; lateMinutes?: number | null; notify?: boolean } = {}) {
    const student = await this.db.findOne<Row>('students', { id: studentId, school_id: schoolId });
    if (!student) throw notFound('student');
    const ex = await this.db.findOne<Row>('student_attendance', { student_id: studentId, on_date: onDate });
    const row: Row = { school_id: schoolId, student_id: studentId, section_id: (student.current_section_id as string) ?? null, on_date: onDate, status, check_in: opts.checkIn ?? null, late_minutes: opts.lateMinutes ?? null, source: opts.source ?? 'device', marked_by: opts.markedBy ?? null };
    if (ex) { if (ex.status === status) return { changed: false, id: String(ex.id) }; await this.db.update('student_attendance', { ...row, updated_at: nowSql() }, { id: ex.id as string }); }
    else await this.db.insert('student_attendance', { id: ulid(), ...row });
    if (opts.notify !== false && (status === 'present' || status === 'late')) await this.notifyGuardians(schoolId, studentId, onDate, status === 'late' ? 'attendance.late' : 'attendance.arrived');
    return { changed: true, id: ex ? String(ex.id) : undefined };
  }

  private async notifyGuardians(schoolId: string, studentId: string, onDate: string, eventKey: string) {
    const student = await this.db.findOne<Row>('students', { id: studentId, school_id: schoolId });
    const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [studentId]);
    const name = `${student?.first_name ?? ''} ${student?.last_name ?? ''}`.trim();
    for (const g of guardians) {
      await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['sms', 'push', 'in_app'], eventKey, data: { student: name, date: onDate }, title: eventKey === 'attendance.absent' ? 'Absent today' : 'Attendance', body: eventKey === 'attendance.absent' ? `${name} is absent today (${onDate}).` : `${name}: ${eventKey.split('.')[1]} (${onDate}).`, entityType: 'attendance.student', entityId: studentId, respectQuietHours: eventKey === 'attendance.absent' ? false : true });
    }
    await this.db.update('student_attendance', { guardian_notified_at: nowSql() }, { student_id: studentId, on_date: onDate });
    return guardians.length;
  }

  // ---------- staff ----------
  async markStaff(schoolId: string, staffId: string, onDate: string, status: 'present' | 'absent' | 'late' | 'half_day' | 'excused' | 'holiday' | 'wfh', opts: { checkIn?: string | null; checkOut?: string | null; source?: string; markedBy?: string | null } = {}) {
    const ex = await this.db.findOne<Row>('staff_attendance', { staff_id: staffId, on_date: onDate });
    const row: Row = { school_id: schoolId, staff_id: staffId, on_date: onDate, status, check_in: opts.checkIn ?? null, check_out: opts.checkOut ?? null, source: (opts.source ?? 'manual') as never, marked_by: opts.markedBy ?? null };
    if (ex) { await this.db.update('staff_attendance', { ...row, updated_at: nowSql() }, { id: ex.id as string }); return String(ex.id); }
    const id = ulid(); await this.db.insert('staff_attendance', { id, ...row }); return id;
  }
  async staffRegister(schoolId: string, onDate: string) {
    return this.db.query<Row>(`SELECT st.id AS staff_id, st.employee_no, st.first_name, st.last_name, st.staff_category, a.status, a.check_in, a.check_out FROM staff st LEFT JOIN staff_attendance a ON a.staff_id = st.id AND a.on_date = ? WHERE st.school_id = ? AND st.status IN ('active','probation') ORDER BY st.first_name`, [onDate, schoolId]);
  }

  // ---------- devices ----------
  async registerDevice(schoolId: string, d: { name: string; deviceType: 'biometric' | 'rfid' | 'face' | 'qr' | 'gps_bus' | 'mobile_app'; vendor?: string; serialNo?: string; location?: string; direction?: 'in' | 'out' | 'both'; campusId?: string | null }) {
    const id = ulid(); const key = ulid() + ulid();
    const { sha256 } = await import('../util.js');
    await this.db.insert('attendance_devices', { id, school_id: schoolId, campus_id: d.campusId ?? null, name: d.name, device_type: d.deviceType, vendor: d.vendor ?? null, serial_no: d.serialNo ?? null, api_key_hash: sha256(key), location: d.location ?? null, direction: d.direction ?? 'both', is_active: true });
    return { id, apiKey: key };   // shown once
  }
  async devices(schoolId: string) { return this.db.findMany<Row>('attendance_devices', { school_id: schoolId }, { orderBy: 'name ASC' }); }
  async deviceByKey(apiKey: string) {
    const { sha256 } = await import('../util.js');
    return this.db.findOne<Row>('attendance_devices', { api_key_hash: sha256(apiKey), is_active: true });
  }

  /**
   * Device push endpoint payload: `{ identifier, punchedAt, direction }[]`. Identifiers are matched to
   * `students.biometric_id | rfid_tag | admission_no` and `staff.biometric_id | rfid_tag | employee_no`.
   * Rows are stored raw first so nothing is lost, then resolved; unknown identifiers keep an error and
   * can be re-processed once the person is enrolled on the device.
   */
  async ingestPunches(schoolId: string, deviceId: string, punches: { identifier: string; punchedAt: string; direction?: string; raw?: unknown }[]) {
    const device = await this.db.findOne<Row>('attendance_devices', { id: deviceId, school_id: schoolId });
    if (!device) throw notFound('device');
    const ids = punches.map(p => p.identifier);
    if (!ids.length) return { stored: 0, resolved: 0, unknown: 0 };
    const students = await this.db.query<Row>(`SELECT id, biometric_id, rfid_tag, admission_no, current_class_id, current_section_id FROM students WHERE school_id = ? AND status = 'active' AND (biometric_id IN (${ids.map(() => '?').join(',')}) OR rfid_tag IN (${ids.map(() => '?').join(',')}) OR admission_no IN (${ids.map(() => '?').join(',')}))`, [schoolId, ...ids, ...ids, ...ids]);
    const staff = await this.db.query<Row>(`SELECT id, biometric_id, rfid_tag, employee_no FROM staff WHERE school_id = ? AND status IN ('active','probation') AND (biometric_id IN (${ids.map(() => '?').join(',')}) OR rfid_tag IN (${ids.map(() => '?').join(',')}) OR employee_no IN (${ids.map(() => '?').join(',')}))`, [schoolId, ...ids, ...ids, ...ids]);
    const index = new Map<string, { type: 'student' | 'staff'; row: Row }>();
    for (const s of students) for (const k of [s.biometric_id, s.rfid_tag, s.admission_no]) if (k) index.set(String(k), { type: 'student', row: s });
    for (const s of staff) for (const k of [s.biometric_id, s.rfid_tag, s.employee_no]) if (k) index.set(String(k), { type: 'staff', row: s });

    let resolved = 0, unknown = 0;
    const logs: Row[] = []; const first = new Map<string, { punchedAt: string; hit: { type: 'student' | 'staff'; row: Row } }>();
    for (const p of punches) {
      const hit = index.get(p.identifier);
      logs.push({ id: ulid(), school_id: schoolId, device_id: deviceId, identifier: p.identifier, punched_at: p.punchedAt, direction: p.direction ?? String(device.direction), raw_payload: (p.raw ?? null) as never, person_type: hit?.type ?? null, person_id: hit ? String(hit.row.id) : null, processed_at: hit ? nowSql() : null, error: hit ? null : 'unknown identifier' });
      if (!hit) { unknown++; continue; }
      resolved++;
      const key = `${hit.type}:${hit.row.id}:${p.punchedAt.slice(0, 10)}`;
      const cur = first.get(key);
      if (!cur || p.punchedAt < cur.punchedAt) first.set(key, { punchedAt: p.punchedAt, hit });
    }
    await this.db.insertMany('device_punch_logs', logs);
    await this.db.update('attendance_devices', { last_seen_at: nowSql() }, { id: deviceId });
    // first punch of the day decides present/late against the policy's cut-off
    for (const [key, v] of first) {
      const onDate = v.punchedAt.slice(0, 10);
      if (await this.academic.isHoliday(schoolId, onDate)) continue;
      if (v.hit.type === 'student') {
        const policy = await this.policyFor(schoolId, 'student', v.hit.row.current_class_id as string, null);
        const late = this.lateMinutes(String(policy.auto_absent_at ?? '10:30:00'), v.punchedAt, Number(policy.late_after_minutes ?? 15));
        await this.mark(schoolId, String(v.hit.row.id), onDate, late > 0 ? 'late' : 'present', { checkIn: v.punchedAt, lateMinutes: late || null, source: 'device', notify: true });
      } else {
        const policy = await this.policyFor(schoolId, 'staff', null, null);
        const late = this.lateMinutes(String(policy.auto_absent_at ?? '11:00:00'), v.punchedAt, Number(policy.late_after_minutes ?? 15));
        await this.markStaff(schoolId, String(v.hit.row.id), onDate, late > 0 ? 'late' : 'present', { checkIn: v.punchedAt, source: 'device' });
      }
      void key;
    }
    return { stored: logs.length, resolved, unknown };
  }
  private lateMinutes(cutoff: string, punchedAt: string, graceMinutes: number) {
    const [h, m] = cutoff.split(':').map(Number);
    const t = punchedAt.slice(11, 16).split(':').map(Number);
    const diff = (t[0] * 60 + t[1]) - (h * 60 + m);
    return diff > graceMinutes ? diff : 0;
  }

  // ---------- leave ----------
  async applyLeave(schoolId: string, l: LeaveInput, appliedBy?: string | null) {
    if (l.fromDate > l.toDate) throw badRequest('end date before start date');
    const type = await this.db.findOne<Row>('leave_types', { id: l.leaveTypeId, school_id: schoolId });
    if (!type) throw notFound('leave type');
    const days = l.halfDay ? 0.5 : Math.round((Date.parse(l.toDate) - Date.parse(l.fromDate)) / 86400_000) + 1;
    const id = ulid();
    const ap = await this.approvals.request({ schoolId, entityType: 'leave_application', entityId: id, summary: { type: type.name, from: l.fromDate, to: l.toDate, days } });
    await this.db.insert('leave_applications', { id, school_id: schoolId, applicant_type: l.applicantType, student_id: l.studentId ?? null, staff_id: l.staffId ?? null, leave_type_id: l.leaveTypeId, from_date: l.fromDate, to_date: l.toDate, half_day: l.halfDay ?? null, days, reason: l.reason, document_file_id: l.documentFileId ?? null, applied_by: appliedBy ?? null, status: ap.status === 'approved' ? 'approved' : 'pending', approval_request_id: ap.id, decided_at: ap.status === 'approved' ? nowSql() : null });
    if (ap.status === 'approved') await this.onLeaveApproved(schoolId, id);
    return { id, status: ap.status, days };
  }
  async decideLeave(schoolId: string, id: string, decision: 'approved' | 'rejected', note?: string, decidedBy?: string | null) {
    const l = await this.db.findOne<Row>('leave_applications', { id, school_id: schoolId });
    if (!l) throw notFound('leave application');
    if (l.approval_request_id) await this.approvals.decide(String(l.approval_request_id), schoolId, decision, note).catch(() => undefined);
    await this.db.update('leave_applications', { status: decision, decided_by: decidedBy ?? null, decided_at: nowSql(), decision_note: note ?? null, updated_at: nowSql() }, { id });
    if (decision === 'approved') await this.onLeaveApproved(schoolId, id);
    else await this.outbox.emitNow({ type: 'leave.rejected', schoolId, aggregateType: 'attendance.leave', aggregateId: id, payload: { leaveId: id } as never });
    return { status: decision };
  }
  /** B3: an approved staff leave marks the days excused and emits `leave.approved` so substitutes get suggested. */
  private async onLeaveApproved(schoolId: string, id: string) {
    const l = await this.db.findOne<Row>('leave_applications', { id, school_id: schoolId });
    if (!l) return;
    const dates: string[] = []; for (let d = Date.parse(String(l.from_date)); d <= Date.parse(String(l.to_date)); d += 86400_000) dates.push(new Date(d).toISOString().slice(0, 10));
    for (const day of dates) {
      if (await this.academic.isHoliday(schoolId, day)) continue;
      if (l.applicant_type === 'student' && l.student_id) await this.mark(schoolId, String(l.student_id), day, 'excused', { source: 'system', notify: false });
      if (l.applicant_type === 'staff' && l.staff_id) await this.markStaff(schoolId, String(l.staff_id), day, 'excused', { source: 'system' });
    }
    if (l.applicant_type === 'staff' && l.staff_id) {
      const balance = await this.db.findOne<Row>('leave_balances', { staff_id: String(l.staff_id), leave_type_id: String(l.leave_type_id) });
      if (balance) await this.db.update('leave_balances', { used: Number(balance.used) + Number(l.days), updated_at: nowSql() }, { id: balance.id as string });
    }
    await this.outbox.emitNow({ type: 'leave.approved', schoolId, aggregateType: 'attendance.leave', aggregateId: id, payload: { leaveId: id, applicantType: String(l.applicant_type), staffId: (l.staff_id as string) ?? null, studentId: (l.student_id as string) ?? null, fromDate: String(l.from_date), toDate: String(l.to_date), dates } as never });
  }
  async leaves(schoolId: string, f: { status?: string; staffId?: string; studentId?: string } = {}) {
    const where: string[] = ['l.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.status) { where.push('l.status = ?'); params.push(f.status); }
    if (f.staffId) { where.push('l.staff_id = ?'); params.push(f.staffId); }
    if (f.studentId) { where.push('l.student_id = ?'); params.push(f.studentId); }
    return this.db.query<Row>(`SELECT l.*, t.name AS leave_type, st.first_name AS staff_first, st.last_name AS staff_last, s.first_name AS student_first, s.last_name AS student_last FROM leave_applications l JOIN leave_types t ON t.id = l.leave_type_id LEFT JOIN staff st ON st.id = l.staff_id LEFT JOIN students s ON s.id = l.student_id WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT 200`, params);
  }

  // ---------- reporting ----------
  async summary(schoolId: string, f: { sectionId?: string; from: string; to: string }) {
    const where = ['a.school_id = ?', 'a.on_date >= ?', 'a.on_date <= ?']; const params: unknown[] = [schoolId, f.from, f.to];
    if (f.sectionId) { where.push('a.section_id = ?'); params.push(f.sectionId); }
    return this.db.query<Row>(`SELECT a.on_date, a.status, COUNT(*) AS n FROM student_attendance a WHERE ${where.join(' AND ')} GROUP BY a.on_date, a.status ORDER BY a.on_date`, params);
  }
  async studentHistory(schoolId: string, studentId: string, from: string, to: string) {
    return this.db.query<Row>(`SELECT on_date, status, check_in, late_minutes, remarks FROM student_attendance WHERE school_id = ? AND student_id = ? AND on_date BETWEEN ? AND ? ORDER BY on_date DESC`, [schoolId, studentId, from, to]);
  }
  /** C11: rebuild `attendance_monthly_summary` for a month (percentages the report card and fee fines use). */
  async refreshMonthly(schoolId: string, month: string) {
    const first = month.slice(0, 7) + '-01';
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const rows = await this.db.query<Row>(`SELECT student_id, status, COUNT(*) AS n FROM student_attendance WHERE school_id = ? AND on_date BETWEEN ? AND ? GROUP BY student_id, status`, [schoolId, first, last]);
    const per = new Map<string, Record<string, number>>();
    for (const r of rows) { const k = String(r.student_id); per.set(k, { ...(per.get(k) ?? {}), [String(r.status)]: Number(r.n) }); }
    let written = 0;
    for (const [studentId, c] of per) {
      const present = (c.present ?? 0) + (c.late ?? 0) + (c.half_day ?? 0) * 0.5;
      const working = (c.present ?? 0) + (c.absent ?? 0) + (c.late ?? 0) + (c.half_day ?? 0) + (c.excused ?? 0);
      const pct = working ? Math.round((present / working) * 10000) / 100 : 0;
      const row = { present_days: c.present ?? 0, absent_days: c.absent ?? 0, late_days: c.late ?? 0, excused_days: c.excused ?? 0, working_days: working, pct };
      const ex = await this.db.findOne<{ id: string }>('attendance_monthly_summary', { student_id: studentId, month: first });
      if (ex) await this.db.update('attendance_monthly_summary', row, { id: ex.id }); else await this.db.insert('attendance_monthly_summary', { id: ulid(), school_id: schoolId, student_id: studentId, month: first, ...row });
      written++;
    }
    return { month: first, students: written };
  }

  /** The school's own wall clock as HH:MM. Cut-offs are local times; the server may be anywhere. */
  private async schoolClock(schoolId: string) {
    const school = await this.db.findOne<{ timezone: string | null }>('schools', { id: schoolId });
    return localHHMM(new Date(), String(school?.timezone ?? 'Asia/Dhaka'));
  }

  /**
   * B5: a holiday declared after the fact. Schools announce a mourning day or a strike closure the
   * same morning, by which time the register is already marked and the auto-absent pass has sent a
   * hundred families an SMS. The rows the system wrote itself are turned into `holiday`; a mark a
   * teacher made by hand is left exactly as it is, because a teacher who saw the children in front of
   * them knows something the calendar does not.
   */
  async applyHoliday(schoolId: string, fromDate: string, toDate: string) {
    const days: string[] = [];
    for (let d = Date.parse(`${fromDate}T00:00:00Z`); d <= Date.parse(`${toDate}T00:00:00Z`); d += 86400_000) days.push(new Date(d).toISOString().slice(0, 10));
    let cleared = 0;
    for (const day of days) {
      cleared += await this.db.update('student_attendance', { status: 'holiday', late_minutes: null, updated_at: nowSql() }, { school_id: schoolId, on_date: day, source: 'system' });
      await this.db.update('staff_attendance', { status: 'holiday', updated_at: nowSql() }, { school_id: schoolId, on_date: day, source: 'system' });
    }
    // an online class on a day the school is shut is cancelled rather than left to ring out
    const cancelled = await this.db.execute(`UPDATE online_classes SET status = 'cancelled', updated_at = ? WHERE school_id = ? AND status = 'scheduled' AND starts_at >= ? AND starts_at <= ?`,
      [nowSql(), schoolId, `${fromDate} 00:00:00`, `${toDate} 23:59:59`]);
    return { days: days.length, cleared, cancelled: cancelled.affectedRows };
  }

  /** Scheduled handlers: C4 auto-absent + SMS, C11 summary refresh, C6 monthly threshold alert. */
  jobs(): Record<string, ScheduledFn> {
    return {
      // C4: runs on the half hour and marks only the shifts whose own cut-off has gone by
      'attendance.auto_absent': async ({ schoolId, payload }) => {
        const p = payload as { onDate?: string; asOf?: string | null };
        return this.autoAbsent(schoolId, p.onDate ?? nowSql().slice(0, 10), 'asOf' in p ? { asOf: p.asOf } : {});
      },
      'attendance.refresh_summary': async ({ schoolId }) => this.refreshMonthly(schoolId, nowSql().slice(0, 10)),
      'attendance.monthly_threshold': async ({ schoolId }) => this.monthlyThreshold(schoolId),
    };
  }

  /**
   * C4: at the cut-off, everyone in an active section with no mark today becomes absent and their
   * guardians get an SMS. Runs in chunks so 5,000 students still finish inside a shared-hosting request.
   */
  async autoAbsent(schoolId: string, onDate = nowSql().slice(0, 10), opts: { asOf?: string | null } = {}) {
    if (await this.academic.isHoliday(schoolId, onDate)) return { skipped: 'holiday', absent: 0 };
    const year = await this.academic.currentYear(schoolId);
    if (!year) return { skipped: 'no year', absent: 0 };
    // The clock the cut-offs are written in. The job ticks every half hour so that a shift closing at
    // 09:00 is not marked at 10:30 with everybody else, which means most ticks have nothing to do:
    // the earliest cut-off in the school answers that before the roll is ever read. `asOf` is null for
    // a caller that wants the whole roll regardless of the clock (a backfill, or a test).
    const asOf = opts.asOf === undefined ? await this.schoolClock(schoolId) : opts.asOf;
    const policies = (await this.policies(schoolId)).filter(p => p.audience === 'student');
    if (asOf && policies.length) {
      const earliest = policies.map(p => (p.auto_absent_at ? String(p.auto_absent_at).slice(0, 5) : '00:00')).sort()[0] as string;
      if (asOf < earliest) return { absent: 0, waiting: null as number | null, before: earliest };
    }
    const missing = await this.db.query<Row>(`SELECT e.student_id, e.section_id, s.current_class_id, sec.shift_id FROM student_enrollments e JOIN students s ON s.id = e.student_id LEFT JOIN sections sec ON sec.id = e.section_id
      WHERE e.school_id = ? AND e.academic_year_id = ? AND e.status = 'active' AND s.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM student_attendance a WHERE a.student_id = e.student_id AND a.on_date = ?)
        AND NOT EXISTS (SELECT 1 FROM leave_applications l WHERE l.student_id = e.student_id AND l.status = 'approved' AND l.from_date <= ? AND l.to_date >= ?)`, [schoolId, String(year.id), onDate, onDate, onDate]);
    if (!missing.length) return { absent: 0, waiting: 0, before: null as string | null };
    // and then, child by child, only the ones whose own class-and-shift policy has closed its register
    let waiting = 0;
    if (asOf) {
      const passed = new Map<string, boolean>();
      for (const m of missing) {
        const key = `${m.current_class_id ?? ''}:${m.shift_id ?? ''}`;
        if (!passed.has(key)) {
          const policy = await this.policyFor(schoolId, 'student', (m.current_class_id as string) ?? null, (m.shift_id as string) ?? null);
          const cutoff = policy.auto_absent_at ? String(policy.auto_absent_at).slice(0, 5) : null;
          passed.set(key, !cutoff || asOf >= cutoff);
        }
      }
      const due = missing.filter(m => passed.get(`${m.current_class_id ?? ''}:${m.shift_id ?? ''}`));
      waiting = missing.length - due.length;
      missing.length = 0; missing.push(...due);
      if (!missing.length) return { absent: 0, waiting, before: null as string | null };
    }
    const rows = missing.map(m => ({ id: ulid(), school_id: schoolId, student_id: m.student_id, section_id: m.section_id, on_date: onDate, status: 'absent', source: 'system', marked_by: null }));
    await this.db.insertMany('student_attendance', rows);
    await this.outbox.emitNow({ type: 'attendance.marked', schoolId, aggregateType: 'attendance.auto_absent', aggregateId: onDate, payload: { onDate, counts: { absent: rows.length }, source: 'auto' } as never });
    // notification fan-out goes through the queue so the cut-off job itself stays fast
    await this.adapters.queue.push({ name: 'attendance.notify_absent', queue: 'notifications', schoolId, payload: { onDate, studentIds: missing.map(m => String(m.student_id)) }, totalItems: missing.length, triggeredBy: 'attendance.auto_absent' });
    return { absent: rows.length, waiting, before: null as string | null };
  }
  /** Queue handler for the absent fan-out (chunked: 100 guardians per pass). */
  async notifyAbsentBatch(payload: Record<string, unknown>, ctx: { job: { cursor: unknown }; progress: (d: number, t?: number | null, c?: unknown) => Promise<void>; deadline: number }) {
    const ids = (payload.studentIds as string[]) ?? []; const onDate = String(payload.onDate);
    let done = Number((ctx.job.cursor as { done?: number } | null)?.done ?? 0);
    while (done < ids.length) {
      for (const id of ids.slice(done, done + 100)) await this.notifyGuardians(String(payload.schoolId ?? (await this.db.findOne<Row>('students', { id }))?.school_id ?? ''), id, onDate, 'attendance.absent').catch(() => undefined);
      done = Math.min(ids.length, done + 100);
      await ctx.progress(done, ids.length, { done });
      if (Date.now() > ctx.deadline && done < ids.length) return { continue: true as const, cursor: { done } };
    }
    return { result: { notified: done } };
  }
  /** C6: on the 1st, anyone below the policy minimum last month gets flagged to the class teacher and guardians. */
  async monthlyThreshold(schoolId: string) {
    const d = new Date(); d.setUTCDate(0);
    const month = d.toISOString().slice(0, 7) + '-01';
    await this.refreshMonthly(schoolId, month);
    const policy = await this.policyFor(schoolId, 'student');
    const min = Number(policy.min_attendance_pct ?? 75);
    const low = await this.db.query<Row>(`SELECT m.student_id, m.pct, s.first_name, s.last_name FROM attendance_monthly_summary m JOIN students s ON s.id = m.student_id WHERE m.school_id = ? AND m.month = ? AND m.working_days > 0 AND m.pct < ?`, [schoolId, month, min]);
    for (const r of low) {
      const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [r.student_id]);
      for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['sms', 'push', 'in_app'], eventKey: 'attendance.below_minimum', data: { student: `${r.first_name} ${r.last_name ?? ''}`, pct: r.pct, min }, title: 'Attendance below minimum', body: `${r.first_name} attended ${r.pct}% last month (minimum ${min}%).`, entityType: 'attendance.student', entityId: String(r.student_id) });
    }
    return { month, flagged: low.length };
  }
}

function countBy(list: { status: string }[]) {
  const c: Record<string, number> = {};
  for (const x of list) c[x.status] = (c[x.status] ?? 0) + 1;
  return c;
}
