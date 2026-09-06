// Phase 4 exit criterion: annual results for 1,500 students published with PDFs in under 10 minutes
// on shared hosting (chunked job). Also: eligibility, marks entry with lock, the result engine
// (GPA, F->0, ranks with ties), promotion, question papers, online exams, guardian view.
//   node --test tests/phase4.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-p4');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'p4-key-'.padEnd(64, 'x'), CRON_KEY: 'cron-p4', UPLOADS_DIR: 'tests/.tmp-p4/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-p4/pathshala.db'; delete process.env.DB_URL; }
const BIG = process.env.PHASE4_BIG === '1';   // the full 1,500-student run; CI and dev use 120 by default

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, schoolId, yearId, http, baseUrl, cookie, guardianCookie, examId, classes, sectionId, students = [], firstGuardianPhone;
const t0 = Date.now();
const N = BIG ? 1500 : 120;

describe('phase 4', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Phase Four School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01744444444', adminEmail: 'admin@p4.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    yearId = String((await app.academic.currentYear(schoolId)).id);
    classes = await app.academic.classes(schoolId);
    const sections = await app.academic.sections(schoolId, yearId, String(classes[5].id));
    sectionId = String(sections[0].id);
    // students spread over two sections of one class so ranks have something to rank
    const secondSection = String((await app.academic.sections(schoolId, yearId, String(classes[5].id)))[1]?.id ?? sectionId);
    for (let i = 0; i < N; i++) {
      students.push(await app.people.createStudent(schoolId, { firstName: `Exam${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2013-04-04', classId: String(classes[5].id), sectionId: i % 2 ? sectionId : secondSection, guardians: i < 3 ? [{ fullName: `Parent ${i + 1}`, phone: `0184000000${i}`, relation: 'father', isPrimary: true }] : [] }));
    }
    firstGuardianPhone = '01840000000';
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@p4.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`phase 4 finished in ${Date.now() - t0} ms on ${app?.db.engine} (${N} students)`); });

  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 200)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const saveMarks = async (scheduleId, rows) => { let saved = 0; for (let i = 0; i < rows.length; i += 400) saved += (await api('/exams/marks', { scheduleId, marks: rows.slice(i, i + 400) })).saved; return saved; };
  const otpLogin = async target => { const req = await api('/auth/otp/request', { target, channel: 'sms' }); const v = await fetch(`${baseUrl}/api/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, code: req.code }) }); return v.headers.get('set-cookie').split(';')[0]; };

  test('exam types and the GPA 5.0 scale are seeded; creating an exam schedules every subject', async () => {
    const { types, scales } = await api('/exams');
    assert.equal(types.length, 3, JSON.stringify(types));
    const gpa5 = scales.find(s => Number(s.gpa_max) === 5);
    assert.ok(gpa5, 'the Bangladesh GPA 5.0 scale');
    assert.equal(gpa5.bands.length, 7);
    assert.equal(Number(gpa5.fail_gpa_zero), 1, 'failing one subject zeroes the GPA');
    const r = await api('/exams', { name: 'Annual 2026', startDate: '2026-11-01', endDate: '2026-11-20', classIds: [String(classes[5].id)], requireFeeClearance: false });
    examId = r.id;
    assert.ok(r.schedules >= 6, `one schedule per class subject: ${r.schedules}`);
    const schedules = await api(`/exams/${examId}/schedules`);
    assert.equal(schedules.length, r.schedules);
    assert.ok(schedules.every(s => Number(s.full_marks) === 100 && Number(s.pass_marks) === 33));
  });

  test('seat plan marks students with unpaid fees ineligible when the exam requires clearance', async () => {
    // an exam that requires clearance, with one student owing money
    const strict = await api('/exams', { name: 'Strict test', startDate: '2026-12-01', endDate: '2026-12-05', classIds: [String(classes[5].id)], requireFeeClearance: true });
    await app.fees.createInvoice(schoolId, { studentId: students[0].id, academicYearId: yearId, items: [{ description: 'Tuition', amount: 900 }] });
    const r = await api(`/exams/${strict.id}/seat-plan`, {});
    assert.equal(r.seated + r.ineligible, N);
    assert.ok(r.rooms > 0 && r.seated <= N, 'every eligible candidate got a seat');
    assert.equal(r.ineligible, 1, 'only the student with dues is blocked');
    const plan = await api(`/exams/${strict.id}/seat-plan`);
    const blocked = plan.find(p => !Number(p.is_eligible));
    assert.match(String(blocked.ineligible_reason), /fees due/);
    assert.equal(blocked.student_id, students[0].id);
    // the ordinary exam seats everyone
    const open = await api(`/exams/${examId}/seat-plan`, {});
    assert.equal(open.ineligible, 0);
    assert.equal(open.seated, N);
  });

  test('marks entry: validation, save, verify, lock', async () => {
    const schedules = await api(`/exams/${examId}/schedules`);
    const first = schedules[0];
    const grid = await api(`/exams/marks?scheduleId=${first.id}`);
    assert.equal(grid.students.length, N);
    await assert.rejects(() => api('/exams/marks', { scheduleId: first.id, marks: [{ studentId: students[0].id, theory: 150 }] }), /more than the full marks/);
    await assert.rejects(() => api('/exams/marks', { scheduleId: first.id, marks: [{ studentId: students[0].id, theory: -5 }] }), /negative|Too small|greater/);
    // a spread of marks: a few failures, some ties at the top
    const rows = grid.students.map((s, i) => ({ studentId: String(s.student_id), theory: i < 3 ? 95 : i % 17 === 0 ? 20 : 40 + (i % 50), isAbsent: i % 41 === 40 }));
    assert.equal(await saveMarks(first.id, rows), rows.length);
    const after = await api(`/exams/marks?scheduleId=${first.id}`);
    assert.equal(after.students.filter(s => s.total_obtained != null).length, N);
    await api(`/exams/marks/${first.id}/verify`, {});
    await api(`/exams/marks/${first.id}/lock`, {});
    await assert.rejects(() => api('/exams/marks', { scheduleId: first.id, marks: [{ studentId: students[0].id, theory: 50 }] }), /locked/);
    await api(`/exams/marks/${first.id}/unlock`, {});
    await api('/exams/marks', { scheduleId: first.id, marks: [{ studentId: students[0].id, theory: 95 }] });
    await api(`/exams/marks/${first.id}/lock`, {});
    await app.relay.run();
  });

  test('result engine: GPA, F→0, ranks with ties, and it is deterministic', async () => {
    const schedules = await api(`/exams/${examId}/schedules`);
    const grid = await api(`/exams/marks?scheduleId=${schedules[1].id}`);
    for (const s of schedules.slice(1)) {
      const rows = grid.students.map((st, i) => ({ studentId: String(st.student_id), theory: i < 3 ? 92 : 45 + (i % 45) }));
      await saveMarks(s.id, rows);
    }
    const started = Date.now();
    const r = await api(`/exams/${examId}/compute`, {});
    console.log(`result engine: ${r.students} students in ${Date.now() - started} ms`);
    assert.equal(r.students, N);
    assert.equal(r.passed + r.failed, N);
    assert.ok(r.failed > 0, 'the low scorers and the absentees fail');
    const results = await api(`/exams/${examId}/results`);
    assert.equal(results.length, N);
    const top = results.find(x => Number(x.rank_in_class) === 1);
    assert.ok(Number(top.gpa) > 4, `top GPA ${top.gpa}`);
    // the three students who scored 95/92 everywhere tie at rank 1 under share_rank
    assert.equal(results.filter(x => Number(x.rank_in_class) === 1).length, 3, 'ties share the rank');
    // anyone failing a subject has GPA 0 (fail_gpa_zero)
    const failed = results.filter(x => !Number(x.is_pass));
    assert.ok(failed.length > 0 && failed.every(x => Number(x.gpa) === 0), 'a failed subject zeroes the GPA');
    assert.ok(failed.every(x => Number(x.failed_subjects) >= 1));
    // recomputing gives the same numbers
    const before = results.map(x => `${x.student_id}:${x.gpa}:${x.rank_in_class}`).sort().join('|');
    await api(`/exams/${examId}/compute`, {});
    const again = (await api(`/exams/${examId}/results`)).map(x => `${x.student_id}:${x.gpa}:${x.rank_in_class}`).sort().join('|');
    assert.equal(again, before, 'the engine is deterministic');
    assert.equal((await api(`/exams/${examId}/results`)).length, N, 'recomputing does not duplicate rows');
  });

  test(`publishing renders ${N} report-card PDFs in chunks and tells the guardians`, async () => {
    const started = Date.now();
    const r = await api(`/exams/${examId}/publish`, {});
    assert.equal(r.queued, true);
    let exam; let guard = 0;
    do { await app.adapters.queue.drain(5); exam = (await api('/exams')).exams.find(e => e.id === examId); } while (exam.status !== 'published' && ++guard < 400);
    const ms = Date.now() - started;
    assert.equal(exam.status, 'published', `still ${exam.status} after ${ms} ms`);
    console.log(`report cards: ${N} PDFs in ${ms} ms on ${app.db.engine}`);
    assert.ok(ms < 600_000, `publishing took ${ms} ms (limit 10 minutes)`);
    const results = await api(`/exams/${examId}/results`);
    assert.ok(results.every(x => x.report_card_file_id), 'every student has a report card');
    // the PDF is real and reachable through a signed link
    const url = await api(`/files/${results[0].report_card_file_id}/url`);
    const signed = new URL(url.url);
    const dl = await fetch(`${baseUrl}${signed.pathname}${signed.search}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.equal(dl.status, 200);
    assert.equal(buf.subarray(0, 4).toString(), '%PDF');
    assert.ok(buf.length > 1000);
    await app.relay.run(); await app.adapters.queue.drain(50);
    const notified = await app.db.count('notifications', { school_id: schoolId, event_key: 'assessment.result_published' });
    assert.ok(notified >= 3, `guardians notified: ${notified}`);
  });

  test('annual result and promotion move students to the next class', async () => {
    const annual = await api('/exams/annual/compute', {});
    assert.equal(annual.students, N);
    const list = await api('/exams/annual');
    assert.ok(list.some(x => x.decision === 'promoted'));
    assert.ok(list.some(x => x.decision === 'retained'), 'students who failed are retained');
    const nextYearId = await app.academic.createYear(schoolId, { name: '2027', startDate: '2027-01-01', endDate: '2027-12-31', cloneFromYearId: yearId });
    const dry = await api('/exams/annual/promote', { fromYearId: yearId, toYearId: nextYearId });
    assert.equal(dry.applied, false);
    assert.ok(dry.promoted > 0);
    const applied = await api('/exams/annual/promote', { fromYearId: yearId, toYearId: nextYearId, apply: true });
    assert.equal(applied.applied, true);
    const moved = await app.db.count('student_enrollments', { school_id: schoolId, academic_year_id: nextYearId, status: 'active' });
    assert.ok(moved >= applied.promoted, `${moved} enrolments created in the new year`);
    const promotedStudent = list.find(x => x.decision === 'promoted');
    const student = await app.db.findOne('students', { id: promotedStudent.student_id });
    assert.equal(student.current_academic_year_id, nextYearId);
    assert.notEqual(student.current_class_id, String(classes[5].id), 'moved up a class');
  });

  test('question bank and paper generation from a blueprint', async () => {
    const cs0 = (await app.academic.classSubjects(schoolId, yearId, String(classes[5].id)))[0];
    const subjectId = String(cs0.subject_id);
    for (let i = 0; i < 15; i++) await api('/questions', { subjectId, qType: i < 10 ? 'mcq' : 'short', difficulty: i % 3 === 0 ? 'easy' : 'medium', body: `Question ${i + 1}?`, options: i < 10 ? ['a', 'b', 'c', 'd'] : undefined, answer: i < 10 ? 'a' : undefined, marks: i < 10 ? 1 : 4 });
    const cs = cs0;
    const paper = await api('/questions/papers', { classSubjectId: String(cs.id), title: 'Model test', blueprint: { mcq: { count: 8, marks: 1 }, short: { count: 4, marks: 4 } } });
    assert.equal(paper.questions, 12);
    assert.equal(paper.totalMarks, 8 * 1 + 4 * 4);
    assert.deepEqual(paper.missing, [], 'the bank had enough questions');
    const full = await api(`/questions/papers/${paper.id}`);
    assert.equal(full.items.length, 12);
    assert.equal(full.items[0].sequence, 1);
    // asking for more than the bank holds is reported, not silently short
    const thin = await api('/questions/papers', { classSubjectId: String(cs.id), title: 'Too big', blueprint: { mcq: { count: 50 } } });
    assert.ok(thin.missing.length === 1 && thin.missing[0].includes('wanted 50'));
  });

  test('online exam auto-grades a submission', async () => {
    const cs = (await app.academic.classSubjects(schoolId, yearId, String(classes[5].id)))[0];
    const paper = await api('/questions/papers', { classSubjectId: String(cs.id), title: 'Online quiz', blueprint: { mcq: { count: 5, marks: 2 } } });
    const detail = await api(`/questions/papers/${paper.id}`);
    const online = await api('/exams/online', { sectionId, classSubjectId: String(cs.id), paperId: paper.id, title: 'Weekly quiz', startsAt: '2026-01-01 09:00:00', endsAt: '2099-01-01 10:00:00', durationMin: 30, totalMarks: 10 });
    // a student answers three of the five correctly
    const student = await app.db.findOne('students', { id: students[0].id });
    const uid = await app.auth.createUser({ schoolId, userType: 'student', displayName: 'Exam1', username: 's-online', roles: ['student'] });
    await app.db.update('students', { user_id: uid }, { id: student.id });
    const session = await app.auth.createSession(await app.db.findOne('users', { id: uid }));
    const answers = {};
    detail.items.forEach((it, i) => { answers[String(it.question_id)] = i < 3 ? 'a' : 'z'; });
    const r = await api(`/exams/online/${online.id}/submit`, { answers }, 'POST', { cookie: `ps_session=${session.token}` });
    assert.equal(r.score, 6, 'three correct answers at two marks each');
  });

  test('guardian sees the published result and the report card, but nothing unpublished', async () => {
    guardianCookie = await otpLogin(firstGuardianPhone);
    const list = await api(`/portal/results/${students[0].id}`, undefined, 'GET', { cookie: guardianCookie });
    assert.equal(list.results.length, 1, 'only the published exam');
    const detail = await api(`/portal/results/${students[0].id}/${examId}`, undefined, 'GET', { cookie: guardianCookie });
    assert.ok(detail.result.gpa != null);
    assert.ok(detail.subjects.length >= 6);
    assert.ok(detail.reportCardUrl, 'a signed link to the PDF');
    // the strict exam is not published, so it is refused
    const strict = (await api('/exams')).exams.find(e => e.name === 'Strict test');
    assert.equal((await fetch(`${baseUrl}/api/portal/results/${students[0].id}/${strict.id}`, { headers: { cookie: guardianCookie } })).status, 403);
    // another child is refused
    assert.equal((await fetch(`${baseUrl}/api/portal/results/${students[50].id}`, { headers: { cookie: guardianCookie } })).status, 403);
    const r = await fetch(`${baseUrl}/exams?examId=${examId}`, { headers: { cookie } });
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.ok(html.includes('Annual 2026'));
  });
});
