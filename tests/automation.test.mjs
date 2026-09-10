// The automation console, and the seven rules the prototype promised that the code did not keep.
//
// Every rule here is tested twice: once that it happens, and once that running the same pass again
// does **not** do it a second time. The relay delivers at least once and the scheduler runs a job
// again after a recycled process, so an automation that is not idempotent is an automation that
// double-charges a family, texts a guardian twice a night, or rosters the same teacher into two halls.
//   node --test tests/automation.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-auto2');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'autoc-key'.padEnd(64, 'x'), CRON_KEY: 'cron-autoc', UPLOADS_DIR: 'tests/.tmp-auto2/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-auto2/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

const t0 = Date.now();
const DAY = n => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const money = n => Math.round(Number(n) * 100) / 100;

let app, http, baseUrl, cookie, schoolId, yearId, classId, headId, students = [], staff = [];

describe('automation console and the rules the prototype promised', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Automation High School', institutionType: 'school', locale: 'en', adminName: 'Admin', adminPhone: '01700000111', adminEmail: 'admin@autoc.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    // no weekends, so "is today a holiday" is only ever what the calendar says — the test must not
    // depend on which day of the week it happens to run
    await app.academic.setWeeklyOffs(schoolId, []);
    yearId = String((await app.academic.currentYear(schoolId)).id);
    classId = String((await app.academic.classes(schoolId))[5].id);
    headId = String((await app.fees.heads(schoolId)).find(h => h.code === 'TUITION').id);
    for (let i = 0; i < 4; i++) {
      students.push(await app.people.createStudent(schoolId, { firstName: `Child${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2013-03-03', classId, admissionDate: '2021-01-05', guardians: [{ fullName: `Parent ${i + 1}`, phone: `0177700000${i}`, relation: 'father', isPrimary: true, paysFees: true }] }));
    }
    for (let i = 0; i < 6; i++) staff.push(await app.people.createStaff(schoolId, { firstName: `Teacher${i + 1}`, phone: `0166600000${i}`, staffCategory: 'teaching', joinDate: '2022-01-01' }));
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@autoc.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`automation finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 200)}`); }
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const raw = async (p, body, method = 'POST') => fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const drain = async () => { let guard = 0; while (++guard < 200) { const { ran } = await app.adapters.queue.drain(5); await app.relay.run(); if (!ran) break; } };
  const invoice = (studentId, dueDate, amount) => app.fees.createInvoice(schoolId, { studentId, academicYearId: yearId, issueDate: dueDate, dueDay: Number(dueDate.slice(8, 10)), items: [{ feeHeadId: headId, description: `Tuition ${dueDate}`, amount }] });
  const setDue = (id, due) => app.db.update('invoices', { due_date: due }, { id });
  const openTasks = (entityType, entityId) => app.db.query(`SELECT * FROM tasks WHERE school_id = ? AND entity_type = ? AND entity_id = ? AND status = 'open'`, [schoolId, entityType, entityId]);
  const notifications = key => app.db.query(`SELECT * FROM notifications WHERE school_id = ? AND event_key = ?`, [schoolId, key]);

  // ------------------------------------------------------------------ the reminder ladder's +30 rung
  test('a month overdue raises one call task for the office instead of a sixth message', async () => {
    const inv = await invoice(students[0].id, DAY(-40), 2400);
    await setDue(inv.id, DAY(-31));
    const smsBefore = app.adapters.sms.sent.length;
    const r = await app.fees.runReminders(schoolId);
    await drain();
    assert.equal(r.calls, 1, JSON.stringify(r));
    const tasks = await openTasks('fees.invoice', inv.id);
    assert.equal(tasks.length, 1, 'exactly one call task');
    assert.match(String(tasks[0].title), /Ring/, String(tasks[0].title));
    assert.match(String(tasks[0].title), /2400/);
    assert.equal(String(tasks[0].task_type), 'fees.call_guardian');
    assert.equal(String(tasks[0].assigned_role), 'accountant');
    // and nothing was texted to that family about that invoice at this stage
    assert.equal(app.adapters.sms.sent.length, smsBefore, 'the ladder stopped texting at +30');
    const rows = await app.db.query(`SELECT * FROM fee_reminders WHERE invoice_id = ?`, [inv.id]);
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].stage), 'overdue_30');
    assert.equal(String(rows[0].channel), 'call_task');
  });

  test('…and running the ladder again the same night raises no second call task', async () => {
    const inv = (await app.db.query(`SELECT * FROM invoices WHERE school_id = ? AND student_id = ?`, [schoolId, students[0].id]))[0];
    const r = await app.fees.runReminders(schoolId);
    await drain();
    assert.equal(r.calls, 0, 'the stage has already fired');
    assert.equal((await openTasks('fees.invoice', String(inv.id))).length, 1, 'still one task, not two');
    assert.equal((await app.db.query(`SELECT * FROM fee_reminders WHERE invoice_id = ?`, [inv.id])).length, 1);
  });

  // ------------------------------------------------------------------ a holiday pauses the ladder
  test('a school does not chase money on a holiday: the run holds and says why', async () => {
    const inv = await invoice(students[1].id, DAY(-20), 1500);
    await setDue(inv.id, DAY(-8));
    const holiday = DAY(0);
    await app.academic.addCalendarEvent(schoolId, { academicYearId: yearId, title: 'Eid-ul-Fitr', eventType: 'holiday', startDate: holiday, endDate: holiday });
    await drain();
    const held = await app.fees.runReminders(schoolId, holiday);
    assert.equal(held.skipped, 'holiday', JSON.stringify(held));
    assert.equal(held.sent, 0);
    assert.match(String(held.reason), /holiday/);
    assert.equal((await app.db.query(`SELECT * FROM fee_reminders WHERE invoice_id = ?`, [inv.id])).length, 0, 'nothing was sent');
  });

  test('…and the next working day sends exactly the stage the holiday would have sent', async () => {
    const inv = (await app.db.query(`SELECT * FROM invoices WHERE school_id = ? AND student_id = ?`, [schoolId, students[1].id]))[0];
    // the day after the holiday is not necessarily a working day: run this suite on a Thursday and the
    // next day is the school's weekly off, which is exactly what the ladder is supposed to hold for
    let working = DAY(1);
    for (let n = 1; n <= 8 && await app.academic.isHoliday(schoolId, working); n++) working = DAY(1 + n);
    assert.equal(await app.academic.isHoliday(schoolId, working), false, 'a working day was found after the holiday');
    const r = await app.fees.runReminders(schoolId, working);
    await drain();
    assert.equal(r.skipped, null);
    assert.ok(r.sent >= 1, JSON.stringify(r));
    const rows = await app.db.query(`SELECT * FROM fee_reminders WHERE invoice_id = ?`, [inv.id]);
    assert.equal(rows.length, 1, 'one stage, not the two the holiday skipped');
    assert.equal(String(rows[0].stage), 'overdue_7');
  });

  // ------------------------------------------------------------------ early payment discount
  test('paying before the due date takes the 2% off, once, with its reason on the invoice', async () => {
    const due = DAY(20);
    const inv = await invoice(students[2].id, due, 5000);
    assert.equal(money(inv.total), 5000);
    await app.fees.recordPayment(schoolId, { studentId: students[2].id, amount: 4900, method: 'cash', invoiceIds: [inv.id] });
    await drain();
    const after = await app.fees.invoice(schoolId, inv.id);
    assert.equal(money(after.total), 4900, 'the 2% came off');
    assert.equal(money(after.discount_total), 100);
    assert.equal(money(after.balance), 0, 'and the family owes nothing more');
    const line = after.items.find(i => String(i.source_type) === 'early_payment');
    assert.ok(line, 'the discount is a line on the invoice, not a silent adjustment');
    assert.match(String(line.description), /Early payment/);
    assert.match(String(line.description), new RegExp(due));
    assert.match(String(line.description), /before/);
    // the money moved through the ledger and the journal like every other movement
    const ledger = await app.db.query(`SELECT * FROM student_ledger_entries WHERE student_id = ? AND entry_type = 'adjustment'`, [students[2].id]);
    assert.equal(ledger.length, 1);
    assert.equal(money(ledger[0].credit), 100);
    const j = await app.accounting.entries(schoolId, { sourceType: 'discount' });
    assert.equal(j.length, 1, 'one balanced journal for the discount');
  });

  test('…and a second early payment on the same invoice takes nothing more off', async () => {
    const inv = (await app.db.query(`SELECT * FROM invoices WHERE school_id = ? AND student_id = ?`, [schoolId, students[2].id]))[0];
    const before = money(inv.total);
    await app.fees.recordPayment(schoolId, { studentId: students[2].id, amount: 50, method: 'cash', invoiceIds: [String(inv.id)] });
    await drain();
    const after = await app.fees.invoice(schoolId, String(inv.id));
    assert.equal(money(after.total), before, 'the total did not move again');
    assert.equal(after.items.filter(i => String(i.source_type) === 'early_payment').length, 1);
    assert.equal((await app.accounting.entries(schoolId, { sourceType: 'discount' })).length, 1);
  });

  test('a payment after the due date earns nothing', async () => {
    const inv = await invoice(students[3].id, DAY(-3), 1000);
    await setDue(inv.id, DAY(-3));
    await app.fees.recordPayment(schoolId, { studentId: students[3].id, amount: 1000, method: 'cash', invoiceIds: [inv.id] });
    await drain();
    const after = await app.fees.invoice(schoolId, inv.id);
    assert.equal(money(after.total), 1000);
    assert.equal(after.items.filter(i => String(i.source_type) === 'early_payment').length, 0);
  });

  // ------------------------------------------------------------------ a rule switched on runs in preview
  const RULE_CODE = 'Z1';
  let previewRuleId;
  test('switching a rule on starts a 48-hour preview: it records what it would have done and does none of it', async () => {
    previewRuleId = (await app.db.query(`SELECT id FROM automation_rules WHERE school_id = ? AND code = ?`, [schoolId, RULE_CODE]))[0]?.id;
    if (!previewRuleId) {
      previewRuleId = `01AUTOPREVIEW${Date.now().toString(36).toUpperCase()}`.slice(0, 26).padEnd(26, '0');
      await app.db.insert('automation_rules', {
        id: previewRuleId, school_id: schoolId, code: RULE_CODE, name: 'Ping raises a task', module: 'platform', description: 'test rule',
        trigger_kind: 'event', event_type: 'test.ping', cron_expr: null, conditions: null,
        actions: [{ type: 'task', title: 'Look at the ping', assignedRole: 'admin', priority: 'normal' }],
        is_system: false, is_active: false, priority: 100, cooldown_minutes: null, run_count: 0,
      });
    }
    const r = await api(`/automation/rules/${previewRuleId}/active`, { active: true });
    assert.ok(r.previewUntil, 'turning it on set preview_until');
    assert.ok(String(r.previewUntil) > new Date().toISOString().slice(0, 19).replace('T', ' '));

    const tasksBefore = (await app.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ?`, [schoolId]))[0].n;
    await app.outbox.emitNow({ type: 'test.ping', schoolId, aggregateType: 'platform.test', aggregateId: 'ping-1', payload: { note: 'first' } });
    await drain();
    const runs = await app.db.query(`SELECT * FROM automation_runs WHERE school_id = ? AND rule_id = ?`, [schoolId, previewRuleId]);
    assert.equal(runs.length, 1);
    assert.equal(String(runs[0].status), 'preview');
    assert.equal(Number((await app.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ?`, [schoolId]))[0].n), Number(tasksBefore), 'nothing was actually done');

    // and the console can read what it would have done, in words
    const preview = await api('/automation/preview');
    const mine = preview.find(p => p.code === RULE_CODE);
    assert.ok(mine, JSON.stringify(preview));
    assert.equal(mine.would.length, 1);
    assert.match(mine.would[0].would, /Look at the ping/);
    assert.match(mine.would[0].would, /task/);
  });

  test('…and a rule in preview never acts, however many events reach it', async () => {
    const tasksBefore = Number((await app.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ?`, [schoolId]))[0].n);
    for (const id of ['ping-2', 'ping-3', 'ping-4']) await app.outbox.emitNow({ type: 'test.ping', schoolId, aggregateType: 'platform.test', aggregateId: id, payload: { note: id } });
    await drain();
    const runs = await app.db.query(`SELECT status FROM automation_runs WHERE school_id = ? AND rule_id = ?`, [schoolId, previewRuleId]);
    assert.equal(runs.length, 4);
    assert.ok(runs.every(r => String(r.status) === 'preview'), JSON.stringify(runs));
    assert.equal(Number((await app.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ?`, [schoolId]))[0].n), tasksBefore, 'still nothing done');
    assert.equal(Number((await app.db.query(`SELECT run_count AS n FROM automation_rules WHERE id = ?`, [previewRuleId]))[0].n), 0);
  });

  test('a person ends the preview and the rule goes live', async () => {
    await api(`/automation/rules/${previewRuleId}/go-live`, {});
    const tasksBefore = Number((await app.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ?`, [schoolId]))[0].n);
    await app.outbox.emitNow({ type: 'test.ping', schoolId, aggregateType: 'platform.test', aggregateId: 'ping-live', payload: { note: 'live' } });
    await drain();
    assert.equal(Number((await app.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ?`, [schoolId]))[0].n), tasksBefore + 1, 'now it acts');
    const runs = await app.db.query(`SELECT status FROM automation_runs WHERE school_id = ? AND rule_id = ? AND status = 'success'`, [schoolId, previewRuleId]);
    assert.equal(runs.length, 1);
    // switching it off clears the window, so turning it back on is a fresh 48 hours and not a stale date
    await api(`/automation/rules/${previewRuleId}/active`, { active: false });
    assert.equal((await app.db.findOne('automation_rules', { id: previewRuleId })).preview_until, null);
  });

  // ------------------------------------------------------------------ the invigilator roster
  let examId, scheduleId, roomId, busyTeacherId, examDate;
  test('the invigilator roster puts staff in the rooms the children are sitting in, and tells each of them', async () => {
    // a date that is neither today (the holiday) nor a weekend we removed
    examDate = DAY(14);
    const e = await app.assessment.createExam(schoolId, { academicYearId: yearId, name: 'Half-yearly', startDate: examDate, endDate: examDate, classIds: [classId] });
    examId = e.id;
    assert.ok(e.schedules > 0, 'the exam has papers');
    const schedules = await app.assessment.schedules(schoolId, examId);
    scheduleId = String(schedules[0].id);
    for (const sc of schedules) await app.assessment.setSchedule(schoolId, String(sc.id), { examDate, startTime: '10:00', endTime: '13:00' });
    const plan = await app.assessment.buildSeatPlan(schoolId, examId);
    assert.ok(plan.seated > 0, JSON.stringify(plan));
    roomId = String((await app.assessment.seatPlan(schoolId, examId)).find(p => p.room_id).room_id);

    const r = await api(`/exams/${examId}/invigilators/roster`, {});
    await drain();
    assert.ok(r.assigned > 0, JSON.stringify(r));
    assert.equal(r.gaps.length, 0, JSON.stringify(r.gaps));
    const roster = await api(`/exams/${examId}/invigilators`);
    assert.equal(roster.length, r.assigned);
    assert.ok(roster.every(x => x.staff_id && x.room_id), JSON.stringify(roster[0]));
    // nobody is in two rooms in the same sitting
    const seen = new Set();
    for (const x of roster) { const k = `${x.exam_date}|${x.start_time}|${x.staff_id}`; assert.ok(!seen.has(k), `${x.first_name} is in two halls at once`); seen.add(k); }
    await drain();
    assert.ok((await notifications('assessment.invigilation')).length > 0, 'each invigilator was told');
  });

  test('…and rostering again does not double-book anybody or send the duty twice', async () => {
    const before = (await api(`/exams/${examId}/invigilators`)).length;
    const notifiedBefore = (await notifications('assessment.invigilation')).length;
    const r = await api(`/exams/${examId}/invigilators/roster`, {});
    await drain();
    assert.equal(r.assigned, 0, 'every room already has somebody');
    assert.equal((await api(`/exams/${examId}/invigilators`)).length, before);
    assert.equal((await notifications('assessment.invigilation')).length, notifiedBefore, 'nobody was told twice');
  });

  test('a teacher with a class in that period is refused, by name', async () => {
    // publish a timetable in which one teacher is in front of a class while the paper is being sat
    const sections = await app.academic.sections(schoolId, yearId, classId);
    const periods = await app.academic.periods(schoolId);
    const period = periods.find(p => !Number(p.is_break) && String(p.start_time).slice(0, 5) < '13:00' && String(p.end_time).slice(0, 5) > '10:00') ?? periods[0];
    await app.db.update('periods', { start_time: '10:30:00', end_time: '11:10:00' }, { id: String(period.id) });
    const cs = await app.academic.classSubjects(schoolId, yearId, classId);
    busyTeacherId = staff[0].id;
    const versionId = await app.timetable.createVersion(schoolId, yearId, 'Test grid', DAY(-1));
    const dow = new Date(examDate + 'T00:00:00Z').getUTCDay();
    await app.timetable.setSlot(schoolId, versionId, { sectionId: String(sections[0].id), dayOfWeek: dow, periodId: String(period.id), classSubjectId: String(cs[0].id), teacherId: busyTeacherId });
    await app.timetable.publish(schoolId, versionId);
    await drain();

    const busy = await app.timetable.teachingBetween(schoolId, examDate, '10:00', '13:00');
    assert.ok(busy.has(busyTeacherId), 'the timetable says that teacher is teaching');

    // start the roster again from nothing, so what is refused is refused for the timetable and not
    // because everybody is already standing somewhere
    await app.db.execute(`DELETE FROM exam_invigilators WHERE school_id = ?`, [schoolId]);
    const res = await raw(`/exams/${examId}/invigilators`, { scheduleId, roomId, staffId: busyTeacherId });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'teaching_clash');
    assert.match(String(body.error), /Teacher1/);

    // and a free member of staff is accepted for the same room
    const free = staff[1].id;
    const ok = await api(`/exams/${examId}/invigilators`, { scheduleId, roomId, staffId: free });
    assert.ok(ok.id);
    // the same person, the same room, the same paper: refused rather than duplicated
    const again = await raw(`/exams/${examId}/invigilators`, { scheduleId, roomId, staffId: free });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).code, 'duplicate');
    // and the automatic roster never picks the teacher the timetable has in front of a class
    await app.db.execute(`DELETE FROM exam_invigilators WHERE school_id = ?`, [schoolId]);
    const auto = await api(`/exams/${examId}/invigilators/roster`, {});
    const rostered = await api(`/exams/${examId}/invigilators`);
    assert.ok(auto.assigned > 0);
    assert.equal(rostered.filter(x => String(x.staff_id) === busyTeacherId).length, 0, 'the busy teacher was left out');
  });

  test('a roster with nobody free names the room instead of leaving it blank', async () => {
    const r = await api(`/exams/${examId}/invigilators/roster`, { perRoom: 4, replace: true });
    await drain();
    assert.ok(r.gaps.length > 0, 'six members of staff cannot fill four seats in every room');
    assert.ok(r.gaps[0].room && r.gaps[0].reason, JSON.stringify(r.gaps[0]));
    const tasks = await openTasks('assessment.exam', examId);
    assert.equal(tasks.length, 1, 'one task, naming what is missing');
    assert.match(String(tasks[0].title), /nobody to invigilate/);
    // running it again reuses the open task rather than raising a thirty-first
    await api(`/exams/${examId}/invigilators/roster`, { perRoom: 4 });
    await drain();
    assert.equal((await openTasks('assessment.exam', examId)).length, 1);
  });

  // ------------------------------------------------------------------ a lost ID card
  let cardId;
  test('a reissued ID card revokes the old tag at the gate and invoices the replacement fee', async () => {
    await api('/documents/id-cards', { personType: 'student', validFrom: DAY(-30), validTo: DAY(300), ids: [students[0].id] });
    await drain();
    const cards = await api(`/documents/id-cards?personType=student&personId=${students[0].id}`);
    assert.equal(cards.length, 1, JSON.stringify(cards));
    cardId = String(cards[0].id);
    // the gate reads the tag on the person, so that is what the reissue has to take away
    const tag = 'RFID-LOST-001';
    await app.db.update('id_cards', { rfid_tag: tag }, { id: cardId });
    await app.db.update('students', { rfid_tag: tag }, { id: students[0].id });

    const invoicesBefore = (await app.fees.invoices(schoolId, { studentId: students[0].id })).length;
    const r = await api(`/documents/id-cards/${cardId}/reissue`, { reason: 'reported lost' });
    await drain();
    assert.equal(r.revokedTag, tag);
    assert.ok(r.cardNo && r.cardId !== cardId, 'a new card was issued');

    const old = await app.db.findOne('id_cards', { id: cardId });
    assert.equal(String(old.status), 'lost');
    assert.equal(old.rfid_tag, null, 'the card no longer carries the tag');
    const student = await app.db.findOne('students', { id: students[0].id });
    assert.equal(student.rfid_tag, null, 'and neither does the child — the gate stops opening');

    const invoices = await app.fees.invoices(schoolId, { studentId: students[0].id });
    assert.equal(invoices.length, invoicesBefore + 1, 'the replacement fee was invoiced');
    const fee = invoices.find(i => String(i.notes ?? '').startsWith('id_card:'));
    assert.ok(fee, JSON.stringify(invoices.map(i => i.notes)));
    assert.equal(money(fee.total), 200);
  });

  test('…and reissuing the same card again is refused, so nobody is charged twice', async () => {
    const invoicesBefore = (await app.fees.invoices(schoolId, { studentId: students[0].id })).length;
    const res = await raw(`/documents/id-cards/${cardId}/reissue`, { reason: 'reported lost' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'already_reissued');
    await drain();
    assert.equal((await app.fees.invoices(schoolId, { studentId: students[0].id })).length, invoicesBefore);
  });

  // ------------------------------------------------------------------ vaccination reminders
  test('a vaccination falling due inside a week reminds the family', async () => {
    await api('/welfare/vaccinations', { studentId: students[3].id, vaccine: 'Measles-Rubella', doseNo: 2, givenOn: DAY(-365), nextDueOn: DAY(5) });
    const before = (await notifications('welfare.vaccination_due')).length;
    await app.welfare.jobs()['welfare.behaviour_rules']({ schoolId, jobKey: 'welfare.behaviour_rules', payload: {}, deadline: Date.now() + 20_000 });
    await drain();
    const after = await notifications('welfare.vaccination_due');
    assert.ok(after.length > before, 'the guardian was told');
    assert.match(String(after[after.length - 1].body), /Measles-Rubella/);
  });

  test('…and the nightly pass does not tell them again the next night', async () => {
    const before = (await notifications('welfare.vaccination_due')).length;
    await app.welfare.jobs()['welfare.behaviour_rules']({ schoolId, jobKey: 'welfare.behaviour_rules', payload: {}, deadline: Date.now() + 20_000 });
    await app.welfare.jobs()['welfare.behaviour_rules']({ schoolId, jobKey: 'welfare.behaviour_rules', payload: {}, deadline: Date.now() + 20_000 });
    await drain();
    assert.equal((await notifications('welfare.vaccination_due')).length, before, 'one message per dose, not one a night');
  });

  // ------------------------------------------------------------------ the console itself
  test('the approvals inbox shows what is waiting, what it is worth and who asked', async () => {
    await app.db.insert('approval_workflows', { id: `WF${Date.now().toString(36).toUpperCase()}`.padEnd(26, '0'), school_id: schoolId, entity_type: 'hr.leave', name: 'Leave', conditions: null, steps: [{ role: 'principal' }], auto_approve_after_hours: 0, escalate_after_hours: 48, is_active: true });
    const req = await app.approvals.request({ schoolId, entityType: 'hr.leave', entityId: staff[1].id, summary: { title: 'Three days casual leave — Teacher2', amount: 0 } });
    assert.equal(req.status, 'pending');
    await drain();
    const inbox = await api('/automation/approvals');
    const mine = inbox.find(a => a.entityId === staff[1].id);
    assert.ok(mine, JSON.stringify(inbox));
    assert.equal(mine.what, 'Three days casual leave — Teacher2');
    assert.equal(mine.currentStep, 1);

    // a refusal without a reason is refused: the person who asked has to be told why
    const bad = await raw(`/automation/approvals/${mine.id}/decide`, { decision: 'rejected' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'reason_required');

    const done = await api(`/automation/approvals/${mine.id}/decide`, { decision: 'approved' });
    assert.equal(done.status, 'approved');
    assert.equal((await api('/automation/approvals')).filter(a => a.entityId === staff[1].id).length, 0);
  });

  test('tasks, rules, jobs, activity and integrations all answer', async () => {
    const tasks = await api('/automation/tasks');
    assert.ok(tasks.length > 0, 'the call task and the roster gap are both here');
    assert.ok(tasks.every(t => t.title && t.status), JSON.stringify(tasks[0]));
    const call = tasks.find(t => t.taskType === 'fees.call_guardian');
    assert.ok(call, 'the +30 call task is visible to the office');
    await api(`/automation/tasks/${call.id}/complete`, {});
    assert.equal((await api('/automation/tasks')).filter(t => t.id === call.id).length, 0);

    const rules = await api('/automation/rules');
    assert.ok(rules.length >= 30, `${rules.length} rules seeded`);
    assert.ok(rules.every(r => typeof r.isActive === 'boolean' && Array.isArray(r.actions)), JSON.stringify(rules.find(r => typeof r.isActive !== 'boolean' || !Array.isArray(r.actions))));

    const jobs = await api('/automation/jobs');
    assert.ok(jobs.scheduled.length >= 70, `${jobs.scheduled.length} scheduled jobs`);
    const reminders = jobs.scheduled.find(j => j.jobKey === 'fees.reminders');
    assert.ok(reminders && reminders.cronExpr, JSON.stringify(reminders));
    const ranNow = await api('/automation/jobs/fees.reminders/run', {});
    assert.equal(ranNow.lastStatus, 'success', JSON.stringify(ranNow));
    assert.ok(ranNow.lastRunAt);
    // a job switched off refuses to be run by hand rather than pretending it ran
    await api('/automation/jobs/fees.reminders/active', { active: false });
    const off = await raw('/automation/jobs/fees.reminders/run', {});
    assert.equal(off.status, 409);
    await api('/automation/jobs/fees.reminders/active', { active: true });

    const activity = await api('/automation/runs');
    assert.ok(activity.summary.ran >= 0 && Array.isArray(activity.runs));
    const byRule = await api(`/automation/runs?ruleId=${previewRuleId}`);
    assert.ok(byRule.runs.length >= 5 && byRule.runs.every(r => r.ruleId === previewRuleId));
    const byDay = await api(`/automation/runs?day=${DAY(-400)}`);
    assert.equal(byDay.runs.length, 0, 'a day nothing happened on shows nothing');

    const hooks = await api('/automation/webhooks');
    assert.ok(Array.isArray(hooks.webhooks) && Array.isArray(hooks.deliveries));
  });

  test('the reminder ladder is readable, stage by stage', async () => {
    const r = await api('/fees/reminders');
    assert.equal(r.ladder.length, 6, 'five messages and the call');
    assert.deepEqual(r.ladder.map(s => s.stage), ['due_in_3', 'due_today', 'overdue_3', 'overdue_7', 'overdue_15', 'overdue_30']);
    assert.equal(r.ladder.at(-1).channel, 'call_task');
    assert.ok(r.ladder.at(-1).sent >= 1);
    assert.ok(r.recent.length >= 2);
  });
});
