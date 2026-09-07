// Year 2, third batch: the numbers, the megaphone, and the two ways a school marks work.
// Metrics computed from the register, anomalies measured against this school's own habits, risk
// scores that carry their reasons; broadcasts targeted at an audience and delivered on WhatsApp and
// by voice call; competency assessment beside marks, OMR sheets a person checks when the machine is
// unsure, and board registration through to the imported result.
//   node --test tests/year2c.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-y2c');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'y2c-key'.padEnd(64, 'x'), CRON_KEY: 'cron-y2c', UPLOADS_DIR: 'tests/.tmp-y2c/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-y2c/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, schoolId, yearId, termId, classId, sectionId, classSubjectId, http, baseUrl, cookie, scheduleId, examId;
const students = [];
const t0 = Date.now();
const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('year 2: analytics, broadcasts, competency & board', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Measured School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01788888888', adminEmail: 'admin@y2c.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    await app.settings.set(schoolId, 'notifications.channels', { push: true, sms: true, email: true, in_app: true, whatsapp: true, voice: true });
    yearId = String((await app.academic.currentYear(schoolId)).id);
    const terms = await app.db.findMany('terms', { school_id: schoolId, academic_year_id: yearId }, { limit: 1 });
    termId = terms.length ? String(terms[0].id) : await app.academic.addTerm(schoolId, yearId, { name: 'First term', sequence: 1, startDate: `${new Date().getUTCFullYear()}-01-01`, endDate: `${new Date().getUTCFullYear()}-06-30` });
    const classes = await app.academic.classes(schoolId);
    classId = String(classes[7].id);
    sectionId = String((await app.academic.sections(schoolId, yearId, classId))[0].id);
    classSubjectId = String((await app.academic.classSubjects(schoolId, yearId, classId))[0].id);
    for (let i = 0; i < 6; i++) students.push(await app.people.createStudent(schoolId, { firstName: `Pupil${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2011-07-07', classId, sectionId, admissionDate: '2021-01-05', guardians: [{ fullName: `Guardian ${i + 1}`, phone: `0193200000${i}`, relation: 'mother', isPrimary: true, paysFees: true }] }));
    // a class teacher with an account, so a risk flagged in the night reaches somebody
    const teacher = await app.people.createStaff(schoolId, { firstName: 'Rehana', lastName: 'Parvin', phone: '01911440001', staffCategory: 'teaching', joinDate: '2022-01-01', gender: 'female' });
    if (!teacher.userId) {
      const uid = await app.auth.createUser({ schoolId, userType: 'staff', displayName: 'Rehana Parvin', username: 'rehana', roles: ['teacher'] });
      await app.db.update('staff', { user_id: uid }, { id: teacher.id });
    }
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@y2c.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`year 2c finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET') => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 160)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const notified = async key => Number((await app.db.query(`SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND event_key = ?`, [schoolId, key]))[0].n);

  // ---------------- analytics ----------------
  test('a metric is computed from the register, not typed in', async () => {
    // three of six present today
    for (const [i, s] of students.entries()) await app.attendance.mark(schoolId, s.id, day(0), i < 3 ? 'present' : 'absent', { notify: false });
    const r = await api('/analytics/compute', {});
    assert.equal(r.values.attendance_pct, 50);
    assert.equal(r.values.students_active, students.length);
    const kpi = await app.db.findOne('kpi_daily', { school_id: schoolId, day: day(0) });
    assert.equal(Number(kpi.attendance_pct), 50, 'the dashboards read the same number');
    const dash = await api('/analytics/dashboard');
    const card = dash.cards.find(c => c.key === 'attendance_pct');
    assert.equal(card.value, 50);
    assert.equal(card.warn, true, 'below the 80% the catalogue warns at');
    assert.equal(card.unit, '%');
  });

  test('an anomaly is measured against this school’s own habits, and is raised once', async () => {
    // a fortnight of ordinary days at about 90%
    const metric = (await app.db.findMany('metrics', { school_id: schoolId, key_name: 'attendance_pct' }))[0];
    for (let i = 14; i >= 1; i--) {
      await app.db.insert('metric_values', { id: `MV${String(i).padStart(24, '0')}`, school_id: schoolId, metric_id: String(metric.id), period: day(-i), dimension: null, value: 90 + (i % 3) });
    }
    // today's 50% is nothing like them
    const found = await api('/analytics/compute', { day: day(0) });
    const flagged = found.anomalies.find(a => a.metricKey === 'attendance_pct');
    assert.ok(flagged, JSON.stringify(found.anomalies));
    assert.equal(flagged.expected, 91);
    assert.equal(flagged.actual, 50);
    assert.equal(flagged.severity, 'critical');
    assert.ok(await notified('analytics.anomaly') >= 1, 'somebody is told the same morning');
    // running it again does not raise a second alert for the same metric
    await api('/analytics/compute', { day: day(0) });
    assert.equal((await api('/analytics/alerts')).filter(a => String(a.metric_key) === 'attendance_pct').length, 1);
    const alert = (await api('/analytics/alerts'))[0];
    await api(`/analytics/alerts/${alert.id}/status`, { status: 'resolved' });
    assert.equal((await api('/analytics/alerts?status=resolved')).length, 1);
  });

  test('a risk score carries the reasons, and one crossing the line names the child once', async () => {
    // one child missing most of the last month, with an old unpaid bill
    const struggling = students[3];
    for (let i = 1; i <= 20; i++) await app.attendance.mark(schoolId, struggling.id, day(-i), i % 4 === 0 ? 'present' : 'absent', { notify: false });
    for (let i = 1; i <= 20; i++) await app.attendance.mark(schoolId, students[0].id, day(-i), 'present', { notify: false });
    const head = (await api('/fees/overview')).heads[0];
    const invoice = await api('/fees/invoices', { studentId: struggling.id, items: [{ feeHeadId: String(head.id), description: 'Tuition', amount: 2000 }], issueDate: day(-70) });
    await app.db.execute(`UPDATE invoices SET due_date = ? WHERE id = ?`, [day(-60), invoice.id]);

    const r = await api('/analytics/risks/compute', {});
    assert.equal(r.students, students.length);
    assert.ok(r.flagged >= 1, `${r.flagged} flagged`);
    const risks = await api(`/analytics/risks?studentId=${struggling.id}`);
    const attendance = risks.find(x => String(x.risk_type) === 'attendance');
    assert.ok(attendance, JSON.stringify(risks.map(x => x.risk_type)));
    assert.ok(Number(attendance.score) > 60);
    if (!attendance.factors || !attendance.factors.why) console.log('DEBUG factors', JSON.stringify(attendance));
    assert.match(String((attendance.factors.why ?? []).join(' ')), /present [\d.]+% of \d+ days/, 'the score says why, or a teacher can do nothing with it');
    const dropout = risks.find(x => String(x.risk_type) === 'dropout');
    assert.ok(dropout, 'attendance and fees together are what dropping out looks like');
    assert.equal(dropout.factors.why.length, 2);
    assert.ok(await notified('analytics.risk') >= 1);

    // running it again does not tell the teacher a second time
    const before = await notified('analytics.risk');
    await api('/analytics/risks/compute', {});
    assert.equal(await notified('analytics.risk'), before, 'a warning repeated nightly becomes wallpaper');
    // a child with nothing wrong carries no score at all
    assert.equal((await api(`/analytics/risks?studentId=${students[0].id}`)).length, 0);
    await api(`/analytics/risks/${attendance.id}/acknowledge`, {});
    assert.ok((await app.db.findOne('risk_scores', { id: attendance.id })).acknowledged_by);
  });

  test('the benchmark shows quartiles and never another school’s figure', async () => {
    // three schools of the same kind, so the cohort is big enough to hide one
    for (const name of ['Neighbour A', 'Neighbour B']) {
      const other = await app.installer.addTenant({ schoolName: name, institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: `0181000000${name.endsWith('A') ? 1 : 2}`, adminEmail: `${name.replace(/\W/g, '').toLowerCase()}@y2c.test`, adminPassword: 'secret-pass-1' });
      await app.installer.finish(other.schoolId);
      const m = await app.analytics.ensureMetrics(other.schoolId);
      assert.ok(m >= 1);
      const metric = (await app.db.findMany('metrics', { school_id: other.schoolId, key_name: 'attendance_pct' }))[0];
      for (let i = 1; i <= 5; i++) await app.db.insert('metric_values', { id: `MB${other.schoolId.slice(-6)}${String(i).padStart(18, '0')}`, school_id: other.schoolId, metric_id: String(metric.id), period: day(-i), dimension: null, value: name.endsWith('A') ? 95 : 70 });
    }
    const built = await app.analytics.buildBenchmarks();
    assert.ok(built.written >= 1, JSON.stringify(built));
    const mine = await api('/analytics/benchmark');
    const attendance = mine.metrics.find(m => m.metricKey === 'attendance_pct');
    assert.ok(attendance, JSON.stringify(mine));
    assert.ok(attendance.p25 <= attendance.p50 && attendance.p50 <= attendance.p75);
    assert.ok(attendance.standing, 'the school is told where it sits');
    assert.ok(!JSON.stringify(mine).includes('Neighbour'), 'and never who is above or below it');
  });

  // ---------------- broadcast ----------------
  test('a broadcast reaches an audience the school did not have to type out', async () => {
    const preview = await api('/comms/broadcast/preview', { audience: { guardians: true, classIds: [classId] } });
    assert.equal(preview.recipients, students.length);
    assert.equal(preview.withPhone, students.length);
    const dues = await api('/comms/broadcast/preview', { audience: { guardians: true, withDues: true } });
    assert.equal(dues.recipients, 1, 'only the family with an unpaid bill');

    const sent = await api('/comms/broadcast', { title: 'School closed tomorrow', body: 'Heavy rain is forecast. The school will stay closed on Thursday.', channels: ['sms', 'in_app', 'whatsapp', 'voice'], audience: { guardians: true, classIds: [classId] }, urgent: true });
    assert.equal(sent.recipients, students.length);
    await app.adapters.queue.drain(50);
    const status = await api(`/comms/broadcast/${sent.id}`);
    const byChannel = Object.fromEntries(status.delivery.map(d => [`${d.channel}:${d.status}`, Number(d.n)]));
    assert.equal(byChannel['whatsapp:sent'], students.length, JSON.stringify(byChannel));
    assert.equal(byChannel['voice:sent'], students.length);
    assert.equal(app.adapters.whatsapp.sent.length, students.length, 'the WhatsApp adapter was actually called');
    assert.equal(app.adapters.voice.placed.length, students.length, 'and so was the voice gateway');
    assert.match(app.adapters.voice.placed[0].text, /School closed tomorrow\. Heavy rain/, 'a call reads the title out too — there is no subject line in a phone call');
    // an audience nobody matches is refused rather than sent to nobody
    await assert.rejects(() => api('/comms/broadcast', { title: 'Nobody at all', body: 'This should reach no one.', audience: { classIds: ['no-such-class'], guardians: true } }), /matches nobody/);
  });

  // ---------------- competency, OMR, board ----------------
  test('competency assessment says which indicators are met, and which are not', async () => {
    const scaleId = (await api('/exams/competency/scales', {})).id;
    const outcomes = [];
    for (const [code, statement] of [['1.1', 'Reads a simple paragraph aloud with understanding'], ['1.2', 'Writes five sentences about a picture'], ['2.1', 'Adds two-digit numbers with carrying']]) {
      outcomes.push((await api('/exams/competency/outcomes', { classSubjectId, code, statement })).id);
    }
    assert.equal((await api(`/exams/competency/outcomes?classSubjectId=${classSubjectId}`)).length, 3);
    const saved = await api('/exams/competency/assess', { rows: [
      { studentId: students[0].id, outcomeId: outcomes[0], termId, levelCode: '□' },
      { studentId: students[0].id, outcomeId: outcomes[1], termId, levelCode: '○' },
      { studentId: students[0].id, outcomeId: outcomes[2], termId, levelCode: '△' },
    ] });
    assert.equal(saved.saved, 3);
    await assert.rejects(() => api('/exams/competency/assess', { rows: [{ studentId: students[0].id, outcomeId: outcomes[0], termId, levelCode: 'A+' }] }), /not a level on the/);

    const report = await api(`/exams/competency/report?studentId=${students[0].id}&termId=${termId}`);
    assert.equal(report.assessed, 3);
    assert.equal(report.achieved, 1);
    assert.equal(report.stillToMeet.length, 2);
    assert.equal(report.stillToMeet[0].statement, 'Writes five sentences about a picture', 'a parent is told what to work on, not a number');
    // re-rating replaces rather than piling up
    await api('/exams/competency/assess', { rows: [{ studentId: students[0].id, outcomeId: outcomes[1], termId, levelCode: '□' }] });
    const after = await api(`/exams/competency/report?studentId=${students[0].id}&termId=${termId}`);
    assert.equal(after.assessed, 3);
    assert.equal(after.achieved, 2);
  });

  test('an OMR sheet the machine is unsure about waits for a person', async () => {
    examId = (await api('/exams', { name: 'Model test', startDate: day(1), endDate: day(2), classIds: [classId] })).id;
    scheduleId = String((await api(`/exams/${examId}/schedules`))[0].id);
    const roll = String((await app.db.findOne('students', { id: students[0].id })).current_roll_no ?? '');
    const file = await app.files.store({ schoolId, data: Buffer.from('scan'), fileName: 'sheet.png', mimeType: 'image/png', purpose: 'omr' });
    const r = await api('/exams/omr', { sheets: [
      { fileId: file.id, scheduleId, detectedRoll: roll, score: 72, confidence: 98 },
      { fileId: file.id, scheduleId, detectedRoll: roll, score: 55, confidence: 61 },
      { fileId: file.id, scheduleId, detectedRoll: 'ZZZ', score: 40, confidence: 99 },
    ] });
    assert.equal(r.stored, 3);
    assert.equal(r.processed, 1, 'only the one that was both confident and matched');
    assert.equal(r.needReview, 2, 'a low-confidence read and an unknown roll both wait for a person');

    const waiting = await api(`/exams/omr?status=needs_review`);
    assert.equal(waiting.length, 2);
    await api(`/exams/omr/${String(waiting[0].id)}/review`, { studentId: students[1].id, score: 55 });
    await api(`/exams/omr/${String(waiting[1].id)}/review`, { reject: true });
    const applied = await api(`/exams/omr/apply/${scheduleId}`, {});
    assert.equal(applied.applied, 2, 'the confident one and the one a person confirmed');
    const grid = await api(`/exams/marks?scheduleId=${scheduleId}`);
    assert.equal(Number(grid.students.find(s => String(s.student_id) === students[0].id).total_obtained), 72);
    assert.equal(Number(grid.students.find(s => String(s.student_id) === students[1].id).total_obtained), 55);
  });

  test('a board form is checked against what the child was taught, and the result comes back to it', async () => {
    const subject = String((await app.db.query(`SELECT sub.name FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id WHERE cs.id = ?`, [classSubjectId]))[0].name);
    await assert.rejects(() => api('/exams/board', { studentId: students[0].id, board: 'Dhaka', examName: 'SSC 2028', subjects: [subject, 'Astrophysics'] }), /not taught in this class/);
    const reg = await api('/exams/board', { studentId: students[0].id, board: 'Dhaka', examName: 'SSC 2028', groupName: 'Science', subjects: [subject], centre: 'Govt High School' });
    assert.ok(reg.id);
    assert.equal((await api('/exams/board', { studentId: students[0].id, board: 'Dhaka', examName: 'SSC 2028' })).alreadyRegistered, true);
    await assert.rejects(() => api(`/exams/board/${reg.id}/submit`, { fee: 1500 }), /registration number has to be on the form/);
    await app.db.execute(`UPDATE board_registrations SET registration_no = ?, roll_no = ? WHERE id = ?`, ['1901234567', '512345', reg.id]);
    const submitted = await api(`/exams/board/${reg.id}/submit`, { fee: 1500 });
    assert.ok(submitted.invoiceId, 'the board fee is a bill the guardian can see, not cash in an envelope');
    assert.equal(Math.round(Number((await app.fees.invoice(schoolId, submitted.invoiceId)).total)), 1500);

    const imported = await api('/exams/board/results', { examName: 'SSC 2028', results: [
      { registrationNo: '1901234567', gpa: 4.83, grade: 'A' },
      { rollNo: '999999', gpa: 5, grade: 'A+' },
    ] });
    assert.equal(imported.matched, 1);
    assert.deepEqual(imported.unmatched, ['999999'], 'a result for somebody we never registered is reported, not guessed at');
    const rows = await api('/exams/board?exam=SSC%202028');
    assert.equal(String(rows[0].status), 'result_received');
    assert.equal(rows[0].board_result.gpa, 4.83);
  });
});
