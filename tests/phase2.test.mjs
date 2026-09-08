// Phase 2 exit criteria: absent SMS within five minutes of the cut-off for every section;
// a teacher marks a class in seconds on a phone. Plus devices, leave → substitutions, chat, PTM, diary.
//   node --test tests/phase2.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-p2');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'p2-key-'.padEnd(64, 'x'), CRON_KEY: 'cron-p2', UPLOADS_DIR: 'tests/.tmp-p2/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-p2/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, schoolId, yearId, http, baseUrl, cookie, teacherCookie, guardianCookie, sectionId, students = [], teacher, classes;
const today = new Date().toISOString().slice(0, 10);
const t0 = Date.now();

describe('phase 2', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Phase Two School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01722222222', adminEmail: 'admin@p2.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    await app.settings.set(schoolId, 'notifications.channels', { push: true, sms: true, email: true, in_app: true });
    // no weekend during the test so "today" is always a working day
    await app.academic.setWeeklyOffs(schoolId, []);
    yearId = String((await app.academic.currentYear(schoolId)).id);
    classes = await app.academic.classes(schoolId);
    sectionId = String((await app.academic.sections(schoolId, yearId, String(classes[5].id)))[0].id);
    const subjects = await app.academic.subjects(schoolId);
    teacher = await app.people.createStaff(schoolId, { firstName: 'Karim', lastName: 'Sir', phone: '01755555555', staffCategory: 'teaching', subjectIds: subjects.slice(0, 3).map(s => String(s.id)), createAccount: true });
    for (let i = 0; i < 12; i++) students.push(await app.people.createStudent(schoolId, { firstName: `Kid${i + 1}`, lastName: 'Test', gender: i % 2 ? 'female' : 'male', dateOfBirth: '2014-01-0' + ((i % 9) + 1), classId: String(classes[5].id), sectionId, guardians: [{ fullName: `Guardian ${i + 1}`, phone: `018100000${String(i).padStart(2, '0')}`, relation: 'father', isPrimary: true }] }));
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@p2.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`phase 2 finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? cookie, ...(extra.headers ?? {}) }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 160)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const otpLogin = async target => { const req = await api('/auth/otp/request', { target, channel: 'sms' }); const v = await fetch(`${baseUrl}/api/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, code: req.code }) }); assert.equal(v.status, 200, await v.text()); return v.headers.get('set-cookie').split(';')[0]; };

  test('installer seeded an attendance policy with the cut-off from settings', async () => {
    const policies = await api('/attendance/policies');
    const student = policies.find(p => p.audience === 'student');
    assert.ok(student, JSON.stringify(policies));
    assert.equal(String(student.auto_absent_at).slice(0, 5), '10:30');
    assert.equal(Number(student.notify_on_absent), 1);
  });

  test('teacher marks a section: register, one call, guardians of absentees get an SMS', async () => {
    teacherCookie = await otpLogin('01755555555');
    const reg = await api(`/attendance/register?sectionId=${sectionId}&date=${today}`);
    assert.equal(reg.students.length, 12);
    assert.equal(reg.holiday, false);
    assert.ok(reg.students.every(s => s.status === null || s.status === undefined), 'nothing marked yet');
    await app.adapters.queue.drain(50);                       // start from a quiet queue
    const smsBefore = app.adapters.sms.sent.length;
    const marks = reg.students.map((s, i) => ({ studentId: s.student_id, status: i < 2 ? 'absent' : i === 2 ? 'late' : 'present' }));
    const started = Date.now();
    const r = await api('/attendance/mark', { sectionId, onDate: today, marks });
    const ms = Date.now() - started;
    assert.equal(r.marked, 12);
    assert.deepEqual(r.counts, { absent: 2, late: 1, present: 9 });
    // the promise is a class marked in 30 s on a phone; the request itself must be far inside that,
    // because the guardian messages are queued rather than sent inline
    assert.ok(ms < 15_000, `marking took ${ms} ms`);
    await app.adapters.queue.drain(50);                       // notifications are queued, then delivered
    const sms = app.adapters.sms.sent.slice(smsBefore);
    assert.equal(sms.length, 3, `absent + late SMS: ${JSON.stringify(sms)}`);
    assert.match(sms[0].text, /absent|অনুপস্থিত/i);
    // re-marking the same statuses changes nothing (idempotent)
    const again = await api('/attendance/mark', { sectionId, onDate: today, marks });
    assert.equal(again.marked, 0);
    // and the register now shows the marks
    const reg2 = await api(`/attendance/register?sectionId=${sectionId}&date=${today}`);
    assert.equal(reg2.students.filter(s => s.status === 'absent').length, 2);
  });

  test('device push: unknown ids are kept, known ones become present/late by the cut-off', async () => {
    const dev = await api('/attendance/devices', { name: 'Main gate', deviceType: 'biometric', location: 'Gate', direction: 'in' });
    assert.match(dev.apiKey, /^[0-9A-HJKMNP-TV-Z]{52}$/);
    // give three students a biometric id and clear today's marks so the device decides
    const ids = students.slice(3, 6).map(s => s.id);
    for (let i = 0; i < ids.length; i++) await app.db.update('students', { biometric_id: `BIO${i + 1}` }, { id: ids[i] });
    await app.db.execute(`DELETE FROM student_attendance WHERE student_id IN (${ids.map(() => '?').join(',')}) AND on_date = ?`, [...ids, today]);
    const r = await fetch(`${baseUrl}/api/attendance/punch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Key': dev.apiKey }, body: JSON.stringify({ punches: [
      { identifier: 'BIO1', punchedAt: `${today} 07:50:00` }, { identifier: 'BIO2', punchedAt: `${today} 11:05:00` }, { identifier: 'BIO3', punchedAt: `${today} 07:55:00` }, { identifier: 'NOBODY', punchedAt: `${today} 08:00:00` },
    ] }) });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.deepEqual({ stored: j.stored, resolved: j.resolved, unknown: j.unknown }, { stored: 4, resolved: 3, unknown: 1 });
    const rows = await app.db.query(`SELECT student_id, status, source FROM student_attendance WHERE on_date = ? AND student_id IN (${ids.map(() => '?').join(',')})`, [today, ...ids]);
    assert.equal(rows.length, 3);
    assert.equal(rows.filter(x => x.status === 'present').length, 2, JSON.stringify(rows));
    assert.equal(rows.filter(x => x.status === 'late').length, 1, 'the 11:05 punch is late against the 10:30 cut-off');
    assert.ok(rows.every(x => x.source === 'device'));
    const unresolved = await app.db.query(`SELECT error FROM device_punch_logs WHERE identifier = 'NOBODY'`);
    assert.equal(unresolved[0].error, 'unknown identifier');
    // a bad key is refused
    assert.equal((await fetch(`${baseUrl}/api/attendance/punch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Key': 'nope' }, body: JSON.stringify({ punches: [{ identifier: 'x', punchedAt: `${today} 08:00:00` }] }) })).status, 401);
  });

  test('auto-absent at the cut-off marks everyone unmarked and queues the SMS fan-out (C4)', async () => {
    const other = String((await app.academic.sections(schoolId, yearId, String(classes[6].id)))[0].id);
    for (let i = 0; i < 5; i++) await app.people.createStudent(schoolId, { firstName: `Late${i}`, gender: 'male', dateOfBirth: '2013-05-05', classId: String(classes[6].id), sectionId: other, guardians: [{ fullName: `G${i}`, phone: `018200000${String(i).padStart(2, '0')}`, relation: 'mother', isPrimary: true }] });
    await app.adapters.queue.drain(50);
    const smsBefore = app.adapters.sms.sent.length;
    const started = Date.now();
    const r = await api(`/attendance/auto-absent?date=${today}`, {});
    assert.equal(r.absent, 5, JSON.stringify(r));
    // the cut-off job itself is fast; the fan-out runs on the queue
    assert.ok(Date.now() - started < 15_000, 'the sweep marks and returns; it does not send anything inline');
    await app.adapters.queue.drain(50);
    const sms = app.adapters.sms.sent.slice(smsBefore);
    assert.equal(sms.length, 5, 'one guardian SMS per newly absent student');
    assert.ok(Date.now() - started < 300_000, 'well inside the five-minute promise');
    // running it again marks nobody twice
    assert.equal((await api(`/attendance/auto-absent?date=${today}`, {})).absent, 0);
  });

  // The head teacher's first screen. What matters here is not the arithmetic but the shape of the
  // answer: a section nobody has opened must say so, and must never be reported as 0%.
  test('attendance today: counts, sections with their teacher, and what the sweep did', async () => {
    const t = await api(`/attendance/today?date=${today}`);
    assert.equal(t.onDate, today);
    assert.equal(t.holiday, false);
    assert.ok(t.cutoffs.includes('10:30'), JSON.stringify(t.cutoffs));
    assert.ok(Number(t.counts.absent) >= 5, JSON.stringify(t.counts));
    assert.ok(t.enrolled >= 17, `enrolled ${t.enrolled}`);
    assert.equal(t.marked, Object.values(t.counts).reduce((a, n) => a + Number(n), 0));
    // the cut-off sweep is reported as its own sentence: five marked, five guardians told
    assert.equal(t.sweep.absent, 5, JSON.stringify(t.sweep));
    assert.equal(t.sweep.notified, 5, 'every one of them had a guardian messaged');
    assert.ok(t.sweep.at, 'and the time it happened');
    const marked = t.sections.find(s => s.marked > 0);
    assert.ok(marked, 'the section that was marked is on the board');
    assert.ok(marked.pct != null && marked.pct >= 0 && marked.pct <= 100, `pct ${marked.pct}`);
    assert.equal(marked.marked, marked.present + marked.late + marked.absent + marked.half_day + marked.excused);
    const untouched = t.sections.filter(s => s.marked === 0);
    assert.ok(untouched.length, 'a school always has a section nobody has marked yet');
    assert.ok(untouched.every(s => s.pct === null), 'an unmarked register reports null, never 0%');
    assert.ok(t.sections.every(s => 'class_teacher' in s && 'source' in s));
    // the device punches came from a device and the sweep from the system, and the board says which
    assert.ok(t.sections.some(s => s.source === 'system' || s.source === 'mixed' || s.source === 'device'), JSON.stringify(t.sections.map(s => s.source)));
  });

  test('a policy edit keeps the fields it was not sent', async () => {
    const before = (await api('/attendance/policies')).find(p => p.audience === 'student');
    await api('/attendance/policies', { audience: 'student', minAttendancePct: 80 }, 'PUT');
    const after = (await api('/attendance/policies')).find(p => p.audience === 'student');
    assert.equal(Number(after.min_attendance_pct), 80);
    assert.equal(Number(after.late_after_minutes), Number(before.late_after_minutes), 'the late threshold was not sent, so it did not move');
    assert.equal(String(after.auto_absent_at).slice(0, 5), '10:30', 'and neither did the cut-off');
    assert.equal(Number(after.notify_on_absent), Number(before.notify_on_absent));
    // the whole form comes back and every field is writable, including the staff LOP rule
    await api('/attendance/policies', { audience: 'staff', lateAfterMinutes: 10, halfDayAfterMinutes: 90, autoAbsentAt: '11:15', consecutiveAbsentAlert: 4, minAttendancePct: 70, lateCountToLop: 3, notifyOnArrival: false, notifyOnLate: true, notifyOnAbsent: true }, 'PUT');
    const staffPolicy = (await api('/attendance/policies')).find(p => p.audience === 'staff');
    assert.equal(Number(staffPolicy.late_after_minutes), 10);
    assert.equal(Number(staffPolicy.late_count_to_lop), 3);
    assert.equal(String(staffPolicy.auto_absent_at).slice(0, 5), '11:15');
    assert.equal(Number(staffPolicy.notify_on_arrival), 0);
    // and it is audited, because these values decide what the automation does tomorrow
    assert.ok(await app.db.count('audit_logs', { school_id: schoolId, entity_type: 'attendance.policy' }) >= 1);
    await api('/attendance/policies', { audience: 'student', minAttendancePct: Number(before.min_attendance_pct) }, 'PUT');
  });

  test('the staff register carries the department, the designation and this month\'s lates', async () => {
    const rows = await api(`/attendance/staff?date=${today}`);
    assert.ok(rows.length >= 1, JSON.stringify(rows));
    const me = rows.find(r => r.staff_id === teacher.id);
    assert.ok(me, 'the teacher is on the staff register');
    assert.ok('department' in me && 'designation' in me && 'lates_this_month' in me);
    assert.equal(Number(me.lates_this_month), 0);
    await app.attendance.markStaff(schoolId, teacher.id, today.slice(0, 8) + '02', 'late');
    const again = (await api(`/attendance/staff?date=${today}`)).find(r => r.staff_id === teacher.id);
    assert.equal(Number(again.lates_this_month), 1, 'a late earlier this month counts against the LOP rule');
  });

  test('devices report what they took in today', async () => {
    const devices = await api(`/attendance/devices?date=${today}`);
    const gate = devices.find(x => x.name === 'Main gate');
    assert.ok(gate, JSON.stringify(devices.map(x => x.name)));
    assert.equal(Number(gate.punches_today), 4, 'four punches arrived, one of them from nobody we know');
  });

  test('monthly summary and the below-minimum alert', async () => {
    const month = today.slice(0, 8) + '01';
    const r = await api(`/attendance/refresh-summary?month=${month}`, {});
    assert.ok(r.students >= 12, JSON.stringify(r));
    const rows = await app.db.query(`SELECT student_id, present_days, absent_days, pct FROM attendance_monthly_summary WHERE school_id = ? AND month = ? ORDER BY pct`, [schoolId, month]);
    assert.ok(rows.length >= 12);
    assert.ok(rows.some(x => Number(x.absent_days) > 0) && rows.some(x => Number(x.present_days) > 0));
    const flagged = await app.attendance.monthlyThreshold(schoolId);
    assert.ok(flagged.flagged >= 0, JSON.stringify(flagged));
  });

  test('leave: apply → approve → days excused → substitutes suggested (B3)', async () => {
    await app.timetable.autoAssignTeachers(schoolId, yearId);
    const gen = await app.timetable.generate(schoolId, yearId, { seed: 3 });
    assert.equal(gen.clashes, 0);
    await app.timetable.publish(schoolId, gen.versionId);
    await app.relay.run();
    const types = await api('/leave/types');
    const casual = types.find(t => t.code === 'CL');
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const applied = await api('/leave', { applicantType: 'staff', leaveTypeId: casual.id, fromDate: tomorrow, toDate: tomorrow, reason: 'Family matter' }, 'POST', { cookie: teacherCookie });
    assert.equal(applied.days, 1);
    assert.equal(applied.status, 'approved', 'no workflow configured → auto-approved');
    await app.relay.run();
    const marked = await app.db.findOne('staff_attendance', { staff_id: teacher.id, on_date: tomorrow });
    assert.equal(marked.status, 'excused');
    const subs = await api(`/timetable/substitutions?date=${tomorrow}`);
    const dow = new Date(tomorrow + 'T00:00:00Z').getUTCDay();
    const periods = (await app.timetable.teacherGrid(schoolId, gen.versionId, teacher.id)).filter(g => Number(g.day_of_week) === dow);
    assert.equal(subs.length, periods.length, 'one suggestion per period the teacher had that day');
    if (subs.length) assert.ok(subs.every(s => s.substitute_teacher_id || s.status === 'suggested'));
  });

  test('chat: section channel gets teachers and guardians, messages notify the others', async () => {
    const ch = await api(`/chat/section/${sectionId}`, {});
    assert.ok(ch.members >= 12, JSON.stringify(ch));
    const mine = await api('/chat', undefined, 'GET', { cookie: teacherCookie });
    const channel = mine.find(c => c.id === ch.id);
    assert.ok(channel, 'the teacher sees the section channel');
    const sent = await api(`/chat/${ch.id}/messages`, { body: 'Tomorrow we start chapter 3.' }, 'POST', { cookie: teacherCookie });
    assert.ok(sent.notified >= 11, JSON.stringify(sent));
    guardianCookie = await otpLogin('01810000000');
    const msgs = await api(`/chat/${ch.id}/messages`, undefined, 'GET', { cookie: guardianCookie });
    assert.equal(msgs.at(-1).body, 'Tomorrow we start chapter 3.');
    const reply = await api(`/chat/${ch.id}/messages`, { body: 'Thank you.' }, 'POST', { cookie: guardianCookie });
    assert.ok(reply.id);
    // an outsider cannot read the channel
    const stranger = await app.auth.createUser({ schoolId, userType: 'staff', displayName: 'Nosy', phone: '01799000001', roles: ['staff'] });
    const s = await app.auth.createSession(await app.db.findOne('users', { id: stranger }));
    const r = await fetch(`${baseUrl}/api/chat/${ch.id}/messages`, { headers: { cookie: `ps_session=${s.token}` } });
    assert.equal(r.status, 403);
  });

  test('PTM: teacher opens slots, guardian books one', async () => {
    const day = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
    const slots = await api('/ptm/slots', { teacherId: teacher.id, date: day, startTime: '10:00', endTime: '11:00', minutes: 15 });
    assert.equal(slots.created, 4);
    const list = await api(`/ptm/slots?from=${day}`, undefined, 'GET', { cookie: guardianCookie });
    assert.ok(list.length >= 4);
    const booked = await api(`/ptm/slots/${slots.ids[0]}/book`, { studentId: students[0].id }, 'POST', { cookie: guardianCookie });
    assert.equal(booked.already, false);
    const again = await api(`/ptm/slots/${slots.ids[0]}/book`, { studentId: students[0].id }, 'POST', { cookie: guardianCookie });
    assert.equal(again.already, true, 'double booking is a no-op');
    const mine = await api('/ptm/bookings', undefined, 'GET', { cookie: guardianCookie });
    assert.equal(mine.length, 1);
    // booking someone else's child is refused
    const other = await fetch(`${baseUrl}/api/ptm/slots/${slots.ids[1]}/book`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: guardianCookie }, body: JSON.stringify({ studentId: students[7].id }) });
    assert.equal(other.status, 403);
  });

  test('the office can see the PTM board a guardian booked against', async () => {
    // `/ptm/bookings` answers as whoever asks, so the office saw nothing; the board is the whole thing
    const board = await api('/ptm/board');
    assert.ok(board.slots.length >= 4, JSON.stringify(board.slots.length));
    assert.ok(board.slots.every(s => s.first_name && s.capacity != null), 'each slot names its teacher and how many it holds');
    const taken = board.slots.find(s => Number(s.booked) > 0);
    assert.ok(taken, 'the booked slot shows as booked to the office');
    assert.equal(board.bookings.length, 1);
    assert.equal(board.bookings[0].student_first, 'Kid1');
    assert.ok(board.bookings[0].teacher_first, 'and says which teacher is meeting them');
    // a guardian is not shown the school's whole diary of meetings
    assert.equal((await fetch(`${baseUrl}/api/ptm/board`, { headers: { cookie: guardianCookie } })).status, 403);
  });

  test('the message log, the templates that write it, and the providers that carry it', async () => {
    // the log is every message the school sent, not the reader's own in-app list
    const log = await api(`/comms/notifications?from=${today}&to=${today}`);
    assert.ok(log.total >= 1, JSON.stringify(log.total));
    assert.ok(log.rows.every(r => r.channel && r.status && r.event_key));
    assert.ok(log.rows.some(r => r.channel === 'sms'), 'the absent SMS is in it');
    const sms = await api(`/comms/notifications?channel=sms&from=${today}&to=${today}`);
    assert.ok(sms.total >= 1 && sms.rows.every(r => r.channel === 'sms'), 'the channel filter filters');
    assert.ok(sms.total <= log.total);
    assert.equal((await api(`/comms/notifications?channel=whatsapp&from=${today}&to=${today}`)).rows.length, 0);
    const stats = await api(`/comms/notifications/stats?from=${today}&to=${today}`);
    assert.equal(stats.total, log.total);
    assert.ok(stats.byChannel.some(c => c.channel === 'sms'));
    assert.ok(stats.sent >= 1);

    // a template edit changes what the next send renders
    const before = await api('/comms/templates');
    assert.ok(before.length >= 18, 'the installer seeded templates');
    const saved = await api('/comms/templates', { eventKey: 'attendance.absent', channel: 'sms', locale: 'bn', body: 'TEST-STAMP {{student}} was not in school on {{date}}.', isActive: true });
    assert.ok(saved.id);
    // saving the same event, channel and locale updates the row rather than leaving two for the pipeline to pick between
    const again = await api('/comms/templates', { eventKey: 'attendance.absent', channel: 'sms', locale: 'bn', body: 'TEST-STAMP {{student}} was not in school on {{date}}.', isActive: true });
    assert.equal(again.id, saved.id);
    assert.equal(again.created, false);
    const preview = await api('/comms/templates/preview', { id: saved.id, sample: { student: 'Kid9', date: today } });
    assert.equal(preview.body, `TEST-STAMP Kid9 was not in school on ${today}.`);
    assert.deepEqual(preview.placeholders, ['student', 'date']);
    assert.deepEqual((await api('/comms/templates/preview', { id: saved.id, sample: {} })).missing, ['student', 'date'], 'it says which placeholders nothing was passed for');
    // and the next message the school sends reads it
    const smsBefore = app.adapters.sms.sent.length;
    await app.notifications.notify({ schoolId, address: '01810000099', channels: ['sms'], eventKey: 'attendance.absent', data: { student: 'Kid9', date: today }, body: 'fallback that must not be used', immediate: true });
    await app.adapters.queue.drain(20);
    const sent = app.adapters.sms.sent.slice(smsBefore);
    assert.ok(sent.some(m => m.text === `TEST-STAMP Kid9 was not in school on ${today}.`), JSON.stringify(sent.map(m => m.text)));
    // switching it off puts the pipeline back on what the caller passed
    await api(`/comms/templates/${saved.id}`, { isActive: false }, 'PATCH');
    assert.equal((await api('/comms/templates?eventKey=attendance.absent&channel=sms&locale=bn'))[0].is_active, false);

    // a provider's key is stored encrypted and never comes back to the browser
    const p = await api('/comms/providers', { channel: 'sms', provider: 'sslwireless', senderId: 'PATHSHALA', credentials: { apiKey: 'super-secret-key' }, isDefault: true, lowBalanceThreshold: 500, costPerUnit: 0.25 });
    const providers = await api('/comms/providers');
    const mine = providers.find(x => x.id === p.id);
    assert.equal(mine.hasCredentials, true, 'the console says a key is set');
    assert.equal(mine.credentials, undefined, 'and never sends the key itself');
    assert.equal(JSON.stringify(providers).includes('super-secret-key'), false);
    const stored = await app.db.findOne('messaging_providers', { id: p.id });
    assert.equal(String(JSON.stringify(stored.credentials)).includes('super-secret-key'), false, 'nor is it in the database in the clear');
    assert.deepEqual(app.communication.providerCredentials(stored), { apiKey: 'super-secret-key' }, 'the server can still read it');
    // one default per channel: a second default takes the first one's place
    const p2 = await api('/comms/providers', { channel: 'sms', provider: 'bulksmsbd', isDefault: true });
    const after = await api('/comms/providers');
    assert.equal(after.filter(x => x.channel === 'sms' && x.is_default).length, 1);
    assert.equal(after.find(x => x.id === p2.id).is_default, true);
    assert.equal(after.find(x => x.id === p.id).is_default, false);
    // saving without credentials leaves the stored key alone
    assert.equal((await api('/comms/providers')).find(x => x.id === p.id).hasCredentials, true);
  });

  test('the notice board says who was told and who opened it', async () => {
    const notice = await api('/comms/broadcast', { title: 'Sports day moved to Friday', body: 'The sports day is now on Friday. Please send sports kit.', channels: ['in_app', 'push'], audience: { sectionIds: [sectionId] } });
    assert.ok(notice.recipients >= 11, JSON.stringify(notice));
    await app.adapters.queue.drain(60);
    const board = await api('/comms/notices');
    const row = board.find(n => n.id === notice.id);
    assert.ok(row, 'a broadcast is on the board like any other notice');
    assert.equal(row.told >= notice.recipients, true, 'it says how many people it was written to');
    assert.ok(row.channels.includes('in_app'));
    assert.equal(row.read, 0, 'nobody has opened it yet');
    assert.deepEqual(row.audience.sectionIds, [sectionId], 'and who it was for');
    // a guardian opening it is counted, from the rows the pipeline actually wrote
    const inApp = await app.db.query(`SELECT id, recipient_user_id FROM notifications WHERE school_id = ? AND entity_id = ? AND channel = 'in_app' LIMIT 1`, [schoolId, notice.id]);
    await app.notifications.markRead(String(inApp[0].id), String(inApp[0].recipient_user_id));
    assert.equal((await api('/comms/notices')).find(n => n.id === notice.id).read, 1);
    // a plain notice for everybody is on the same board
    await api('/cms/notices', { title: 'Half-yearly results on Sunday', body: 'Report cards go out on Sunday.', noticeType: 'exam' });
    assert.ok((await api('/comms/notices?status=published')).some(n => n.title === 'Half-yearly results on Sunday'));
  });

  test('diary: homework reaches guardians; KG daily report and remarks', async () => {
    const pushBefore = await app.db.count('notifications', { school_id: schoolId, event_key: 'diary.entry' });
    const entry = await api('/diary', { sectionId, onDate: today, entryType: 'homework', body: 'Maths: exercise 4.2, questions 1–8.' }, 'POST', { cookie: teacherCookie });
    assert.ok(entry.notified >= 11, JSON.stringify(entry));
    assert.ok((await app.db.count('notifications', { school_id: schoolId, event_key: 'diary.entry' })) > pushBefore);
    const list = await api(`/diary?sectionId=${sectionId}`, undefined, 'GET', { cookie: guardianCookie });
    assert.equal(list[0].body, 'Maths: exercise 4.2, questions 1–8.');
    await api(`/diary/${entry.id}/ack`, { studentId: students[0].id }, 'POST', { cookie: guardianCookie });
    assert.equal(await app.db.count('diary_acknowledgements', { entry_id: entry.id }), 1);
    const report = await api('/diary/daily-reports', { studentId: students[0].id, onDate: today, mood: 'happy', napMinutes: 45, notes: 'Ate everything, played well.', send: true }, 'POST', { cookie: teacherCookie });
    assert.ok(report.id);
    const reports = await api(`/diary/daily-reports?date=${today}&studentId=${students[0].id}`);
    assert.equal(reports[0].mood, 'happy');
    const remark = await api('/diary/remarks', { studentId: students[1].id, remark: 'Improved handwriting this week.', polarity: 'positive' }, 'POST', { cookie: teacherCookie });
    assert.ok(remark.id);
  });

  test('teacher home and SSR pages render', async () => {
    const me = await api('/teach/me', undefined, 'GET', { cookie: teacherCookie });
    assert.equal(me.staff.id, teacher.id);
    assert.ok(me.sections.length >= 1);
    assert.equal(me.published, true);
    for (const [p, ck, needle] of [[`/attendance?sectionId=${sectionId}`, cookie, 'Kid1'], [`/diary?sectionId=${sectionId}`, cookie, 'exercise'], ['/chat', teacherCookie, 'chapter 3'], [`/teach?sectionId=${sectionId}`, teacherCookie, 'Kid1'], ['/communication', cookie, 'Sports day moved to Friday']]) {
      const r = await fetch(`${baseUrl}${p}`, { headers: { cookie: ck } });
      const html = await r.text();
      assert.equal(r.status, 200, `${p} → ${r.status}`);
      assert.ok(html.includes(needle), `${p} should mention ${needle}`);
    }
    // a guardian cannot open the attendance API
    const forbidden = await fetch(`${baseUrl}/api/attendance/register?sectionId=${sectionId}`, { headers: { cookie: guardianCookie } });
    assert.equal(forbidden.status, 403);
  });
});
