// The academic half of the system, running itself.
//
// Everything here used to need somebody to remember: build the seat plan, lock the marks, press
// Compute, press Publish, work out the annual result, create next year, notice that a class has no
// teacher, notice that a term closed with results outstanding. Each one is now either a scheduled job
// or an event rule — and the two properties that make an automation safe on shared hosting are what
// this suite is for. Running it twice must change nothing the first run did not already do (the
// scheduler is at-least-once and a recycled Passenger process re-runs the whole pass), and it must
// stay silent when its precondition is not met (an automation that fires anyway is worse than none).
//
// Nothing here publishes a result, applies a promotion or publishes a timetable. Those are the three
// things a person still presses, and the tests say so.
//   node --test tests/auto-academic.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-auto-academic');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'auto-acad-key'.padEnd(64, 'x'), CRON_KEY: 'cron-auto-acad', UPLOADS_DIR: 'tests/.tmp-auto-academic/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-auto-academic/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');

let app, schoolId, yearId, classId, sectionId, teacher, teacherB, students = [], newcomer;
let examId, blockedStudent, blockedInvoice, syllabusId, assignmentId, assignmentLateOk;
let termId, closedTermId, programId, collegeStudent, csIds = [];
let afternoonClassId, afternoonStudents = [];
const N = 8;
const t0 = Date.now();

const iso = d => d.toISOString().slice(0, 10);
const shift = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const today = iso(new Date());

