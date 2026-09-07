import type { Request, Response, Router } from 'express';
import { HttpError, type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const statusSchema = z.enum(['present', 'absent', 'late', 'half_day', 'excused', 'holiday']);
export const markSectionSchema = z.object({ sectionId: z.string(), onDate: dateSchema, marks: z.array(z.object({ studentId: z.string(), status: statusSchema, checkIn: z.string().optional().nullable(), lateMinutes: z.coerce.number().optional().nullable(), remarks: z.string().max(255).optional().nullable() })).max(500) });
export const leaveSchema = z.object({ applicantType: z.enum(['student', 'staff']), studentId: z.string().optional().nullable(), staffId: z.string().optional().nullable(), leaveTypeId: z.string(), fromDate: dateSchema, toDate: dateSchema, halfDay: z.enum(['first', 'second']).optional().nullable(), reason: z.string().min(3).max(2000), documentFileId: z.string().optional().nullable() });
export const diarySchema = z.object({ sectionId: z.string(), onDate: dateSchema, teacherId: z.string().optional().nullable(), classSubjectId: z.string().optional().nullable(), entryType: z.enum(['homework', 'note', 'reminder', 'announcement']).optional(), body: z.string().min(1).max(20000), dueDate: dateSchema.optional().nullable() });

/** Phase 2 API: attendance (register, devices, policies), leave, chat, PTM, diary and daily reports. */
export function mountPhase2(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User, requireUser: (req: Request) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);
  const today = () => new Date().toISOString().slice(0, 10);
  /** The staff row behind the signed-in user, for teacher-scoped calls. */
  const myStaff = async (u: User) => app.db.findOne<{ id: string }>('staff', { school_id: u.school_id, user_id: u.id });

  // ---------- attendance ----------
  api.get('/attendance/register', wrap(async req => { const u = requirePerm(req, 'attendance.view'); const sectionId = q(req, 'sectionId'); if (!sectionId) throw new HttpError(400, 'sectionId required'); return app.attendance.register(u.school_id, sectionId, q(req, 'date') ?? today()); }));
  api.post('/attendance/mark', wrap(async req => { const u = requirePerm(req, 'attendance.edit'); const b = markSectionSchema.parse(req.body); return app.attendance.markSection(u.school_id, b.sectionId, b.onDate, b.marks as never, u.id); }));
  api.get('/attendance/summary', wrap(async req => { const u = requirePerm(req, 'attendance.view'); return app.attendance.summary(u.school_id, { sectionId: q(req, 'sectionId'), from: q(req, 'from') ?? today(), to: q(req, 'to') ?? today() }); }));
  api.get('/attendance/students/:id', wrap(async req => { const u = requirePerm(req, 'attendance.view'); return app.attendance.studentHistory(u.school_id, req.params.id as string, q(req, 'from') ?? today().slice(0, 8) + '01', q(req, 'to') ?? today()); }));
  // A person pressing this means "mark them now", whatever the clock says: the half-hourly sweep is
  // the one that waits for each shift's cut-off, and it is the only caller that should.
  api.post('/attendance/auto-absent', wrap(async req => { const u = requirePerm(req, 'attendance.edit'); return app.attendance.autoAbsent(u.school_id, q(req, 'date') ?? today(), { asOf: null }); }));
  api.post('/attendance/refresh-summary', wrap(async req => { const u = requirePerm(req, 'attendance.edit'); return app.attendance.refreshMonthly(u.school_id, q(req, 'month') ?? today()); }));
  api.get('/attendance/staff', wrap(async req => { const u = requirePerm(req, 'hr.view'); return app.attendance.staffRegister(u.school_id, q(req, 'date') ?? today()); }));
  api.post('/attendance/staff', wrap(async req => { const u = requirePerm(req, 'hr.edit'); const b = z.object({ staffId: z.string(), onDate: dateSchema, status: z.enum(['present', 'absent', 'late', 'half_day', 'excused', 'holiday', 'wfh']), checkIn: z.string().optional().nullable(), checkOut: z.string().optional().nullable() }).parse(req.body); return { id: await app.attendance.markStaff(u.school_id, b.staffId, b.onDate, b.status, { checkIn: b.checkIn, checkOut: b.checkOut, markedBy: u.id }) }; }));
  api.get('/attendance/policies', wrap(async req => { const u = requirePerm(req, 'attendance.view'); return app.attendance.policies(u.school_id); }));
  api.put('/attendance/policies', wrap(async req => { const u = requirePerm(req, 'attendance.edit'); const b = z.object({ audience: z.enum(['student', 'staff']), classId: z.string().optional().nullable(), shiftId: z.string().optional().nullable(), lateAfterMinutes: z.coerce.number().optional(), autoAbsentAt: z.string().optional().nullable(), notifyOnAbsent: z.coerce.boolean().optional(), notifyOnLate: z.coerce.boolean().optional(), minAttendancePct: z.coerce.number().optional() }).parse(req.body); return { id: await app.attendance.setPolicy(u.school_id, b) }; }));

  // ---------- devices ----------
  api.get('/attendance/devices', wrap(async req => { const u = requirePerm(req, 'attendance.view'); return app.attendance.devices(u.school_id); }));
  api.post('/attendance/devices', wrap(async req => { const u = requirePerm(req, 'attendance.create'); const b = z.object({ name: z.string().min(1).max(80), deviceType: z.enum(['biometric', 'rfid', 'face', 'qr', 'gps_bus', 'mobile_app']), vendor: z.string().max(60).optional(), serialNo: z.string().max(80).optional(), location: z.string().max(120).optional(), direction: z.enum(['in', 'out', 'both']).optional() }).parse(req.body); return app.attendance.registerDevice(u.school_id, b); }));
  /**
   * Device push endpoint. Devices authenticate with the key shown once at registration
   * (`X-Device-Key` header or `?key=`), never with a user session — they sit on the school LAN.
   */
  api.post('/attendance/punch', wrap(async (req, res) => {
    const key = String(req.headers['x-device-key'] ?? req.query.key ?? '');
    const device = key ? await app.attendance.deviceByKey(key) : null;
    if (!device) { res.status(401); return { error: 'unknown device key' }; }
    const b = z.object({ punches: z.array(z.object({ identifier: z.string().max(80), punchedAt: z.string().min(10).max(30), direction: z.string().max(10).optional(), raw: z.unknown().optional() })).min(1).max(1000) }).parse(req.body);
    const r = await app.attendance.ingestPunches(String(device.school_id), String(device.id), b.punches);
    await app.outbox.emitNow({ type: 'punches.ingested', schoolId: String(device.school_id), aggregateType: 'attendance.device', aggregateId: String(device.id), payload: { deviceId: String(device.id), ...r } });
    return r;
  }));

  // ---------- leave ----------
  api.get('/leave/types', wrap(async req => { const u = requireUser(req); return app.db.findMany('leave_types', { school_id: u.school_id }, { orderBy: 'audience ASC, name ASC' }); }));
  api.get('/leave', wrap(async req => { const u = requireUser(req); const mine = q(req, 'mine') === '1'; const staff = mine ? await myStaff(u) : null; if (!mine) app.rbac.require('hr.view'); return app.attendance.leaves(u.school_id, { status: q(req, 'status'), staffId: staff?.id ?? q(req, 'staffId'), studentId: q(req, 'studentId') }); }));
  api.post('/leave', wrap(async req => {
    const u = requireUser(req); const b = leaveSchema.parse(req.body);
    if (b.applicantType === 'staff' && !b.staffId) { const s = await myStaff(u); if (!s) throw new HttpError(400, 'no staff record for this user'); b.staffId = s.id; }
    const r = await app.attendance.applyLeave(u.school_id, b as never, u.id);
    await app.outbox.emitNow({ type: 'leave.applied', schoolId: u.school_id, aggregateType: 'attendance.leave', aggregateId: r.id, payload: { leaveId: r.id, applicantType: b.applicantType, days: r.days } });
    return r;
  }));
  api.post('/leave/:id/decide', wrap(async req => { const u = requirePerm(req, 'hr.approve'); const b = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(255).optional() }).parse(req.body); return app.attendance.decideLeave(u.school_id, req.params.id as string, b.decision, b.note, u.id); }));

  // ---------- chat ----------
  api.get('/chat', wrap(async req => { const u = requireUser(req); return app.communication.conversations(u.school_id, u.id); }));
  api.post('/chat/direct', wrap(async req => { const u = requireUser(req); const b = z.object({ userId: z.string() }).parse(req.body); return { id: await app.communication.openDirect(u.school_id, u.id, b.userId) }; }));
  api.post('/chat/section/:id', wrap(async req => { const u = requirePerm(req, 'communication.create'); return app.communication.ensureSectionChannel(u.school_id, req.params.id as string); }));
  api.get('/chat/:id/messages', wrap(async req => { const u = requireUser(req); return app.communication.messages(u.school_id, req.params.id as string, u.id, q(req, 'before')); }));
  api.post('/chat/:id/messages', wrap(async req => { const u = requireUser(req); const b = z.object({ body: z.string().max(4000).optional(), attachments: z.unknown().optional(), replyToId: z.string().optional().nullable() }).parse(req.body); return app.communication.send(u.school_id, u.id, { conversationId: req.params.id as string, ...b }); }));

  // ---------- PTM ----------
  api.get('/ptm/slots', wrap(async req => { const u = requireUser(req); return app.communication.ptmSlots(u.school_id, { teacherId: q(req, 'teacherId'), from: q(req, 'from') }); }));
  api.post('/ptm/slots', wrap(async req => { const u = requirePerm(req, 'communication.create'); const b = z.object({ teacherId: z.string(), date: dateSchema, startTime: z.string(), endTime: z.string(), minutes: z.coerce.number().int().min(5).max(120), capacity: z.coerce.number().int().optional(), mode: z.enum(['in_person', 'online']).optional() }).parse(req.body); return app.communication.createPtmSlots(u.school_id, b); }));
  api.post('/ptm/slots/:id/book', wrap(async req => {
    const u = requireUser(req); const b = z.object({ studentId: z.string() }).parse(req.body);
    const guardian = await app.db.findOne<{ id: string }>('guardians', { school_id: u.school_id, user_id: u.id });
    if (!guardian) throw new HttpError(403, 'only a guardian can book a PTM slot');
    const link = await app.db.findOne('student_guardians', { student_id: b.studentId, guardian_id: guardian.id });
    if (!link) throw new HttpError(403, 'not your child');
    const r = await app.communication.bookPtm(u.school_id, req.params.id as string, b.studentId, guardian.id);
    if (!r.already) await app.outbox.emitNow({ type: 'ptm.booked', schoolId: u.school_id, aggregateType: 'communication.ptm', aggregateId: r.id, payload: { bookingId: r.id, slotId: req.params.id as string, studentId: b.studentId } });
    return r;
  }));
  api.get('/ptm/bookings', wrap(async req => { const u = requireUser(req); const staff = await myStaff(u); const guardian = await app.db.findOne<{ id: string }>('guardians', { school_id: u.school_id, user_id: u.id }); return app.communication.ptmBookings(u.school_id, { teacherId: staff?.id, guardianId: guardian?.id }); }));

  // ---------- diary ----------
  api.get('/diary', wrap(async req => { const u = requireUser(req); return app.communication.diary(u.school_id, { sectionId: q(req, 'sectionId'), studentId: q(req, 'studentId'), from: q(req, 'from'), to: q(req, 'to') }); }));
  api.post('/diary', wrap(async req => {
    const u = requirePerm(req, 'diary.create'); const b = diarySchema.parse(req.body);
    const staff = await myStaff(u);
    const r = await app.communication.addDiary(u.school_id, { ...b, teacherId: b.teacherId ?? staff?.id ?? null });
    await app.outbox.emitNow({ type: 'diary.published', schoolId: u.school_id, aggregateType: 'diary.entry', aggregateId: r.id, payload: { entryId: r.id, sectionId: b.sectionId, entryType: b.entryType ?? 'homework' } });
    return r;
  }));
  api.post('/diary/:id/ack', wrap(async req => { const u = requireUser(req); const b = z.object({ studentId: z.string() }).parse(req.body); const guardian = await app.db.findOne<{ id: string }>('guardians', { school_id: u.school_id, user_id: u.id }); return app.communication.ackDiary(u.school_id, req.params.id as string, b.studentId, guardian?.id ?? null); }));
  api.get('/diary/daily-reports', wrap(async req => { const u = requireUser(req); return app.communication.dailyReports(u.school_id, { sectionId: q(req, 'sectionId'), studentId: q(req, 'studentId'), onDate: q(req, 'date') ?? today() }); }));
  api.post('/diary/daily-reports', wrap(async req => { const u = requirePerm(req, 'diary.create'); const b = z.object({ studentId: z.string(), onDate: dateSchema, meals: z.unknown().optional(), napMinutes: z.coerce.number().optional().nullable(), mood: z.enum(['happy', 'calm', 'tired', 'upset', 'sick']).optional().nullable(), activities: z.unknown().optional(), notes: z.string().max(2000).optional().nullable(), send: z.coerce.boolean().optional() }).parse(req.body); const staff = await myStaff(u); return app.communication.saveDailyReport(u.school_id, { ...b, teacherId: staff?.id ?? null }); }));
  api.post('/diary/remarks', wrap(async req => { const u = requirePerm(req, 'diary.create'); const b = z.object({ studentId: z.string(), remark: z.string().min(2).max(2000), polarity: z.enum(['positive', 'neutral', 'concern']).optional(), visibleToGuardian: z.coerce.boolean().optional() }).parse(req.body); const staff = await myStaff(u); if (!staff) throw new HttpError(400, 'no staff record for this user'); return { id: await app.communication.addRemark(u.school_id, { ...b, teacherId: staff.id }) }; }));

  // ---------- teacher home (PWA v0) ----------
  api.get('/teach/me', wrap(async req => {
    const u = requireUser(req);
    const staff = await myStaff(u);
    if (!staff) throw new HttpError(403, 'this account is not linked to a staff record');
    const year = await app.academic.currentYear(u.school_id);
    const version = year ? await app.timetable.publishedVersion(u.school_id, String(year.id)) : null;
    const date = q(req, 'date') ?? today();
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    const grid = version ? await app.timetable.teacherGrid(u.school_id, String(version.id), staff.id) : [];
    const sections = await app.db.query(`SELECT DISTINCT sec.id, sec.name, c.name AS class_name, c.numeric_level FROM section_subject_teachers t JOIN sections sec ON sec.id = t.section_id JOIN classes c ON c.id = sec.class_id WHERE t.school_id = ? AND t.teacher_id = ? ORDER BY c.numeric_level, sec.name`, [u.school_id, staff.id]);
    const subs = await app.db.query(`SELECT s.*, p.name AS period_name, sec.name AS section_name, c.name AS class_name FROM timetable_substitutions s JOIN timetable_slots ts ON ts.id = s.slot_id JOIN periods p ON p.id = ts.period_id JOIN sections sec ON sec.id = ts.section_id JOIN classes c ON c.id = sec.class_id WHERE s.school_id = ? AND s.substitute_teacher_id = ? AND s.on_date >= ? AND s.status IN ('suggested','approved') ORDER BY s.on_date, p.sequence LIMIT 20`, [u.school_id, staff.id, date]);
    return { staff, date, today: grid.filter(g => Number(g.day_of_week) === dow), week: grid, sections, substitutions: subs, published: !!version };
  }));
}
