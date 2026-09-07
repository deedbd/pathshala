// Year 3 / year 5: the advanced half of the LMS, and adaptive learning.
// Watch time that has to have actually happened (a beat cannot claim an hour, and dragging the
// needle to the end is not watching); discussion threads a student sees only for their own course;
// similarity between text answers reported as "read these two", never as a verdict, and never over
// answers too short to mean anything; and a revision plan built from the competency ratings that
// names the lessons covering each unmet indicator — or says plainly that nothing covers it.
//   node --test tests/lms-advanced.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-lmsx');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'lmsx-key'.padEnd(64, 'x'), CRON_KEY: 'cron-lmsx', UPLOADS_DIR: 'tests/.tmp-lmsx/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-lmsx/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, schoolId, yearId, termId, classId, sectionId, classSubjectId, otherClassSubjectId, teacherId;
let http, baseUrl, cookie, studentCookie, guardianCookie;
let courseId, moduleId, videoLessonId, noteLessonId, unitLessons, otherCourseId, threadId;
let unitIds = [];
let outcomes = {};
let assignmentId;
const students = [];
const t0 = Date.now();

describe('year 3: advanced LMS and adaptive learning', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Adaptive School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01766666666', adminEmail: 'admin@lmsx.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    yearId = String((await app.academic.currentYear(schoolId)).id);
    const y = new Date().getUTCFullYear();
    const terms = await app.db.findMany('terms', { school_id: schoolId, academic_year_id: yearId }, { limit: 1 });
    termId = terms.length ? String(terms[0].id) : await app.academic.addTerm(schoolId, yearId, { name: 'First term', sequence: 1, startDate: `${y}-01-01`, endDate: `${y}-12-31` });
    // the plan is built for "the term today falls in", so the term has to actually contain today
    await app.db.execute(`UPDATE terms SET start_date = ?, end_date = ? WHERE id = ?`, [`${y}-01-01`, `${y}-12-31`, termId]);
    const classes = await app.academic.classes(schoolId);
    classId = String(classes[5].id);
    sectionId = String((await app.academic.sections(schoolId, yearId, classId))[0].id);
    const subjects = await app.academic.classSubjects(schoolId, yearId, classId);
    classSubjectId = String(subjects[0].id);
    otherClassSubjectId = String(subjects[1].id);
    for (let i = 0; i < 4; i++) {
      students.push(await app.people.createStudent(schoolId, { firstName: `Shikkharthi${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2012-04-04', classId, sectionId, admissionDate: '2022-01-05', guardians: [{ fullName: `Obhibhabok ${i + 1}`, phone: `0195500000${i}`, relation: 'mother', isPrimary: true, paysFees: true }] }));
    }
    const teacher = await app.people.createStaff(schoolId, { firstName: 'Nasrin', lastName: 'Akter', phone: '01911550001', staffCategory: 'teaching', joinDate: '2021-01-01', gender: 'female' });
    teacherId = teacher.id;
    if (!teacher.userId) {
      const uid = await app.auth.createUser({ schoolId, userType: 'staff', displayName: 'Nasrin Akter', username: 'nasrin', roles: ['teacher'] });
      await app.db.update('staff', { user_id: uid }, { id: teacher.id });
    }
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@lmsx.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
    // the first child signs in as themselves; their guardian reads on their behalf
    const uid = await app.auth.createUser({ schoolId, userType: 'student', displayName: 'Shikkharthi1', username: 'shikkharthi-1', roles: ['student'] });
    await app.db.update('students', { user_id: uid }, { id: students[0].id });
    studentCookie = `ps_session=${(await app.auth.createSession(await app.db.findOne('users', { id: uid }))).token}`;
    const g = (await app.db.query(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ?`, [students[0].id]))[0];
    guardianCookie = `ps_session=${(await app.auth.createSession(await app.db.findOne('users', { id: g.user_id }))).token}`;
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`lms-advanced finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 200)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const status = async (p, extra = {}) => (await fetch(`${baseUrl}/api${p}`, { headers: { cookie: extra.cookie ?? cookie } })).status;
  // one message per channel becomes several rows, so count the people told, not the rows written
  const told = async eventKey => Number((await app.db.query(`SELECT COUNT(DISTINCT COALESCE(recipient_user_id, recipient_address)) AS n FROM notifications WHERE school_id = ? AND event_key = ?`, [schoolId, eventKey]))[0].n);
  const events = async type => Number((await app.db.query(`SELECT COUNT(*) AS n FROM outbox_events WHERE school_id = ? AND event_type = ?`, [schoolId, type]))[0].n);

  // ---------------- the syllabus the whole thing hangs off ----------------
  test('a syllabus with units, and a course whose lessons are mapped to them', async () => {
    const syllabusId = (await api('/curriculum/syllabi', { classSubjectId, title: 'Class syllabus', termId, units: [{ title: 'Fractions' }, { title: 'Decimals' }, { title: 'Geometry' }] })).id;
    unitIds = (await api(`/curriculum/syllabi/${syllabusId}/units`)).map(u => String(u.id));
    assert.equal(unitIds.length, 3);

    const c = await api('/lms/courses', { title: 'Numbers and shapes', classSubjectId, teacherId });
    courseId = c.id;
    moduleId = (await api(`/lms/courses/${courseId}/modules`, { title: 'Term one' })).id;
    videoLessonId = (await api('/lms/lessons', { moduleId, title: 'Fractions on a number line', lessonType: 'video', durationMin: 10, unitId: unitIds[0] })).id;
    noteLessonId = (await api('/lms/lessons', { moduleId, title: 'A note with no running time', lessonType: 'note' })).id;
    unitLessons = { quiz: (await api('/lms/lessons', { moduleId, title: 'Fractions quiz', lessonType: 'quiz', unitId: unitIds[0] })).id };
    await api('/lms/materials', { classSubjectId, title: 'Fractions worksheet', materialType: 'note', unitId: unitIds[0] });
    const published = await api(`/lms/courses/${courseId}/publish`, {});
    assert.equal(published.enrolled, students.length, 'publishing a class-subject course enrols the class');
  });

  // ---------------- video progress that means something ----------------
  // A beat may never claim more seconds than have actually passed, so a test that means to watch a
  // lesson has to let time pass. Moving the last beat's stamp back is that, without the wait.
  const timePasses = async (lessonId, seconds) => {
    const row = await app.db.findOne('lesson_progress', { lesson_id: lessonId, student_id: students[0].id });
    if (row) await app.db.execute('UPDATE lesson_progress SET last_beat_at = ? WHERE id = ?', [new Date(Date.now() - seconds * 1000).toISOString().slice(0, 19).replace('T', ' '), row.id]);
  };

  test('watch time only counts what actually went past the player', async () => {
    // a genuine two-minute beat on a ten-minute lesson
    const first = await api(`/portal/lessons/${videoLessonId}/watch`, { seconds: 120, position: 120 }, 'POST', { cookie: studentCookie });
    assert.equal(first.secondsWatched, 120);
    assert.equal(first.watchedPct, 20);
    assert.equal(first.status, 'in_progress');

    // a page claiming an hour in one beat gets three minutes, which is all a beat may ever add
    await timePasses(videoLessonId, 300);
    const greedy = await api(`/portal/lessons/${videoLessonId}/watch`, { seconds: 3600, position: 300 }, 'POST', { cookie: studentCookie });
    assert.equal(greedy.secondsWatched, 300, 'one beat may add at most three minutes');
    assert.equal(greedy.watchedPct, 50);
    assert.equal(greedy.status, 'in_progress');


    // dragging the needle to the end is not watching
    const seeked = await api(`/portal/lessons/${videoLessonId}/watch`, { seconds: 0, position: 600 }, 'POST', { cookie: studentCookie });
    assert.equal(seeked.secondsWatched, 300);
    assert.equal(seeked.lastPosition, 600, 'where to resume from is still remembered');
    assert.equal(seeked.status, 'in_progress', 'seeking to the end does not finish a lesson');

    // and a beat arriving the moment after the last one adds only the seconds that have passed:
    // twenty of these in one second is how a player finishes an hour nobody sat through
    const rapid = await api(`/portal/lessons/${videoLessonId}/watch`, { seconds: 180, position: 480 }, 'POST', { cookie: studentCookie });
    assert.ok(rapid.secondsWatched <= 320, `a beat cannot outrun the clock (got ${rapid.secondsWatched})`);
    assert.equal(rapid.status, 'in_progress', 'a burst of beats does not finish a lesson');
  });

  test('a lesson watched through completes, once, and moves the course bar', async () => {
    let last;
    for (let i = 0; i < 3; i++) {
      await timePasses(videoLessonId, 200);
      last = await api(`/portal/lessons/${videoLessonId}/watch`, { seconds: 120, position: 600 }, 'POST', { cookie: studentCookie });
    }
    assert.equal(last.secondsWatched, 600, 'and never more than the lesson is long');
    assert.equal(last.watchedPct, 100);
    assert.equal(last.status, 'completed');
    assert.equal(last.requiredPct, 85);
    assert.equal(last.progress.lessonsDone, 1);
    assert.equal(last.progress.lessons, 3);
    assert.equal(await events('lesson.completed'), 1, 'a beat every thirty seconds must not flood the outbox');

    // a lesson with no running time cannot be measured, and says so rather than inventing a number
    const note = await app.lms.watch(schoolId, { lessonId: noteLessonId, studentId: students[0].id, seconds: 60 });
    assert.equal(note.watchedPct, null);
    assert.match(note.note, /no running time/);

    // a quiz lesson is finished by passing it; a stray beat from a player left open must not take
    // that back, and with it the course percentage and any certificate that followed
    await api(`/lms/lessons/${unitLessons.quiz}/quiz`, { passMark: 50, questions: [{ text: 'Is 1/2 bigger than 1/3?', options: ['Yes', 'No'], answer: 0 }] });
    const passed = await api(`/portal/lessons/${unitLessons.quiz}/quiz`, { answers: [0] }, 'POST', { cookie: studentCookie });
    assert.equal(passed.passed, true);
    const stray = await api(`/portal/lessons/${unitLessons.quiz}/watch`, { seconds: 30 }, 'POST', { cookie: studentCookie });
    assert.equal(stray.status, 'completed', 'a lesson already finished stays finished');

    const report = await api(`/lms/courses/${courseId}/watch-report`);
    const video = report.lessons.find(l => l.lessonId === videoLessonId);
    assert.equal(video.completed, 1);
    assert.equal(video.started, 1);
    assert.equal(video.notStarted, students.length - 1);
    assert.equal(video.avgWatchedPct, 100, 'averaged over the ones who opened it, not over the whole class');
  });

  // ---------------- discussion threads ----------------
  test('a question on a course gets a reply, and the asker is told', async () => {
    threadId = (await api('/portal/discussions', { lessonId: videoLessonId, body: 'Why is 3/6 the same as 1/2, miss?' }, 'POST', { cookie: studentCookie })).id;
    const replyId = (await api('/lms/discussions', { parentId: threadId, body: 'Because both the top and the bottom are halved. Watch from 4:20 again.' })).id;
    assert.ok(replyId);
    assert.equal(await told('lms.discussion_reply'), 1, 'the person who asked is the one waiting for the answer');
    assert.equal(await events('discussion.replied'), 1);
    await api(`/lms/discussions/${replyId}/answer`, {});
    await api(`/lms/discussions/${replyId}/upvote`, {});

    const seen = await api(`/portal/discussions?lessonId=${videoLessonId}`, undefined, 'GET', { cookie: studentCookie });
    assert.equal(seen.threads.length, 1, 'one question');
    assert.equal(seen.threads[0].replies.length, 1, 'with its reply underneath it');
    assert.equal(seen.threads[0].replies[0].isAnswer, true);
    assert.equal(seen.threads[0].replies[0].upvotes, 1);

    // a reply to a reply still hangs off the question, so a thread stays readable on a phone
    await api('/lms/discussions', { parentId: seen.threads[0].replies[0].id, body: 'Thank you, I see it now.' });
    const again = await api(`/portal/discussions?lessonId=${videoLessonId}`, undefined, 'GET', { cookie: studentCookie });
    assert.equal(again.threads.length, 1);
    assert.equal(again.threads[0].replies.length, 2);
  });

  test('a student sees their own course’s threads and nobody else’s', async () => {
    // a second course, on a subject this class-subject group is not enrolled on
    otherCourseId = (await api('/lms/courses', { title: 'Somebody else’s course', teacherId })).id;
    const otherModule = (await api(`/lms/courses/${otherCourseId}/modules`, { title: 'Unit one' })).id;
    await api('/lms/lessons', { moduleId: otherModule, title: 'Not for you', lessonType: 'note' });
    await api(`/lms/courses/${otherCourseId}/publish`, {});
    await api('/lms/discussions', { courseId: otherCourseId, body: 'A question from another class.' });

    assert.equal(await status(`/portal/discussions?courseId=${otherCourseId}`, { cookie: studentCookie }), 403, 'not their course');
    assert.equal(await status(`/portal/discussions?courseId=${otherCourseId}&studentId=${students[0].id}`, { cookie: guardianCookie }), 403, 'nor their guardian’s');
    // and a guardian cannot read a course by naming a child who is not theirs
    assert.equal(await status(`/portal/discussions?courseId=${courseId}&studentId=${students[2].id}`, { cookie: guardianCookie }), 403);
    // their own child, their own course, is fine
    const mine = await api(`/portal/discussions?courseId=${courseId}&studentId=${students[0].id}`, undefined, 'GET', { cookie: guardianCookie });
    assert.equal(mine.threads.length, 1);
    // staff see every course
    assert.equal((await api(`/lms/discussions?courseId=${otherCourseId}`)).threads.length, 1);
    // a question needs a course or a lesson to belong to
    await assert.rejects(() => api('/lms/discussions', { body: 'Floating in space.' }), /course or to a lesson/);
  });

  // ---------------- similarity between text answers ----------------
  test('two answers that share their wording are put in front of the teacher, not punished', async () => {
    assignmentId = (await api('/lms/assignments', { sectionId, classSubjectId, teacherId, title: 'Write about the water cycle', dueAt: `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} 23:59:00`, maxMarks: 20, submissionType: 'text' })).id;
    const copied = 'The water cycle describes how water moves around the earth again and again without ever stopping. Water in rivers lakes and the sea is warmed by the sun and turns into vapour which rises into the air. High above the ground the vapour cools down and condenses into tiny droplets which gather together and form the clouds we can see. When the droplets in a cloud grow heavy enough they fall back to the ground as rain or as snow on the mountains and the whole journey begins once more.';
    const nearlyCopied = copied.replace('describes how water moves around the earth', 'explains how water travels around the earth');
    const ownWords = 'Bangladesh has six seasons and each one changes the way our village looks and the way we live in it. In the monsoon the fields behind our house fill with water and my younger brother catches small fish in the ditch by the road with a torn net. In winter a thick fog sits over the paddy until the middle of the morning and my grandmother refuses to leave her quilt before the sun is properly up and warming the courtyard.';
    const tooShort = 'The water cycle is when water goes up and comes back down as rain.';
    for (const [i, text] of [copied, nearlyCopied, ownWords, tooShort].entries()) {
      await app.lms.submit(schoolId, { assignmentId, studentId: students[i].id, textAnswer: text });
    }

    const r = await api(`/lms/assignments/${assignmentId}/similarity`, {});
    assert.equal(r.checked, 3, 'the short one was never compared');
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].studentId, students[3].id);
    assert.match(r.skipped[0].reason, /too short to tell copying from a shared definition/);

    assert.equal(r.pairs.length, 1, 'only the pair that really does share its wording');
    const pair = r.pairs[0];
    assert.deepEqual([pair.a.studentId, pair.b.studentId].sort(), [students[0].id, students[1].id].sort());
    assert.ok(pair.similarityPct > 70, `${pair.similarityPct}% alike`);
    assert.ok(pair.sharedPhrases[0].length > 40, 'the teacher is shown the wording, not just a number');
    assert.match(r.note, /not a finding/);

    // the number is kept beside the submission, and nothing else about the submission moved
    const first = await app.db.findOne('assignment_submissions', { assignment_id: assignmentId, student_id: students[0].id });
    assert.ok(Number(first.similarity_pct) > 70);
    assert.equal(first.marks, null, 'a similarity score never marks anything');
    assert.equal(String(first.status), 'submitted');
    const short = await app.db.findOne('assignment_submissions', { assignment_id: assignmentId, student_id: students[3].id });
    assert.equal(short.similarity_pct, null, 'a skipped answer keeps an empty score rather than a misleading zero');
    const own = await app.db.findOne('assignment_submissions', { assignment_id: assignmentId, student_id: students[2].id });
    assert.ok(Number(own.similarity_pct) < 20);

    assert.equal(await told('lms.similarity_found'), 1, 'the teacher is asked to look');
    assert.equal(await events('assignment.similarity_flagged'), 1);
    // and nobody at home hears a word about it: every notice about this went to a member of staff
    const home = await app.db.query(`SELECT COUNT(*) AS n FROM notifications n JOIN users u ON u.id = n.recipient_user_id
      WHERE n.school_id = ? AND n.event_key = 'lms.similarity_found' AND u.user_type IN ('guardian', 'student')`, [schoolId]);
    assert.equal(Number(home[0].n), 0, 'similarity is a teacher\u2019s business, not a family\u2019s');
  });

  test('a class where nobody copied reports nothing at all', async () => {
    const noticesBefore = await app.db.query(`SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND event_key = 'lms.similarity_found'`, [schoolId]);
    const clean = (await api('/lms/assignments', { sectionId, classSubjectId, teacherId, title: 'Describe your village', dueAt: `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} 23:59:00`, submissionType: 'text' })).id;
    await app.lms.submit(schoolId, { assignmentId: clean, studentId: students[0].id, textAnswer: 'Our village sits beside a slow brown river that swells every monsoon until the jackfruit trees at the bottom of the field stand in water up to their lowest branches and the ferry stops running for a week at a time. My uncle keeps the ferry rope tied to a post outside his shop until the water goes down again.' });
    await app.lms.submit(schoolId, { assignmentId: clean, studentId: students[1].id, textAnswer: 'My father keeps four ducks behind the kitchen and every morning before school I carry their bowl down to the pond and wait while they eat because otherwise the neighbour’s goat pushes its head into the bowl. In the evening I count them back into the shed and shut the door with a brick.' });
    const r = await api(`/lms/assignments/${clean}/similarity`, {});
    assert.equal(r.checked, 2);
    assert.equal(r.pairs.length, 0);
    assert.equal(r.highestPct, 0);
    const noticesAfter = await app.db.query(`SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND event_key = 'lms.similarity_found'`, [schoolId]);
    assert.equal(Number(noticesAfter[0].n), Number(noticesBefore[0].n), 'and the teacher is not pestered about a clean set');
  });

  // ---------------- adaptive learning ----------------
  test('the revision plan names the indicators not met and the lessons that cover them', async () => {
    await api('/exams/competency/scales', {});
    // three indicators: one on a unit the course teaches, one on a unit it does not, one on no unit
    outcomes.covered = (await api('/exams/competency/outcomes', { classSubjectId, code: '1.1', statement: 'Compares two fractions and says which is larger', unitId: unitIds[0] })).id;
    outcomes.uncovered = (await api('/exams/competency/outcomes', { classSubjectId, code: '3.1', statement: 'Names the parts of a triangle', unitId: unitIds[2] })).id;
    outcomes.unmapped = (await api('/exams/competency/outcomes', { classSubjectId, code: '9.9', statement: 'Explains a result to the class', weight: 2 })).id;
    outcomes.met = (await api('/exams/competency/outcomes', { classSubjectId, code: '2.1', statement: 'Writes a decimal as a fraction', unitId: unitIds[1] })).id;
    await api('/exams/competency/assess', { rows: [
      { studentId: students[0].id, outcomeId: outcomes.covered, termId, levelCode: '△' },
      { studentId: students[0].id, outcomeId: outcomes.uncovered, termId, levelCode: '○' },
      { studentId: students[0].id, outcomeId: outcomes.unmapped, termId, levelCode: '○' },
      { studentId: students[0].id, outcomeId: outcomes.met, termId, levelCode: '□' },
    ] });

    const plan = await api(`/adaptive/plan/${students[0].id}?termId=${termId}`);
    assert.equal(plan.assessed, 4);
    assert.equal(plan.met, 1);
    assert.equal(plan.indicators.length, 3);
    assert.equal(plan.indicators[0].code, '1.1', 'weakest first — a plan is what to start on tonight');

    const covered = plan.indicators.find(i => i.code === '1.1');
    assert.equal(covered.covered, true);
    assert.equal(covered.unitTitle, 'Fractions');
    assert.equal(covered.lessons[0].id, videoLessonId);
    assert.equal(covered.lessons[0].enrolled, true, 'and it is a course this child can actually open');
    assert.equal(covered.lessons[0].done, true, 'they watched it and still have not met the indicator');
    assert.equal(covered.quizzes[0].id, unitLessons.quiz);
    assert.equal(covered.materials.length, 1);
    assert.equal(covered.gap, null);

    // nothing covers it → say so, rather than sending the child to the nearest chapter
    const uncovered = plan.indicators.find(i => i.code === '3.1');
    assert.equal(uncovered.covered, false);
    assert.equal(uncovered.lessons.length, 0);
    assert.match(uncovered.gap, /nothing published covers “Geometry” yet/);
    const unmapped = plan.indicators.find(i => i.code === '9.9');
    assert.match(unmapped.gap, /not tied to a syllabus unit/);
    assert.equal(plan.covered, 1);
    assert.equal(plan.uncovered, 2);
    assert.equal(plan.gaps.length, 2, 'the gaps are the teacher’s list of what to write next');

    // a child nobody has rated gets an honest empty plan, not a made-up one
    const nothing = await api(`/adaptive/plan/${students[2].id}?termId=${termId}`);
    assert.equal(nothing.indicators.length, 0);
    assert.match(nothing.note, /nobody has rated this child/);
  });

  test('the plan is pushed home once a week, and not twice', async () => {
    const pushed = await api(`/adaptive/plan/${students[0].id}/push`, { termId });
    assert.ok(pushed.sent >= 2, 'the child and the guardian');
    assert.equal(pushed.indicators, 3);
    assert.equal(await events('revision_plan.built'), 1);
    const body = String((await app.db.query(`SELECT body FROM notifications WHERE school_id = ? AND event_key = 'adaptive.revision_plan' ORDER BY created_at DESC, id DESC`, [schoolId]))[0].body);
    assert.match(body, /Compares two fractions/);
    assert.match(body, /Fractions on a number line/, 'and where to go for it');

    // the weekly pass does not send a second copy to a family that had one on Saturday
    const before = await told('adaptive.revision_plan');
    const run = await api('/adaptive/run', { termId });
    assert.equal(run.planned, 0);
    assert.equal(run.considered, 0, 'the family told already is left out of the query, not picked up and dropped');
    assert.equal(await told('adaptive.revision_plan'), before, 'a plan that arrives nightly is wallpaper');
  });

  test('the weekly pass plans for the children somebody has actually rated', async () => {
    for (const s of [students[1], students[2]]) await api('/exams/competency/assess', { rows: [{ studentId: s.id, outcomeId: outcomes.covered, termId, levelCode: '○' }] });
    const run = await api('/adaptive/run', { termId });
    assert.equal(run.considered, 2, 'the child told on Saturday is left out of the query, not skipped in the loop');
    assert.equal(run.planned, 2);
    assert.ok(run.sent >= 2, 'neither child has a portal account of their own, so the plans go to the guardians');
    // one child at a time still reaches everybody: the window walks forward instead of handing back
    // the same first names every tick and skipping them for ever after
    await app.db.execute(`DELETE FROM notifications WHERE school_id = ? AND event_key = 'adaptive.revision_plan'`, [schoolId]);
    const reached = new Set();
    for (let i = 0; i < 3; i++) {
      await api('/adaptive/run', { termId, limit: 1 });
      const rows = await app.db.query(`SELECT DISTINCT entity_id FROM notifications WHERE school_id = ? AND event_key = 'adaptive.revision_plan'`, [schoolId]);
      for (const r of rows) reached.add(String(r.entity_id));
    }
    assert.equal([students[0], students[1], students[2]].filter(s => reached.has(s.id)).length, 3, 'all three rated children were reached, one pass at a time');
  });

  test('the teacher is told which indicator the room is stuck on, and what teaches it', async () => {
    const gaps = await api(`/adaptive/gaps?classSubjectId=${classSubjectId}&termId=${termId}`);
    assert.equal(gaps.students, 3);
    const top = gaps.outcomes[0];
    assert.equal(top.code, '1.1', 'the one most of the class missed comes first');
    assert.equal(top.notMet, 3);
    assert.equal(top.notMetPct, 100);
    assert.equal(top.covered, true);
    assert.ok(top.teaches.length >= 2, 'and here is what to set them');
    const geometry = gaps.outcomes.find(o => o.code === '3.1');
    assert.equal(geometry.covered, false);
    assert.match(geometry.gap, /nothing published covers this unit yet/);
    // an indicator every rated child met is not a gap
    const met = gaps.outcomes.find(o => o.code === '2.1');
    assert.equal(met.notMet, 0);
  });

  test('a guardian reads their own child’s plan and nobody else’s', async () => {
    const mine = await api(`/portal/revision/${students[0].id}?termId=${termId}`, undefined, 'GET', { cookie: guardianCookie });
    assert.equal(mine.indicators.length, 3);
    assert.equal(await status(`/portal/revision/${students[2].id}?termId=${termId}`, { cookie: guardianCookie }), 403);
    // the child sees the same plan from their own account
    const asStudent = await api(`/portal/revision/${students[0].id}?termId=${termId}`, undefined, 'GET', { cookie: studentCookie });
    assert.equal(asStudent.indicators[0].code, '1.1');
    // and the console endpoints stay shut to a portal account
    assert.equal(await status(`/adaptive/plan/${students[0].id}`, { cookie: guardianCookie }), 403);
    assert.equal(await status(`/lms/courses/${courseId}/watch-report`, { cookie: studentCookie }), 403);
  });
});
