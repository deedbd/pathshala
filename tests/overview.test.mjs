// The console's front page, as a single answer. A head teacher opens this software to find out five
// things before assembly: whether the registers were marked and whose guardians heard about it, what
// came in against what was billed, who is waiting on a decision, what the machine did by itself, and
// which sections are short. Every one of those numbers was already in the database and nothing
// gathered them.
//
// What is proved here: a school on its first morning reports nothing rather than nought, a marked
// register and a paid invoice come back exactly as they were written, the four "somebody must act"
// blocks each show their own row, the automation feed carries a rule run and a scheduled job run
// newest first, and two calls inside the cache window cost one trip to the database.
//   node --test tests/overview.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-overview');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'overview-key'.padEnd(64, 'x'), CRON_KEY: 'cron-overview', UPLOADS_DIR: 'tests/.tmp-overview/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-overview/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const { ulid } = await import('../packages/db/dist/index.js');

let app, schoolId, yearId, classId, sectionId;
const students = [];
const t0 = Date.now();
const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// every read the services make, counted, so the cache can be proved rather than timed
let dbCalls = 0;

describe('the console overview: one morning, gathered once', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Overview Model School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01788888888', adminEmail: 'admin@overview.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    yearId = String((await app.academic.currentYear(schoolId)).id);
    const classes = await app.academic.classes(schoolId);
    classId = String(classes[5].id);
    sectionId = String((await app.academic.sections(schoolId, yearId, classId))[0].id);
    for (const m of ['query', 'findOne', 'findMany', 'count']) {
      const orig = app.db[m].bind(app.db);
      app.db[m] = (...a) => { dbCalls++; return orig(...a); };
    }
  });
  after(async () => { await app?.stop(); console.log(`overview finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const today = (opts) => app.overview.today(schoolId, opts);

  // ------------------------------------------------------ the first morning ----
  test('a school on its first morning reports nothing, not nought', async () => {
    app.overview.forget();
    const o = await today();
    assert.match(o.on, /^\d{4}-\d{2}-\d{2}$/, 'the school’s own date');
    assert.ok(o.academicYear && o.academicYear.id === yearId, 'the installer set a current year');

    assert.equal(o.attendance.marked, false, 'nobody has opened a register');
    assert.equal(o.attendance.students.pct, null, 'no register, no percentage — never 0%');
    assert.equal(o.attendance.staff.pct, null);
    assert.deepEqual(
      [o.attendance.students.present, o.attendance.students.absent, o.attendance.students.late, o.attendance.students.excused, o.attendance.students.total],
      [0, 0, 0, 0, 0]);
    assert.deepEqual([o.attendance.staff.present, o.attendance.staff.absent, o.attendance.staff.late, o.attendance.staff.total], [0, 0, 0, 0]);
    assert.equal(o.attendance.smsSent, 0);
    // the preset gave the school its classes, so the sections are listed with nothing marked against them
    assert.ok(o.attendance.sections.length > 0, 'the seeded sections are there');
    assert.ok(o.attendance.sections.every(s => s.pct === null && s.present === 0 && s.absent === 0), 'every section unmarked');

    assert.equal(o.fees.invoiced, 0);
    assert.equal(o.fees.collected, 0);
    assert.equal(o.fees.collectedToday, 0);
    assert.equal(o.fees.outstanding, 0);
    assert.equal(o.fees.overdue, 0);
    assert.equal(o.fees.overdueInvoices, 0);
    assert.equal(o.fees.lastBatch, null, 'nothing has been billed, so there is no last batch');
    assert.equal(o.fees.byMonth.length, 9, 'nine months by default');
    assert.equal(o.fees.byMonth.at(-1).month, o.on.slice(0, 7), 'the last bucket is this month');
    assert.ok(o.fees.byMonth.every(m => m.invoiced === 0 && m.collected === 0));

    assert.equal(o.admissions.newApplications, 0);
    assert.equal(o.admissions.newEnquiries, 0);
    assert.equal(o.admissions.campaign, null, 'no campaign is open');
    assert.equal(o.exams.next, null, 'no exam scheduled — not a date invented for the card');
    assert.equal(o.exams.marksPending, 0);
    assert.equal(o.exams.resultsWaiting, 0);
    assert.equal(o.approvals.total, 0);
    assert.equal(o.transport.total, 0);
    assert.equal(o.transport.running, 0);
    assert.ok(Array.isArray(o.trend) && Array.isArray(o.timeline));
  });

  // ---------------------------------------------------------- the register ----
  test('a marked register comes back exactly as it was written, section by section', async () => {
    for (let i = 0; i < 5; i++) {
      students.push(await app.people.createStudent(schoolId, {
        firstName: `Pupil${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2013-04-04', classId, sectionId, admissionDate: '2022-01-05',
        guardians: [{ fullName: `Guardian ${i + 1}`, phone: `0193100000${i}`, relation: 'father', isPrimary: true, paysFees: true }],
      }));
    }
    const on = (await today()).on;
    app.overview.forget();
    // three present, one absent, one late — written through the service that owns the register
    const marks = students.map((s, i) => ({ studentId: String(s.id), status: i === 3 ? 'absent' : i === 4 ? 'late' : 'present' }));
    await app.attendance.markSection(schoolId, sectionId, on, marks, null);
    await app.relay.run();
    await app.adapters.queue.drain(20);

    app.overview.forget();
    const o = await today();
    assert.equal(o.attendance.marked, true);
    assert.equal(o.attendance.students.present, 3);
    assert.equal(o.attendance.students.absent, 1);
    assert.equal(o.attendance.students.late, 1);
    assert.equal(o.attendance.students.total, 5);
    assert.equal(o.attendance.students.pct, 80, 'present or late, out of the marks made');

    const row = o.attendance.sections.find(s => s.sectionId === sectionId);
    assert.ok(row, 'the marked section is in the list');
    assert.equal(row.students, 5, 'the roll, not the marks');
    assert.equal(row.present, 3);
    assert.equal(row.absent, 1);
    assert.equal(row.pct, 80);
    assert.ok(o.attendance.sections.some(s => s.sectionId !== sectionId && s.pct === null), 'the sections nobody marked stay null');
    // the guardian of the absent child was texted, and that is what the number counts
    const sms = Number((await app.db.query(`SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND channel = 'sms' AND event_key = 'attendance.absent' AND status IN ('sent','delivered')`, [schoolId]))[0].n);
    assert.equal(o.attendance.smsSent, sms, 'the messages that actually went, not the ones queued');
  });

  // --------------------------------------------------------------- the money ----
  test('the month’s money adds up to the rows an accountant would count by hand', async () => {
    const batch = await app.fees.generateBatch(schoolId, { academicYearId: yearId });
    await app.adapters.queue.drain(20);
    await app.relay.run();
    const invoices = await app.db.query(`SELECT id, total, balance, due_date FROM invoices WHERE school_id = ? AND status <> 'cancelled'`, [schoolId]);
    assert.ok(invoices.length >= 5, `the batch billed the children (${invoices.length})`);
    const invoicedByHand = invoices.reduce((a, i) => a + Number(i.total), 0);

    const paid = invoices[0];
    await app.fees.recordPayment(schoolId, { studentId: null, amount: Number(paid.total), method: 'cash', invoiceIds: [String(paid.id)] });
    await app.relay.run();
    await app.adapters.queue.drain(20);

    // A bill settled before its due date earns the early-payment discount, so what the till took is
    // not what the invoice said — the figure the dashboard shows is the one the payment rows carry,
    // and the discount is a line on the invoice, not a hole in the takings.
    const tookByHand = Number((await app.db.query(
      `SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE school_id = ? AND status <> 'cancelled'`, [schoolId]))[0].v);
    assert.ok(tookByHand > 0 && tookByHand <= Number(paid.total), `the payment rows say ${tookByHand} against a bill of ${paid.total}`);

    // the discount is a line on the invoice, so the month's billing is read again after it lands
    const invoicedAfterDiscount = Number((await app.db.query(
      `SELECT COALESCE(SUM(total), 0) AS v FROM invoices WHERE school_id = ? AND status <> 'cancelled'`, [schoolId]))[0].v);

    app.overview.forget();
    const o = await today();
    const outstandingByHand = (await app.db.query(`SELECT COALESCE(SUM(balance), 0) AS v FROM invoices WHERE school_id = ? AND balance > 0 AND status <> 'cancelled'`, [schoolId]))[0].v;
    assert.equal(o.fees.month, o.on.slice(0, 7));
    assert.equal(Math.round(o.fees.invoiced), Math.round(invoicedAfterDiscount), 'what the month billed');
    assert.equal(Math.round(o.fees.collected), Math.round(tookByHand), 'what came in this month');
    assert.equal(Math.round(o.fees.collectedToday), Math.round(tookByHand), 'and it came in today');
    assert.equal(Math.round(o.fees.outstanding), Math.round(Number(outstandingByHand)), 'the balances the ledger holds');

    const bucket = o.fees.byMonth.find(m => m.month === o.on.slice(0, 7));
    assert.ok(bucket, 'this month is in the chart');
    assert.equal(Math.round(bucket.invoiced), Math.round(invoicedAfterDiscount));
    assert.equal(Math.round(bucket.collected), Math.round(tookByHand));

    assert.ok(o.fees.lastBatch, 'the batch that billed them is named');
    assert.equal(o.fees.lastBatch.invoices, invoices.length);
    assert.equal(o.fees.lastBatch.automatic, true, 'nobody generated it by hand, so the scheduler did');
    assert.ok(batch.batchId);
  });

  // ------------------------------------------------- who is waiting for a person ----
  test('an approval, a task, an application and a scheduled exam each show in their own block', async () => {
    await app.db.insert('approval_workflows', { id: ulid(), school_id: schoolId, entity_type: 'overview.test', name: 'One admin signs it off', conditions: null, steps: [{ role: 'admin' }], auto_approve_after_hours: null, escalate_after_hours: null, is_active: true });
    const ap = await app.approvals.request({ schoolId, entityType: 'overview.test', entityId: 'THING1', summary: { amount: 4500, reason: 'new benches' } });
    assert.equal(ap.status, 'pending', 'the workflow makes it somebody’s decision');
    await app.tasks.create({ schoolId, title: 'Count the cash drawer', taskType: 'fees.cash', assignedRole: 'accountant', priority: 'urgent' });

    const campaign = await app.admissions.createCampaign(schoolId, { name: 'Overview Admission', opensAt: `${day(-1)} 00:00:00`, closesAt: `${day(20)} 23:59:59`, formFee: 0, selectionMode: 'lottery', requiresTest: false, autoMeritList: false, autoOffer: false, classes: [{ classId, seats: 5 }] });
    await app.admissions.setCampaignStatus(schoolId, campaign.id, 'open');
    await app.admissions.apply(schoolId, campaign.id, { classId, firstName: 'Rumana', gender: 'female', dateOfBirth: '2017-02-02', guardianName: 'Guardian R', guardianPhone: '01931999901' });

    const exam = await app.assessment.createExam(schoolId, { name: 'Half yearly', startDate: day(12), endDate: day(15), classIds: [classId] });
    await app.relay.run();
    await app.adapters.queue.drain(30);

    app.overview.forget();
    const o = await today();
    assert.ok(o.approvals.total >= 1);
    const waiting = o.approvals.items.find(i => i.kind === 'overview.test');
    assert.ok(waiting, JSON.stringify(o.approvals.items));
    assert.equal(waiting.title, 'overview test');
    assert.match(waiting.detail, /amount: 4500/, 'the summary the requester wrote is shown');

    assert.ok(o.tasks.total >= 1);
    const task = o.tasks.items.find(i => i.title === 'Count the cash drawer');
    assert.ok(task, JSON.stringify(o.tasks.items));
    assert.equal(task.priority, 'urgent');
    assert.equal(task.assignee, 'accountant', 'a role stands in when nobody is named');

    assert.equal(o.admissions.newApplications, 1);
    assert.equal(o.admissions.campaign, 'Overview Admission');

    assert.ok(o.exams.next, 'the exam ahead is named');
    assert.equal(o.exams.next.id, exam.id);
    assert.equal(o.exams.next.startDate, day(12));
    assert.equal(o.exams.next.daysAway, 12);
  });

  // ------------------------------------------------ what the machine did itself ----
  test('the automation feed carries a rule run and a scheduled job run, newest first', async () => {
    await app.db.insert('automation_rules', { id: ulid(), school_id: schoolId, code: 'OV1', name: 'Ping → task', module: 'platform', trigger_kind: 'event', event_type: 'test.ping', conditions: null, actions: [{ type: 'task', title: 'Look at the ping', assignedRole: 'admin', dueInHours: 24 }], is_system: false, is_active: true, priority: 10, cooldown_minutes: 0, run_count: 0 });
    await app.outbox.emitNow({ type: 'test.ping', schoolId, aggregateType: 'platform.selftest', aggregateId: 'OV', payload: { note: 'go' } });
    await app.relay.run();
    // and a scheduled job, brought forward so the tick actually has something due to run
    const job = (await app.db.query(`SELECT id FROM scheduled_jobs WHERE school_id = ? AND job_key = 'attendance.refresh_summary'`, [schoolId]))[0];
    assert.ok(job, 'the seeded catalogue gave the school its jobs');
    await app.db.update('scheduled_jobs', { next_run_at: new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' '), is_active: true }, { id: String(job.id) });
    await app.tick({ budgetMs: 5000, maxJobs: 5 });
    const ran = (await app.db.query(`SELECT last_run_at, last_status FROM scheduled_jobs WHERE id = ?`, [String(job.id)]))[0];
    assert.ok(ran.last_run_at, 'the scheduler recorded its own run');

    app.overview.forget();
    const o = await today();
    assert.ok(o.automation.runsToday > 0, 'the morning is counted');
    assert.ok(o.automation.feed.length > 0);
    assert.ok(o.automation.feed.length <= 8, 'eight items, not a log');
    assert.ok(o.automation.feed.some(f => f.kind === 'rule' && f.title === 'OV1'), `a rule run: ${JSON.stringify(o.automation.feed)}`);
    assert.ok(o.automation.feed.some(f => f.kind === 'cron'), `a scheduled job run: ${JSON.stringify(o.automation.feed)}`);
    for (let i = 1; i < o.automation.feed.length; i++) assert.ok(o.automation.feed[i - 1].at >= o.automation.feed[i].at, 'newest first');
    assert.ok(o.timeline.length > 0, 'the day has a shape');
    for (let i = 1; i < o.timeline.length; i++) assert.ok(o.timeline[i - 1].at <= o.timeline[i].at, 'the timeline runs forwards');
    assert.ok(o.timeline.every(t => t.kind === 'done' || t.kind === 'scheduled'));
  });

  // ------------------------------------------------------------- the cache ----
  test('two calls inside the cache window ask the database once', async () => {
    await app.relay.stop();                       // no background loop counting against us
    app.overview.forget();
    const start = dbCalls;
    await today();
    const cost = dbCalls - start;
    assert.ok(cost > 5, `the first call actually does the work (${cost} reads)`);
    assert.ok(cost <= 25, `and does it in a bounded number of set-based reads, not one per section (${cost})`);

    const afterFirst = dbCalls;
    const [a, b] = await Promise.all([today(), today()]);
    assert.equal(dbCalls, afterFirst, 'a second and a third call inside the window ask nothing');
    assert.equal(a, b, 'and share the one answer');

    app.overview.forget(schoolId);
    await today();
    assert.ok(dbCalls > afterFirst, 'after forget() it goes back to the database');
    // a different school's key is its own, and forgetting one does not forget the other
    app.overview.forget('some-other-school');
    const held = dbCalls;
    await today();
    assert.equal(dbCalls, held, 'forgetting another school left this one’s answer alone');
  });
});