describe('the academic modules run themselves', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Automation High', institutionType: 'school', locale: 'bn', adminName: 'Head', adminPhone: '01799999999', adminEmail: 'head@auto.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    yearId = String((await app.academic.currentYear(schoolId)).id);
    const classes = await app.academic.classes(schoolId);
    classId = String(classes[5].id);
    sectionId = String((await app.academic.sections(schoolId, yearId, classId))[0].id);
    for (let i = 0; i < N; i++) {
      students.push(await app.people.createStudent(schoolId, {
        firstName: `Child${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2013-04-04', classId, sectionId,
        guardians: [{ fullName: `Parent ${i + 1}`, phone: `0186000000${i}`, relation: 'father', isPrimary: true }],
      }));
    }
    // a second class on an afternoon shift, so the cut-off can be shown to belong to the class rather
    // than to the school: everyone here used to be marked absent at 10:30, before they had left home
    afternoonClassId = String(classes[6].id);
    const afternoonSection = String((await app.academic.sections(schoolId, yearId, afternoonClassId))[0].id);
    for (let i = 0; i < 2; i++) {
      afternoonStudents.push(await app.people.createStudent(schoolId, { firstName: `Afternoon${i + 1}`, gender: 'male', dateOfBirth: '2012-02-02', classId: afternoonClassId, sectionId: afternoonSection, guardians: [] }));
    }
    await app.attendance.setPolicy(schoolId, { audience: 'student', classId: afternoonClassId, autoAbsentAt: '13:30:00' });

    teacher = await app.people.createStaff(schoolId, { firstName: 'Rina', lastName: 'Akter', gender: 'female', staffCategory: 'teaching', joiningDate: shift(today, -400), phone: '01711111111' });
    teacherB = await app.people.createStaff(schoolId, { firstName: 'Kamal', lastName: 'Uddin', gender: 'male', staffCategory: 'teaching', joiningDate: shift(today, -400), phone: '01722222222' });
  });
  after(async () => { await app?.stop(); console.log(`auto-academic finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  /** Runs the scheduled handler exactly as the scheduler would, so the job key is part of the assertion. */
  const job = (mod, key, payload = {}) => {
    const fn = app[mod].jobs()[key];
    assert.ok(fn, `${mod} has no job ${key}`);
    return fn({ schoolId, jobKey: key, payload, deadline: Date.now() + 20_000 });
  };
  const tasks = (taskType, status = 'open') => app.db.query(`SELECT * FROM tasks WHERE school_id = ? AND task_type = ? AND status = ?`, [schoolId, taskType, status]);
  const notes = eventKey => app.db.query(`SELECT * FROM notifications WHERE school_id = ? AND event_key = ?`, [schoolId, eventKey]);
  const drain = async () => { for (let i = 0; i < 60; i++) { await app.relay.run(); const q = await app.adapters.queue.drain(20); if (!q.ran) break; } await app.relay.run(); };
  /** A day this school actually opens — the weekend is Friday and Saturday, and today may be either. */
  const workingDay = async back => { let d = shift(today, -back); for (let i = 0; i < 8; i++) { if (!(await app.academic.isHoliday(schoolId, d))) return d; d = shift(d, -1); } throw new Error('no working day'); };

  // ------------------------------------------------------------------ wiring
  test('every new job is seeded as a cron row and reachable through its own module', async () => {
    const seeded = new Set((await app.db.query(`SELECT job_key FROM scheduled_jobs WHERE school_id = ?`, [schoolId])).map(r => String(r.job_key)));
    const expected = {
      academic: ['academic.year_rollover'],
      curriculum: ['academic.syllabus_lag'],
      timetable: ['timetable.cover_today', 'timetable.watch'],
      assessment: ['exams.pre_exam_prep', 'exams.marks_deadline_reminders', 'exams.auto_compute', 'exams.publish_due', 'exams.year_end'],
      attendance: ['attendance.auto_absent'],
      lms: ['lms.assignment_reminders', 'lms.marking_backlog'],
      college: ['college.registration_watch', 'college.term_watch'],
    };
    for (const [mod, keys] of Object.entries(expected)) {
      const jobs = app[mod].jobs();
      for (const k of keys) {
        assert.ok(typeof jobs[k] === 'function', `${mod}.jobs() is missing ${k}`);
        assert.ok(seeded.has(k), `${k} has no row in scheduled_jobs (docs/AUTOMATION.md)`);
      }
    }
  });

  // ------------------------------------------------------------------ attendance
  test('auto-absent waits for each class\'s own cut-off, then marks once', async () => {
    const day = await workingDay(0);
    // the job ticks every half hour, so most ticks are answered by the earliest cut-off alone
    const early = await app.attendance.autoAbsent(schoolId, day, { asOf: '07:15' });
    assert.equal(early.absent, 0, 'nobody is absent before any register has closed');
    assert.equal(early.before, '10:30', 'and the roll is not even read');

    const morning = await app.attendance.autoAbsent(schoolId, day, { asOf: '11:00' });
    assert.equal(morning.absent, N, 'the 10:30 classes are marked');
    assert.equal(morning.waiting, afternoonStudents.length, 'the afternoon class waits for its own 13:30 instead of being absent before it left home');
    assert.equal(await app.db.count('student_attendance', { on_date: day, student_id: afternoonStudents[0].id }), 0);

    const again = await app.attendance.autoAbsent(schoolId, day, { asOf: '11:00' });
    assert.equal(again.absent, 0, 'a second pass marks nobody twice');

    const afternoon = await app.attendance.autoAbsent(schoolId, day, { asOf: '14:00' });
    assert.equal(afternoon.absent, afternoonStudents.length, 'and at 13:30 their own register closes');
    assert.equal((await app.attendance.autoAbsent(schoolId, day, { asOf: '14:00' })).absent, 0);

    const rows = await app.db.query(`SELECT status, source FROM student_attendance WHERE school_id = ? AND on_date = ?`, [schoolId, day]);
    assert.equal(rows.length, N + afternoonStudents.length);
    assert.ok(rows.every(r => r.status === 'absent' && r.source === 'system'));
  });

  test('auto-absent stays silent on a holiday, whatever the clock says', async () => {
    const day = shift(today, 20);
    await app.academic.addCalendarEvent(schoolId, { title: 'Eid holiday', eventType: 'holiday', startDate: day, endDate: day });
    const r = await app.attendance.autoAbsent(schoolId, day, { asOf: '23:59' });
    assert.equal(r.skipped, 'holiday');
    assert.equal(r.absent, 0);
  });

  test('a holiday declared after the fact clears the system\'s own rows and leaves a teacher\'s mark alone', async () => {
    const day = await workingDay(2);
    await app.attendance.mark(schoolId, students[0].id, day, 'present', { source: 'manual', notify: false });
    await app.attendance.autoAbsent(schoolId, day, { asOf: '23:59' });
    const roll = N + afternoonStudents.length;
    assert.equal((await app.db.query(`SELECT COUNT(*) AS n FROM student_attendance WHERE on_date = ? AND status = 'absent'`, [day]))[0].n, roll - 1);

    await app.academic.addCalendarEvent(schoolId, { title: 'Mourning day', eventType: 'holiday', startDate: day, endDate: day });
    await drain();
    const after = await app.db.query(`SELECT student_id, status, source FROM student_attendance WHERE on_date = ?`, [day]);
    const manual = after.find(r => r.student_id === students[0].id);
    assert.equal(manual.status, 'present', 'the teacher saw the child; the calendar does not overrule that');
    assert.equal(after.filter(r => r.status === 'holiday').length, roll - 1);
    // and a second delivery of the same event changes nothing
    await app.attendance.applyHoliday(schoolId, day, day);
    const twice = await app.db.query(`SELECT status FROM student_attendance WHERE on_date = ?`, [day]);
    assert.equal(twice.filter(r => r.status === 'holiday').length, roll - 1);
    assert.equal(twice.filter(r => r.status === 'present').length, 1);
  });

  // ------------------------------------------------------------------ exams: preparation
  test('a week out, the exam prepares itself: seat plan, event and admit cards, once', async () => {
    const start = shift(today, 5);
    const made = await app.assessment.createExam(schoolId, { name: 'Half yearly', startDate: start, endDate: shift(start, 3), classIds: [classId], requireFeeClearance: true });
    examId = made.id;
    assert.ok(made.schedules > 0, 'one paper per class-subject');
    blockedStudent = students[N - 1];
    blockedInvoice = await app.fees.createInvoice(schoolId, { studentId: blockedStudent.id, academicYearId: yearId, items: [{ description: 'Tuition', amount: 1200 }] });

    const first = await job('assessment', 'exams.pre_exam_prep', { onDate: today });
    assert.equal(first.prepared, 1);
    assert.equal(first.cards, 1, 'the cards are queued by the job, not only by the button');
    const plan = await app.assessment.seatPlan(schoolId, examId);
    assert.equal(plan.length, N);
    assert.equal(plan.filter(p => !Number(p.is_eligible)).length, 1);
    const events = await app.db.query(`SELECT * FROM outbox_events WHERE school_id = ? AND event_type = 'exam.scheduled'`, [schoolId]);
    assert.equal(events.length, 1, 'the routine and the calendar hang off this event');

    // the halls are staffed by the same pass: an exam nobody touched must not reach the morning with
    // nobody standing in it, and a room it could not staff leaves the task that names the room
    assert.ok(first.duties >= 1, `invigilators were rostered by the job: ${JSON.stringify(first)}`);
    const roster = await app.assessment.invigilators(schoolId, examId);
    assert.equal(roster.length, first.duties, 'the duties the job reported are the rows in the roster');

    const second = await job('assessment', 'exams.pre_exam_prep', { onDate: today });
    assert.equal(second.prepared, 0, 'the exam is scheduled now; it is not prepared again');
    assert.equal(second.cards, 0);
    assert.equal(second.duties, 0, 'and nobody is rostered twice');
    assert.equal((await app.assessment.invigilators(schoolId, examId)).length, roster.length);
    assert.equal((await app.assessment.seatPlan(schoolId, examId)).length, N, 'no duplicate seats');
  });

  test('the night before, the plan is topped up and the issued cards survive', async () => {
    await drain();
    const before = await app.assessment.seatPlan(schoolId, examId);
    const carded = before.filter(p => p.admit_card_file_id);
    assert.equal(carded.length, N - 1, 'every eligible candidate has a card');
    const keptFileId = carded[0].admit_card_file_id;

    // the exam is now tomorrow; a child joined the class and the blocked family paid
    await app.db.update('exams', { start_date: shift(today, 1) }, { id: examId });
    newcomer = await app.people.createStudent(schoolId, { firstName: 'Latecomer', gender: 'male', dateOfBirth: '2013-05-05', classId, sectionId, guardians: [] });
    await app.fees.recordPayment(schoolId, { studentId: blockedStudent.id, amount: 1200, method: 'cash', invoiceIds: [blockedInvoice.id] });

    const r = await job('assessment', 'exams.pre_exam_prep', { onDate: today });
    assert.equal(r.refreshed, 2, 'one new candidate seated, one cleared candidate made eligible');
    const after = await app.assessment.seatPlan(schoolId, examId);
    assert.equal(after.length, N + 1);
    assert.ok(after.every(p => Number(p.is_eligible)), 'the paid family is no longer blocked');
    assert.equal(after.find(p => p.student_id === carded[0].student_id).admit_card_file_id, keptFileId, 'a card already issued is not thrown away');
    const seats = after.map(p => `${p.room_id}:${p.seat_no}`);
    assert.equal(new Set(seats).size, seats.length, 'every seat is still unique');

    const twice = await job('assessment', 'exams.pre_exam_prep', { onDate: today });
    assert.equal(twice.refreshed, 0, 'nothing left to top up');
    assert.equal((await app.assessment.seatPlan(schoolId, examId)).length, N + 1);
  });

  // ------------------------------------------------------------------ exams: marks, compute, publish
  test('at the deadline complete papers lock themselves and the short ones escalate once', async () => {
    const schedules = await app.assessment.schedules(schoolId, examId);
    const roll = [...students, newcomer];
    // every paper but the last gets a full set of marks
    for (const s of schedules.slice(0, -1)) {
      await app.assessment.saveMarks(schoolId, String(s.id), roll.map((st, i) => ({ studentId: st.id, theory: 40 + (i % 8) * 5 })));
    }
    await app.db.update('exams', { marks_entry_deadline: `${shift(today, -1)} 23:00:00` }, { id: examId });

    const first = await job('assessment', 'exams.marks_deadline_reminders');
    assert.equal(first.locked, schedules.length - 1, 'a paper whose marks are all in locks itself at the deadline');
    assert.equal(first.escalated, 1, 'the paper still short goes to the office');
    assert.equal((await tasks('assessment.marks_overdue')).length, 1);

    const second = await job('assessment', 'exams.marks_deadline_reminders');
    assert.equal(second.locked, 0, 'nothing to lock twice');
    assert.equal(second.escalated, 0, 'the office is not told the same thing every morning');
    assert.equal((await tasks('assessment.marks_overdue')).length, 1);
  });

  test('a paper still short of marks keeps the result engine quiet', async () => {
    const r = await job('assessment', 'exams.auto_compute', { onDate: shift(today, 10) });
    assert.equal(r.computed.length, 0, 'half a cohort computed is a rank order that is wrong for everybody');
    assert.equal(r.waiting, 1);
    assert.equal(await app.db.count('exam_results', { exam_id: examId }), 0);
    assert.equal((await tasks('assessment.publish')).length, 0);
  });

  test('the last mark in computes the results and prepares the publish decision — it does not publish', async () => {
    const schedules = await app.assessment.schedules(schoolId, examId);
    const last = schedules[schedules.length - 1];
    const roll = [...students, newcomer];
    await app.assessment.saveMarks(schoolId, String(last.id), roll.map((st, i) => ({ studentId: st.id, theory: 55 + (i % 5) * 4 })));

    const r = await job('assessment', 'exams.auto_compute', { onDate: shift(today, 10) });
    assert.equal(r.computed.length, 1);
    assert.equal(r.computed[0].students, roll.length);
    const exam = await app.db.findOne('exams', { id: examId });
    assert.equal(exam.status, 'processing', 'computed, not published');
    assert.equal(exam.publish_at, null);
    assert.equal(await app.db.count('exam_results', { exam_id: examId, report_card_file_id: null }), roll.length, 'no report card has been rendered');
    await drain();
    assert.equal((await notes('assessment.result_published')).length, 0, 'not one guardian has been told a GPA');

    const t = await tasks('assessment.publish');
    assert.equal(t.length, 1, 'one task carries the decision');
    assert.match(String(t[0].description), /cannot be undone/);
    assert.match(String(t[0].description), /not locked/, 'the outstanding paper is named in the task');
    assert.ok((await notes('assessment.results_ready')).length > 0);

    const second = await job('assessment', 'exams.auto_compute', { onDate: shift(today, 10) });
    assert.equal(second.computed.length, 0, 'a computed exam is not computed again');
    assert.equal((await tasks('assessment.publish')).length, 1, 'and the task is not raised twice');
  });

  test('a publication date the school set is carried out, and the report cards finish', async () => {
    assert.deepEqual(await job('assessment', 'exams.publish_due'), { published: 0, resumed: 0 }, 'silent while no date has arrived');

    const at = `${shift(today, -1)} 09:00:00`;
    const r = await app.assessment.publish(schoolId, examId, { publishAt: `${shift(today, 400)} 09:00:00` });
    assert.equal(r.scheduled, `${shift(today, 400)} 09:00:00`, 'a future date is only written down');
    assert.equal(await app.db.count('exam_results', { exam_id: examId, report_card_file_id: null }), N + 1);

    await app.db.update('exams', { publish_at: at }, { id: examId });
    const due = await job('assessment', 'exams.publish_due');
    assert.equal(due.published, 1);
    await drain();
    assert.equal(String((await app.db.findOne('exams', { id: examId })).status), 'published');
    assert.equal(await app.db.count('exam_results', { exam_id: examId, report_card_file_id: null }), 0, 'every report card rendered');
    assert.ok((await notes('assessment.result_published')).length >= N, 'now the guardians hear it');

    const sentBefore = (await notes('assessment.result_published')).length;
    const twice = await job('assessment', 'exams.publish_due');
    assert.equal(twice.published, 0, 'a published exam is not published again');
    assert.equal(twice.resumed, 0, 'and nothing is left to re-render');
    await drain();
    assert.equal((await notes('assessment.result_published')).length, sentBefore, 'no family is told twice');
  });

  test('a report card the batch never reached is picked up again', async () => {
    const one = (await app.db.query(`SELECT id FROM exam_results WHERE exam_id = ? LIMIT 1`, [examId]))[0];
    await app.db.update('exam_results', { report_card_file_id: null }, { id: String(one.id) });
    const r = await job('assessment', 'exams.publish_due');
    assert.equal(r.resumed, 1);
    await drain();
    assert.equal(await app.db.count('exam_results', { exam_id: examId, report_card_file_id: null }), 0);
  });

  test('the prepared task counts a child once, not once per paper', async () => {
    for (const t of await tasks('assessment.publish')) await app.tasks.complete(String(t.id), schoolId);
    await app.people.createStudent(schoolId, { firstName: 'Arrived', gender: 'female', dateOfBirth: '2013-07-07', classId, sectionId, guardians: [] });
    const r = await app.assessment.prepareResultRelease(schoolId, examId);
    assert.equal(r.prepared, true);
    const t = (await tasks('assessment.publish'))[0];
    assert.match(String(t.description), /1 student\(s\) on the roll with no result/, 'a class with six papers must not report the same child six times');
    for (const x of await tasks('assessment.publish')) await app.tasks.complete(String(x.id), schoolId);
  });

  // ------------------------------------------------------------------ year end
  test('next year is built before the current one runs out — planned, never made current', async () => {
    const early = await app.academic.ensureNextYear(schoolId, { onDate: today });
    const year = await app.academic.currentYear(schoolId);
    if (Math.round((Date.parse(`${String(year.end_date).slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) > 30) {
      assert.equal(early.created, null, 'the year still has months left; nothing is created');
      assert.match(String(early.skipped), /still has/);
    }

    const near = shift(String(year.end_date).slice(0, 10), -10);
    const r = await job('academic', 'academic.year_rollover', { onDate: near });
    assert.ok(r.created, 'the next year exists before anybody needs it');
    const next = await app.db.findOne('academic_years', { id: r.created });
    assert.equal(Number(next.is_current), 0, 'which year the school is running stays a person\'s decision');
    assert.equal(String(next.status), 'planned');
    assert.ok(await app.db.count('class_subjects', { academic_year_id: r.created }) > 0, 'the matrix is cloned');
    assert.ok(await app.db.count('sections', { academic_year_id: r.created }) > 0, 'so are the section skeletons');

    const twice = await job('academic', 'academic.year_rollover', { onDate: near });
    assert.equal(twice.created, null);
    assert.match(String(twice.skipped), /already exists/);
    assert.equal(await app.db.count('academic_years', { school_id: schoolId }), 2);
  });

  test('the annual result is computed nightly and the promotion is prepared, not applied', async () => {
    const year = await app.academic.currentYear(schoolId);
    const near = shift(String(year.end_date).slice(0, 10), -10);
    const early = await job('assessment', 'exams.year_end', { onDate: shift(String(year.start_date).slice(0, 10), 1) });
    assert.match(String(early.skipped), /still has/, 'silent until the year is nearly over');

    const r = await job('assessment', 'exams.year_end', { onDate: near });
    assert.equal(r.skipped, null);
    assert.ok(r.computed > 0);
    assert.equal(await app.db.count('annual_results', { academic_year_id: yearId }), r.computed);
    assert.equal(await app.db.count('promotions', { school_id: schoolId }), 0, 'nothing has moved');
    assert.equal(await app.db.count('student_enrollments', { academic_year_id: r.toYearId }), 0, 'no child is in next year yet');
    const t = await tasks('assessment.promote');
    assert.equal(t.length, 1);
    assert.match(String(t[0].description), /Nothing has moved yet/);

    const twice = await job('assessment', 'exams.year_end', { onDate: near });
    assert.match(String(twice.skipped), /already waiting/);
    assert.equal((await tasks('assessment.promote')).length, 1);
    assert.equal(await app.db.count('promotions', { school_id: schoolId }), 0);
  });

  // ------------------------------------------------------------------ timetable
  test('a class-subject with no teacher is filled, and a clean draft is offered — not published', async () => {
    await app.db.insert('staff_subjects', { id: `${Date.now()}A`.padEnd(26, 'X'), school_id: schoolId, staff_id: teacher.id, subject_id: String((await app.academic.subjects(schoolId))[0].id) });
    const early = await job('timetable', 'timetable.watch', { onDate: shift(String((await app.academic.currentYear(schoolId)).start_date).slice(0, 10), 2) });
    assert.match(String(early.skipped), /settling/, 'the first week of a year is not evidence of anything');

    const r = await job('timetable', 'timetable.watch', { onDate: today });
    assert.ok(r.assigned > 0, 'the empty section-subjects were assigned');
    assert.equal(r.unassigned, 0);
    assert.equal(r.drafts, 0, 'there is no draft timetable yet');

    const gen = await app.timetable.generate(schoolId, yearId, { versionName: 'Auto v1', seed: 7 });
    assert.equal(gen.clashes, 0);
    const withDraft = await job('timetable', 'timetable.watch', { onDate: today });
    assert.equal(withDraft.drafts, 1);
    assert.equal(String((await app.db.findOne('timetable_versions', { id: gen.versionId })).status), 'draft', 'the job never publishes a timetable');
    const t = await tasks('curriculum.publish_timetable');
    assert.equal(t.length, 1);
    assert.match(String(t[0].description), /no clashes/);

    const twice = await job('timetable', 'timetable.watch', { onDate: today });
    assert.equal(twice.drafts, 0, 'the same draft is not offered every morning');
    assert.equal(twice.assigned, 0);
    assert.equal((await tasks('curriculum.publish_timetable')).length, 1);

    await app.timetable.publish(schoolId, gen.versionId);
  });

  test('a teacher the register says is away has their periods covered — proposed, for a person to approve', async () => {
    const day = await workingDay(0);
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    const version = await app.timetable.publishedVersion(schoolId, yearId);
    const mine = await app.db.query(`SELECT COUNT(*) AS n FROM timetable_slots WHERE version_id = ? AND teacher_id = ? AND day_of_week = ?`, [String(version.id), teacher.id, dow]);
    if (!Number(mine[0].n)) { await app.db.update('timetable_slots', { teacher_id: teacher.id }, { id: String((await app.db.query(`SELECT id FROM timetable_slots WHERE version_id = ? AND day_of_week = ? LIMIT 1`, [String(version.id), dow]))[0].id) }); }

    const quiet = await job('timetable', 'timetable.cover_today', { onDate: day });
    assert.equal(quiet.teachers, 0, 'nobody is away, so nothing is proposed');

    await app.attendance.markStaff(schoolId, teacher.id, day, 'absent', { source: 'system' });
    const r = await job('timetable', 'timetable.cover_today', { onDate: day });
    assert.equal(r.teachers, 1);
    assert.ok(r.slots > 0);
    const subs = await app.db.query(`SELECT * FROM timetable_substitutions WHERE school_id = ? AND on_date = ?`, [schoolId, day]);
    assert.ok(subs.length > 0);
    assert.ok(subs.every(s => String(s.status) === 'suggested' && Number(s.is_auto_suggested) === 1), 'proposed, never appointed');

    const twice = await job('timetable', 'timetable.cover_today', { onDate: day });
    assert.equal(twice.slots, 0, 'a second pass proposes nothing new');
    assert.equal((await app.db.query(`SELECT COUNT(*) AS n FROM timetable_substitutions WHERE on_date = ?`, [day]))[0].n, subs.length);
  });

  // ------------------------------------------------------------------ syllabus
  test('a syllabus behind schedule is flagged once, not every Sunday', async () => {
    const cs = (await app.academic.classSubjects(schoolId, yearId, classId))[0];
    syllabusId = await app.curriculum.createSyllabus(schoolId, {
      classSubjectId: String(cs.id), title: 'Term 1 syllabus',
      units: [{ title: 'Numbers', plannedEndDate: shift(today, -20) }, { title: 'Shapes', plannedEndDate: shift(today, -10) }, { title: 'Later', plannedEndDate: shift(today, 40) }],
    });
    const first = await job('curriculum', 'academic.syllabus_lag', { onDate: today });
    assert.equal(first.overdueUnits, 2);
    assert.equal(first.alerts, 1, 'one alert per section, naming both units');
    assert.ok((await notes('academic.syllabus_lag')).length > 0);

    const before = (await notes('academic.syllabus_lag')).length;
    const second = await job('curriculum', 'academic.syllabus_lag', { onDate: today });
    assert.equal(second.alerts, 0);
    assert.equal(second.quiet, 1, 'still behind, already said so');
    assert.equal((await notes('academic.syllabus_lag')).length, before, 'nobody is told twice inside the window');
  });

  // ------------------------------------------------------------------ LMS
  test('work handed in and not marked goes to the teacher who set it, once', async () => {
    const cs = (await app.academic.classSubjects(schoolId, yearId, classId))[0];
    assignmentId = await app.lms.createAssignment(schoolId, { sectionId, classSubjectId: String(cs.id), teacherId: teacher.id, title: 'Essay on the river', dueAt: `${shift(today, -5)} 17:00:00`, allowLate: true });
    assignmentLateOk = await app.lms.createAssignment(schoolId, { sectionId, classSubjectId: String(cs.id), teacherId: teacherB.id, title: 'Closed worksheet', dueAt: `${shift(today, -5)} 17:00:00`, allowLate: false });
    for (const s of students.slice(0, 3)) await app.lms.submit(schoolId, { assignmentId, studentId: s.id, textAnswer: 'done' });

    const first = await job('lms', 'lms.marking_backlog');
    assert.equal(first.chased, 1, 'only the assignment with unmarked work');
    assert.equal(first.closed, 1, 'the one that refuses late work is closed');
    assert.equal(String((await app.db.findOne('assignments', { id: assignmentLateOk })).status), 'closed');
    assert.equal(String((await app.db.findOne('assignments', { id: assignmentId })).status), 'published', 'an assignment that takes late work stays open');
    const t = await tasks('lms.marking_backlog');
    assert.equal(t.length, 1);
    assert.match(String(t[0].title), /Mark 3 submission/);

    const second = await job('lms', 'lms.marking_backlog');
    assert.equal(second.chased, 0, 'the teacher is not asked again while the task is open');
    assert.equal((await tasks('lms.marking_backlog')).length, 1);
  });

  test('once the work is marked the backlog is silent', async () => {
    for (const s of await app.lms.submissions(schoolId, assignmentId)) await app.lms.grade(schoolId, String(s.id), { marks: 15 });
    await app.tasks.complete(String((await tasks('lms.marking_backlog'))[0].id), schoolId);
    const r = await job('lms', 'lms.marking_backlog');
    assert.equal(r.chased, 0);
    assert.equal(r.closed, 0);
  });

  // ------------------------------------------------------------------ college
  test('a semester that closed with results outstanding reaches the registrar, once', async () => {
    programId = (await app.college.createProgram(schoolId, { name: 'Science stream', code: 'SCI-1', level: 'higher_secondary', durationTerms: 2, totalCredits: 8, classIds: [classId] })).id;
    const subjects = (await app.academic.subjects(schoolId)).slice(0, 2);
    for (const s of subjects) csIds.push((await app.college.setCredit(schoolId, { academicYearId: yearId, classId, subjectId: String(s.id), credit: 2 })).id);
    closedTermId = await app.academic.addTerm(schoolId, yearId, { name: 'Semester 1', sequence: 1, startDate: shift(today, -120), endDate: shift(today, -5), kind: 'semester' });
    termId = await app.academic.addTerm(schoolId, yearId, { name: 'Semester 2', sequence: 2, startDate: shift(today, -4), endDate: shift(today, 90), kind: 'semester' });
    collegeStudent = students[0];
    // registered while the term was still open
    await app.db.update('terms', { end_date: shift(today, 5) }, { id: closedTermId });
    await app.college.register(schoolId, { studentId: collegeStudent.id, termId: closedTermId, classSubjectIds: csIds });
    await app.db.update('terms', { end_date: shift(today, -5) }, { id: closedTermId });

    const first = await job('college', 'college.term_watch', { onDate: today });
    assert.equal(first.openRegisters, 1);
    const t = await tasks('college.open_register');
    assert.equal(t.length, 1);
    assert.match(String(t[0].description), /no result/);
    assert.equal(await app.db.count('course_registrations', { term_id: closedTermId, status: 'completed' }), 0, 'nobody is graded by a job');

    const second = await job('college', 'college.term_watch', { onDate: today });
    assert.equal(second.openRegisters, 0);
    assert.equal((await tasks('college.open_register')).length, 1);
  });

  test('a ceiling moved under a register that was legal when it was taken is flagged, never unwound', async () => {
    await app.college.register(schoolId, { studentId: collegeStudent.id, termId, classSubjectIds: csIds });
    const clean = await job('college', 'college.term_watch', { onDate: today });
    assert.equal(clean.overCeiling, 0, '4 credits against a ceiling of 4 is not a breach');

    // the registrar shortens the programme: the same register is now over the ceiling
    await app.academic.updateProgram(schoolId, programId, { totalCredits: 4, durationTerms: 2 });
    const r = await job('college', 'college.term_watch', { onDate: today });
    assert.equal(r.overCeiling, 1);
    assert.equal(await app.db.count('course_registrations', { term_id: termId, status: 'registered' }), csIds.length, 'the student who sat the course still sat it');
    const t = await tasks('college.over_ceiling');
    assert.equal(t.length, 1);
    assert.match(String(t[0].description), /has moved since these were registered/);

    const twice = await job('college', 'college.term_watch', { onDate: today });
    assert.equal(twice.overCeiling, 0);
    assert.equal((await tasks('college.over_ceiling')).length, 1);
  });
});
