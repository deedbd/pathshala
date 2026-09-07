// Phase 8 (welfare, LMS, engagement): behaviour points that add up to a proposed action, the clinic
// that takes medicine out of the store and calls home, counselling and safeguarding notes that stay
// encrypted, courses that enrol a class by themselves, assignments with a late penalty applied once,
// live classes, surveys, newsletters, events with a QR ticket, and the weekly digest.
//   node --test tests/phase8.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-p8');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'p8-key-'.padEnd(64, 'x'), CRON_KEY: 'cron-p8', UPLOADS_DIR: 'tests/.tmp-p8/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-p8/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, schoolId, yearId, classId, sectionId, classSubjectId, http, baseUrl, cookie, guardianCookie, studentCookie;
let students = [], counsellorId, teacherId, courseId, moduleId, lessonIds = [], assignmentId, surveyId, eventId, medicineId, storeId;
const t0 = Date.now();

describe('phase 8', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Phase Eight School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01788888888', adminEmail: 'admin@p8.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    await app.settings.set(schoolId, 'notifications.channels', { push: true, sms: true, email: true, in_app: true });
    yearId = String((await app.academic.currentYear(schoolId)).id);
    classId = String((await app.academic.classes(schoolId))[5].id);
    sectionId = String((await app.academic.sections(schoolId, yearId, classId))[0].id);
    classSubjectId = String((await app.academic.classSubjects(schoolId, yearId, classId))[0].id);
    for (let i = 0; i < 5; i++) {
      students.push(await app.people.createStudent(schoolId, { firstName: `Learner${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2013-06-06', classId, sectionId, guardians: [{ fullName: `Parent ${i + 1}`, phone: `0197000000${i}`, relation: 'mother', isPrimary: true }] }));
    }
    counsellorId = (await app.people.createStaff(schoolId, { firstName: 'Counsellor', phone: '01988000001', staffCategory: 'non_teaching', joinDate: '2024-01-01' })).id;
    teacherId = (await app.people.createStaff(schoolId, { firstName: 'Teacher', phone: '01988000002', staffCategory: 'teaching', joinDate: '2024-01-01' })).id;
    // the clinic takes its medicine out of the main store
    const cats = await app.inventory.categories(schoolId);
    storeId = String((await app.inventory.stores(schoolId))[0].id);
    medicineId = (await app.inventory.addItem(schoolId, { categoryId: String(cats.find(c => c.name === 'Medicine').id), name: 'Paracetamol 500mg', unit: 'tab' })).id;
    await app.inventory.move(schoolId, { itemId: medicineId, storeId, moveType: 'in', quantity: 100, unitCost: 2 });
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@p8.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
    const g = (await app.db.query(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ?`, [students[0].id]))[0];
    guardianCookie = `ps_session=${(await app.auth.createSession(await app.db.findOne('users', { id: g.user_id }))).token}`;
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`phase 8 finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 200)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const drain = async () => { let guard = 0; while (++guard < 200) { const { ran } = await app.adapters.queue.drain(10); const { published } = await app.relay.run(); if (!ran && !published) break; } };
  const told = async eventKey => Number((await app.db.query(`SELECT COUNT(DISTINCT COALESCE(recipient_user_id, recipient_address)) AS n FROM notifications WHERE school_id = ? AND event_key = ?`, [schoolId, eventKey]))[0].n);

  // ---------------- welfare ----------------
  test('behaviour categories are seeded, and a recorded incident reaches the guardian', async () => {
    const { categories } = await api('/welfare/behaviour');
    assert.equal(categories.length, 8);
    assert.ok(categories.some(c => c.polarity === 'positive' && Number(c.default_points) > 0));
    const bullying = categories.find(c => c.name === 'Bullying');
    const praise = categories.find(c => c.name === 'Represented the school');
    // the admin account is not a member of staff, so the reporter is named explicitly
    await assert.rejects(() => api('/welfare/incidents', { studentId: students[0].id, categoryId: String(praise.id), description: 'no reporter' }), /name a member of staff/);
    const good = await api('/welfare/incidents', { studentId: students[0].id, categoryId: String(praise.id), description: 'Won the district debate.', reportedBy: teacherId });
    assert.equal(good.points, 10);
    assert.equal(await told('welfare.behaviour_incident'), 1, 'the guardian heard the good news');
    const bad = await api('/welfare/incidents', { studentId: students[1].id, categoryId: String(bullying.id), description: 'Pushed a younger student.', reportedBy: teacherId });
    assert.equal(bad.points, -15);
    const points = await api(`/welfare/points/${students[1].id}`);
    assert.equal(points.total, -15);
    assert.equal(points.incidents, 1);
  });

  test('points crossing the threshold propose an action; the guardian must acknowledge it', async () => {
    const { categories } = await api('/welfare/behaviour');
    const disrupt = categories.find(c => c.name === 'Disrupting the class');
    for (let i = 0; i < 2; i++) await api('/welfare/incidents', { studentId: students[1].id, categoryId: String(disrupt.id), description: `Talking through the lesson (${i + 1}).`, reportedBy: teacherId });
    const total = (await api(`/welfare/points/${students[1].id}`)).total;
    assert.equal(total, -25, 'fifteen plus two fives');
    const r = await app.welfare.jobs()['welfare.behaviour_rules']({ schoolId, jobKey: 'welfare.behaviour_rules', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(r.proposed, 1, 'the thirty-day rule fired');
    await drain();
    const actions = await api('/welfare/behaviour');
    const action = actions.actions.find(a => Number(a.is_auto_proposed));
    assert.equal(action.action_type, 'detention');
    assert.equal(action.status, 'approved', 'auto-approved because no workflow is configured');
    assert.ok(await told('welfare.action_taken') >= 1);
    // running the rule again does not propose the same thing every night
    assert.equal((await app.welfare.jobs()['welfare.behaviour_rules']({ schoolId, jobKey: 'welfare.behaviour_rules', payload: {}, deadline: Date.now() + 20_000 })).proposed, 0);
    // a guardian acknowledges it from the app, and only for their own child
    const g = (await app.db.query(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ?`, [students[1].id]))[0];
    const gc = `ps_session=${(await app.auth.createSession(await app.db.findOne('users', { id: g.user_id }))).token}`;
    const ack = await api(`/portal/actions/${action.id}/acknowledge`, {}, 'POST', { cookie: gc });
    assert.ok(ack.acknowledgedAt);
    assert.equal((await fetch(`${baseUrl}/api/portal/actions/${action.id}/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: guardianCookie }, body: '{}' })).status, 403);
  });

  test('the clinic takes medicine out of the store and calls home when a child is sent home', async () => {
    const before = Number((await app.inventory.stock(schoolId, storeId)).find(s => String(s.item_id) === medicineId).quantity);
    const v = await api('/welfare/clinic', { studentId: students[2].id, complaint: 'Fever 101F', treatment: 'Paracetamol, rest', medicines: [{ itemId: medicineId, quantity: 2 }], sentHome: true });
    assert.equal(v.medicines, 1);
    const after = Number((await app.inventory.stock(schoolId, storeId)).find(s => String(s.item_id) === medicineId).quantity);
    assert.equal(after, before - 2, 'the tablets left the store through the ledger');
    const movement = (await app.inventory.movements(schoolId, medicineId)).find(m => m.ref_type === 'clinic_visit');
    assert.ok(movement, 'and the movement says why');
    assert.equal(await told('welfare.sent_home'), 1);
    const health = await api(`/welfare/health/${students[2].id}`);
    assert.equal(health.visits.length, 1);
    assert.ok(health.visits[0].guardian_notified_at);
  });

  test('growth is recorded with its BMI, and a due vaccination reminds the guardian', async () => {
    const h = await api('/welfare/health', { studentId: students[0].id, heightCm: 140, weightKg: 35 });
    assert.equal(h.bmi, 17.9);
    await api('/welfare/vaccinations', { studentId: students[0].id, vaccine: 'Tetanus', doseNo: 2, nextDueOn: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) });
    const r = await app.welfare.jobs()['welfare.behaviour_rules']({ schoolId, jobKey: 'welfare.behaviour_rules', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(r.vaccinationReminders, 1);
    assert.equal(await told('welfare.vaccination_due'), 1);
  });

  test('counselling and safeguarding notes are encrypted and only their owner can read them', async () => {
    const s = await api('/welfare/counselling', { studentId: students[1].id, counsellorId, notes: 'Talked about the fight; agreed to a check-in next week.', referralSource: 'behaviour_rule', status: 'done' });
    const row = await app.db.findOne('counselling_sessions', { id: s.id });
    assert.ok(row.notes_encrypted, 'something is stored');
    assert.ok(!String(row.notes_encrypted).includes('fight'), 'but not in plain text');
    const list = await api(`/welfare/counselling?studentId=${students[1].id}`);
    assert.equal(list[0].has_notes, true);
    assert.equal(list[0].notes_encrypted, undefined, 'the list never carries the words');
    const mine = await app.welfare.counsellingNotes(schoolId, s.id, counsellorId);
    assert.match(mine.notes, /check-in next week/);
    await assert.rejects(() => app.welfare.counsellingNotes(schoolId, s.id, teacherId), /only the counsellor/);
    const c = await api('/welfare/safeguarding', { studentId: students[3].id, category: 'neglect', details: 'Child arriving without food three days running.', riskLevel: 'high', caseOwnerId: counsellorId });
    const caseRow = await app.db.findOne('safeguarding_cases', { id: c.id });
    assert.ok(!String(caseRow.details_encrypted).includes('food'));
    const details = await app.welfare.safeguardingDetails(schoolId, c.id, counsellorId);
    assert.match(details.details, /without food/);
    await assert.rejects(() => app.welfare.safeguardingDetails(schoolId, c.id, teacherId), /only the case owner/);
    // the alert says a case exists, never what is in it
    const alert = await app.db.query(`SELECT title, body FROM notifications WHERE school_id = ? AND event_key = 'welfare.safeguarding_case' LIMIT 1`, [schoolId]);
    assert.ok(!String(alert[0].body).includes('food'));
    const cases = await api('/welfare/safeguarding');
    assert.equal(cases[0].details_encrypted, undefined);
  });

  // ---------------- lms ----------------
  test('publishing a class-subject course enrols that class by itself', async () => {
    const c = await api('/lms/courses', { title: 'Algebra foundations', classSubjectId, teacherId });
    courseId = c.id;
    assert.equal(c.slug, 'algebra-foundations');
    moduleId = (await api(`/lms/courses/${courseId}/modules`, { title: 'Linear equations' })).id;
    for (const title of ['What is a variable', 'Solving for x', 'Word problems']) {
      lessonIds.push((await api('/lms/lessons', { moduleId, title, lessonType: 'video', durationMin: 8 })).id);
    }
    const published = await api(`/lms/courses/${courseId}/publish`, {});
    assert.equal(published.enrolled, students.length, 'every student of the class');
    const detail = await api(`/lms/courses/${courseId}`);
    assert.equal(detail.lessons.length, 3);
    // publishing twice does not enrol anyone twice
    assert.equal((await api(`/lms/courses/${courseId}/publish`, {})).enrolled, 0);
  });

  test('finishing lessons moves the progress bar and closes the course at a hundred', async () => {
    let last;
    for (const lessonId of lessonIds) last = await app.lms.markProgress(schoolId, { lessonId, studentId: students[0].id, status: 'completed' });
    assert.equal(last.progressPct, 100);
    const rows = await api(`/lms/courses/${courseId}/progress`);
    const mine = rows.find(r => String(r.student_id) === students[0].id);
    assert.equal(Number(mine.progress_pct), 100);
    assert.ok(mine.completed_at);
    assert.ok(last.certificateId, 'finishing the course issued the certificate without anyone asking');
    const partial = await app.lms.markProgress(schoolId, { lessonId: lessonIds[0], studentId: students[1].id, status: 'completed' });
    assert.equal(partial.progressPct, 33.33);
    // somebody not on the course cannot log progress against it
    await assert.rejects(() => app.lms.markProgress(schoolId, { lessonId: lessonIds[0], studentId: 'not-a-student' }), /not enrolled/);
  });

  test('the certificate is issued once and can be verified by its code', async () => {
    const enrolment = await app.db.findOne('course_enrollments', { course_id: courseId, student_id: students[0].id });
    assert.ok(enrolment.certificate_doc_id, 'the enrolment keeps the document, not just a PDF somewhere');
    const doc = await app.db.findOne('issued_documents', { id: String(enrolment.certificate_doc_id) });
    assert.equal(String(doc.doc_type), 'certificate');
    const verified = await app.documents.verify(String(doc.verification_code));
    assert.equal(verified.valid, true);
    // asking again does not print a second certificate
    const again = await api(`/lms/courses/${courseId}/certificate`, { studentId: students[0].id });
    assert.equal(again.alreadyIssued, true);
    assert.equal(again.certificateId, String(enrolment.certificate_doc_id));
    // and somebody a third of the way through is refused one
    await assert.rejects(() => api(`/lms/courses/${courseId}/certificate`, { studentId: students[1].id }), /33/);
  });

  test('a quiz inside a lesson marks itself, and never shows the answers before the attempt', async () => {
    const quizLesson = (await api('/lms/lessons', { moduleId, title: 'Check yourself', lessonType: 'quiz' })).id;
    const set = await api(`/lms/lessons/${quizLesson}/quiz`, { passMark: 60, maxAttempts: 2, questions: [
      { text: 'What is x in x + 2 = 5?', options: ['1', '3', '5'], answer: 1 },
      { text: 'Is 2x = x + x?', options: ['yes', 'no'], answer: 0 },
      { text: 'Which is a variable?', options: ['7', 'y', '+'], answer: 1, marks: 2 },
    ] });
    assert.equal(set.questions, 3);
    assert.equal(set.maxScore, 4);
    // a quiz that points at an option that is not there is refused
    await assert.rejects(() => api(`/lms/lessons/${quizLesson}/quiz`, { questions: [{ text: 'bad', options: ['a', 'b'], answer: 5 }] }), /option that is not there|400/);

    const paper = await api(`/lms/lessons/${quizLesson}/quiz?studentId=${students[1].id}`);
    assert.equal(paper.questions.length, 3);
    assert.equal(JSON.stringify(paper).includes('"answer"'), false, 'the right options are not in what the student is sent');
    assert.equal(paper.attemptsLeft, 2);

    // first attempt, mostly wrong
    const failed = await app.lms.submitQuiz(schoolId, quizLesson, students[1].id, [0, 0, 0]);
    assert.equal(failed.score, 1);
    assert.equal(failed.passed, false);
    assert.equal(failed.marked[0].correct, 1, 'now the right answer is shown, so the student learns something');
    assert.equal(failed.attemptsLeft, 1);
    assert.equal(String((await app.db.findOne('lesson_progress', { lesson_id: quizLesson, student_id: students[1].id })).status), 'in_progress');

    // second attempt, right
    const passed = await app.lms.submitQuiz(schoolId, quizLesson, students[1].id, [1, 0, 1]);
    assert.equal(passed.score, 4);
    assert.equal(passed.percent, 100);
    assert.equal(passed.passed, true);
    assert.equal(String((await app.db.findOne('lesson_progress', { lesson_id: quizLesson, student_id: students[1].id })).status), 'completed');
    // a third go is refused: the quiz said two
    await assert.rejects(() => app.lms.submitQuiz(schoolId, quizLesson, students[1].id, [1, 0, 1]), /allows 2 attempts/);
    assert.equal((await app.db.findMany('lesson_quiz_attempts', { lesson_id: quizLesson, student_id: students[1].id })).length, 2);
    // and somebody who is not on the course cannot sit it at all
    await assert.rejects(() => app.lms.submitQuiz(schoolId, quizLesson, 'not-a-student', [1, 0, 1]), /not enrolled/);
  });

  test('a late submission is penalised once, at marking time', async () => {
    assignmentId = (await api('/lms/assignments', { sectionId, classSubjectId, teacherId, title: 'Exercise 4.2', dueAt: `${new Date().toISOString().slice(0, 10)} 23:59:00`, maxMarks: 20, latePenaltyPct: 25 })).id;
    assert.ok(await told('lms.assignment_published') >= 1, 'the section heard about it');
    // on time
    const student0 = await app.db.findOne('students', { id: students[0].id });
    const uid = await app.auth.createUser({ schoolId, userType: 'student', displayName: 'Learner1', username: 'learner-1', roles: ['student'] });
    await app.db.update('students', { user_id: uid }, { id: student0.id });
    studentCookie = `ps_session=${(await app.auth.createSession(await app.db.findOne('users', { id: uid }))).token}`;
    const onTime = await api(`/portal/assignments/${assignmentId}/submit`, { textAnswer: 'Answers attached.' }, 'POST', { cookie: studentCookie });
    assert.equal(onTime.late, false);
    // late: move the deadline into the past and submit for somebody else
    await app.db.execute(`UPDATE assignments SET due_at = ? WHERE id = ?`, ['2020-01-01 09:00:00', assignmentId]);
    const late = await app.lms.submit(schoolId, { assignmentId, studentId: students[1].id, textAnswer: 'Sorry, late.' });
    assert.equal(late.late, true);
    const graded = await api(`/lms/submissions/${late.id}/grade`, { marks: 20, feedback: 'Good work' });
    assert.equal(graded.marks, 15, 'twenty less a quarter');
    assert.match((await app.db.findOne('assignment_submissions', { id: late.id })).feedback, /25% deducted/);
    const onTimeGraded = await api(`/lms/submissions/${onTime.id}/grade`, { marks: 18 });
    assert.equal(onTimeGraded.marks, 18, 'and nothing is deducted from work that arrived on time');
    await assert.rejects(() => api(`/lms/submissions/${late.id}/grade`, { marks: 50 }), /more than the 20 marks/);
    // a marked submission cannot be quietly replaced
    await assert.rejects(() => app.lms.submit(schoolId, { assignmentId, studentId: students[1].id, textAnswer: 'again' }), /already been marked/);
    assert.ok(await told('lms.assignment_graded') >= 1);
  });

  test('an assignment due tomorrow reminds only those who have not handed it in', async () => {
    const soon = new Date(Date.now() + 20 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    const id = (await api('/lms/assignments', { sectionId, classSubjectId, teacherId, title: 'Reading log', dueAt: soon, maxMarks: 10 })).id;
    await app.lms.submit(schoolId, { assignmentId: id, studentId: students[0].id, textAnswer: 'done' });
    const r = await app.lms.jobs()['lms.assignment_reminders']({ schoolId, jobKey: 'lms.assignment_reminders', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(r.reminded, students.length - 1, 'everyone except the one who handed it in');
    // and only once
    assert.equal((await app.lms.jobs()['lms.assignment_reminders']({ schoolId, jobKey: 'lms.assignment_reminders', payload: {}, deadline: Date.now() + 20_000 })).reminded, 0);
  });

  test('a live class gets a join link nobody has to configure, and attendance comes back from it', async () => {
    const c = await api('/lms/classes', { sectionId, teacherId, title: 'Doubt clearing', startsAt: new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 19).replace('T', ' '), durationMin: 30 });
    assert.match(c.joinUrl, /^https:\/\/meet\.jit\.si\/pathshala-/);
    const r = await app.lms.jobs()['lms.assignment_reminders']({ schoolId, jobKey: 'lms.assignment_reminders', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(r.classes, 1, 'the class starting inside fifteen minutes was announced');
    const att = await api(`/lms/classes/${c.id}/attendance`, { rows: [{ studentId: students[0].id, joinedAt: '2026-09-07 10:00:00', leftAt: '2026-09-07 10:28:00' }] });
    assert.equal(att.saved, 1);
    const row = await app.db.findOne('online_class_attendance', { online_class_id: c.id, student_id: students[0].id });
    assert.equal(Number(row.minutes), 28);
  });

  // ---------------- engagement ----------------
  test('a survey is asked, answered once per guardian, and summarised', async () => {
    const s = await api('/engagement/surveys', { title: 'How was the parents evening', questions: [{ key: 'venue', label: 'The venue', type: 'rating' }, { key: 'again', label: 'Would you come again', type: 'yes_no' }, { key: 'other', label: 'Anything else', type: 'text' }] });
    surveyId = s.id;
    const opened = await api(`/engagement/surveys/${surveyId}/open`, {});
    assert.equal(opened.asked, 5, 'every guardian with an account');
    const answered = await api(`/portal/surveys/${surveyId}/answer`, { answers: { venue: 4, again: 'yes', other: 'The hall was warm.' } }, 'POST', { cookie: guardianCookie });
    assert.equal(answered.anonymous, false);
    await assert.rejects(() => api(`/portal/surveys/${surveyId}/answer`, { answers: { venue: 5 } }, 'POST', { cookie: guardianCookie }), /already answered/);
    // a second guardian answers
    const g2 = (await app.db.query(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ?`, [students[2].id]))[0];
    const c2 = `ps_session=${(await app.auth.createSession(await app.db.findOne('users', { id: g2.user_id }))).token}`;
    await api(`/portal/surveys/${surveyId}/answer`, { answers: { venue: 2, again: 'no', other: 'Too long.' } }, 'POST', { cookie: c2 });
    const results = await api(`/engagement/surveys/${surveyId}/results`);
    assert.equal(results.responses, 2);
    const venue = results.summary.find(x => x.key === 'venue');
    assert.equal(venue.average, 3, 'four and two');
    const again = results.summary.find(x => x.key === 'again');
    assert.deepEqual(again.counts, { yes: 1, no: 1 });
    assert.equal(results.summary.find(x => x.key === 'other').texts.length, 2);
  });

  test('a newsletter goes out once', async () => {
    const id = (await api('/engagement/newsletters', { title: 'February notices', body: 'Sports day is on the 20th.', channel: 'sms' })).id;
    const sent = await api(`/engagement/newsletters/${id}/send`, {});
    assert.equal(sent.sent, 5);
    const again = await api(`/engagement/newsletters/${id}/send`, {});
    assert.equal(again.alreadySent, true);
    assert.equal(await told('engagement.newsletter'), 5);
  });

  test('an event takes RSVPs and its ticket is scanned once', async () => {
    eventId = (await api('/engagement/events', { title: 'Annual sports day', eventType: 'sports', startsAt: '2027-02-20 09:00:00', venue: 'School ground', rsvpRequired: true, ticketPrice: 0, ticketLimit: 2 })).id;
    const announced = await api(`/engagement/events/${eventId}/announce`, {});
    assert.equal(announced.told, 5);
    await api(`/portal/events/${eventId}/rsvp`, { response: 'yes', guests: 2 }, 'POST', { cookie: guardianCookie });
    const events = await api('/engagement/events');
    assert.equal(Number(events.find(e => String(e.id) === eventId).coming), 1);
    const t1 = await api(`/engagement/events/${eventId}/tickets`, { holderName: 'Parent 1' });
    await api(`/engagement/events/${eventId}/tickets`, { holderName: 'Parent 2' });
    await assert.rejects(() => api(`/engagement/events/${eventId}/tickets`, { holderName: 'Parent 3' }), /ticket\(s\) left|sold/);
    const used = await api('/engagement/tickets/check-in', { qr: t1.qr });
    assert.equal(used.holder, 'Parent 1');
    await assert.rejects(() => api('/engagement/tickets/check-in', { qr: t1.qr }), /already used/);
  });

  test('clubs, house points and a portfolio the child can show', async () => {
    const clubId = (await api('/engagement/clubs', { name: 'Science club', category: 'tech', advisorId: teacherId })).id;
    await api(`/engagement/clubs/${clubId}/members`, { studentId: students[0].id, role: 'president' });
    await assert.rejects(() => api(`/engagement/clubs/${clubId}/members`, { studentId: students[0].id }), /already a member/);
    const houses = await app.db.findMany('houses', { school_id: schoolId });
    if (houses.length) {
      await api('/engagement/house-points', { houseId: String(houses[0].id), studentId: students[0].id, points: 25, reason: 'Won the science quiz' });
      const table = (await api('/engagement/clubs')).houses;
      assert.equal(Number(table.find(h => String(h.id) === String(houses[0].id)).points), 25);
    }
    await api('/engagement/achievements', { studentId: students[0].id, title: 'District debate champion', category: 'debate' });
    const portfolio = await api(`/engagement/portfolio/${students[0].id}`);
    assert.equal(portfolio.achievements.length, 1);
    assert.equal(portfolio.clubs.length, 1);
    assert.equal(portfolio.clubs[0].role, 'president');
  });

  test('the weekly digest says something only when there is something to say', async () => {
    // give the week something to report, whatever hour the suite happens to run at
    const today = new Date().toISOString().slice(0, 10);
    await app.attendance.mark(schoolId, students[0].id, today, 'present', { notify: false });
    const r = await app.engagement.jobs()['comms.weekly_digest']({ schoolId, jobKey: 'comms.weekly_digest', payload: {}, deadline: Date.now() + 20_000 });
    assert.ok(r.sent >= 1, `${r.sent} digests`);
    const digest = await app.db.query(`SELECT title, body FROM notifications WHERE school_id = ? AND event_key = 'engagement.weekly_digest' LIMIT 1`, [schoolId]);
    assert.match(String(digest[0].body), /homework not handed in|Attendance/);
  });

  test('a guardian sees their own child’s learning; a teacher never sees a counselling note', async () => {
    const mine = await api(`/portal/learning/${students[0].id}`, undefined, 'GET', { cookie: guardianCookie });
    assert.equal(mine.courses.length, 1);
    assert.ok(mine.assignments.length >= 2);
    assert.equal(mine.portfolio.achievements.length, 1);
    assert.equal((await fetch(`${baseUrl}/api/portal/learning/${students[3].id}`, { headers: { cookie: guardianCookie } })).status, 403);
    // the student themselves sees the same page
    const asStudent = await api(`/portal/learning/${students[0].id}`, undefined, 'GET', { cookie: studentCookie });
    assert.equal(asStudent.courses.length, 1);
    // and neither of them reaches the console
    assert.equal((await fetch(`${baseUrl}/api/welfare/safeguarding`, { headers: { cookie: guardianCookie } })).status, 403);
    const html = await fetch(`${baseUrl}/learning`, { headers: { cookie } });
    assert.equal(html.status, 200);
    assert.ok((await html.text()).includes('Algebra foundations'));
  });
});
