// Operations that run themselves: the watches added across HR, facilities, governance, compliance,
// welfare, transport, hostel, inventory and the front office.
//
// Every automation here is proved twice over. Once that it does the thing — a payroll nobody
// approved is put in front of somebody, an export request fulfils itself, a bus with no driver is
// named before the morning. And once that running it a second time changes nothing: a school that
// is told the same thing every night stops reading any of it, so the second run must leave one task
// and one message where the first did, not two.
//   node --test tests/auto-ops.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-ops');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'ops-key'.padEnd(64, 'x'), CRON_KEY: 'cron-ops', UPLOADS_DIR: 'tests/.tmp-ops/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-ops/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');

const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const monthOf = offset => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + offset); return d.toISOString().slice(0, 7); };
const back = days => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');

let app, schoolId, yearId, adminUserId, teacherUserId, teacher, warden, students = [];

describe('operations that run themselves', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Self Running School', institutionType: 'school', locale: 'en', adminName: 'Admin', adminPhone: '01700000001', adminEmail: 'admin@ops.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    await app.settings.set(schoolId, 'notifications.channels', { push: true, sms: true, email: true, in_app: true });
    await app.db.update('schools', { eiin: '654321' }, { id: schoolId });
    adminUserId = String((await app.db.findOne('users', { school_id: schoolId, email: 'admin@ops.test' })).id);
    yearId = String((await app.academic.currentYear(schoolId)).id);
    const classes = await app.academic.classes(schoolId);
    for (let i = 0; i < 3; i++) {
      students.push(await app.people.createStudent(schoolId, {
        firstName: `Pupil${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2014-02-02', classId: String(classes[2].id), admissionDate: '2022-01-05',
        guardians: [{ fullName: `Guardian ${i + 1}`, phone: `0198800000${i}`, relation: 'father', isPrimary: true }],
      }));
    }
    teacher = await app.people.createStaff(schoolId, { firstName: 'Nusrat', lastName: 'Jahan', phone: '01700100001', staffCategory: 'teaching', joinDate: '2022-01-01', gender: 'female' });
    teacherUserId = teacher.userId ?? null;
    warden = await app.people.createStaff(schoolId, { firstName: 'Rafiq', lastName: 'Uddin', phone: '01700100002', staffCategory: 'support', joinDate: '2022-01-01', gender: 'male' });
  });
  after(async () => { await app?.stop(); });

  const run = (service, key, payload = {}) => app[service].jobs()[key]({ schoolId, jobKey: key, payload, deadline: Date.now() + 20_000 });
  const drain = async () => { let guard = 0; while (++guard < 200) { const { ran } = await app.adapters.queue.drain(5); await app.relay.run(); if (!ran) break; } };
  const notified = async (key, entityId) => Number((await app.db.query(
    `SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND event_key = ?${entityId ? ' AND entity_id = ?' : ''}`, entityId ? [schoolId, key, entityId] : [schoolId, key]))[0].n);
  const openTasks = async type => Number((await app.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ? AND task_type = ? AND status = 'open'`, [schoolId, type]))[0].n);
  const events = async type => Number((await app.db.query(`SELECT COUNT(*) AS n FROM outbox_events WHERE school_id = ? AND event_type = ?`, [schoolId, type]))[0].n);

  // ---------------- HR ----------------
  test('a new joiner has leave to apply for on the day they join, not on the 1st', async () => {
    assert.ok((await app.db.findMany('leave_types', { school_id: schoolId, audience: 'staff' })).length, 'the installer seeded staff leave types');
    const joiner = await app.people.createStaff(schoolId, { firstName: 'Shopna', lastName: 'Begum', phone: '01700100003', staffCategory: 'teaching', joinDate: day(0) });
    await app.hr.onStaffJoined(schoolId, joiner.id, joiner.userId);
    const balances = await app.db.findMany('leave_balances', { school_id: schoolId, staff_id: joiner.id });
    assert.ok(balances.length >= 1, 'the balance is there the moment they join');
    assert.ok(Number(balances[0].allocated) > 0);
    // running it again does not double the allocation
    const before = Number(balances[0].allocated);
    await app.hr.accrueLeave(schoolId, joiner.id);
    assert.equal(Number((await app.db.findOne('leave_balances', { id: String(balances[0].id) })).allocated), before);
  });

  test('a staff document about to expire is chased once, not once a night', async () => {
    const file = await app.files.store({ schoolId, data: Buffer.from('nid'), fileName: 'nid.txt', mimeType: 'text/plain', purpose: 'staff_document' });
    await app.db.insert('staff_documents', { id: `sd-${Date.now()}`, school_id: schoolId, staff_id: teacher.id, doc_type: 'nid', file_id: file.id, expires_at: day(10) });
    const first = await run('hr', 'hr.expiry_alerts');
    assert.equal(first.documents, 1, 'H4 finally looks at staff documents');
    assert.equal(await openTasks('hr.document'), 1);
    const messages = await notified('hr.document_expiring');
    assert.ok(messages >= 1, 'the member of staff hears about their own paper');
    const second = await run('hr', 'hr.expiry_alerts');
    assert.equal(second.documents, 1, 'the paper is still expiring');
    assert.equal(await openTasks('hr.document'), 1, 'but there is still one task');
    assert.equal(await notified('hr.document_expiring'), messages, 'and nobody is told twice');
  });

  test('a payroll nobody approved by pay day is put in front of somebody, with the figures', async () => {
    const month = monthOf(-2);
    await app.hr.setStructure(schoolId, { staffId: teacher.id, effectiveFrom: '2022-01-01', basic: 24_000 });
    const draft = await app.hr.draftRun(schoolId, { periodMonth: `${month}-01` });
    await drain();
    assert.ok(Number((await app.db.findOne('payroll_runs', { id: draft.id })).total_net) > 0, 'the system prepared it completely');
    // this school approves payroll without a workflow, so the run approved itself; put it back into
    // the state the watch exists for — calculated, and waiting for a person
    await app.db.execute(`UPDATE payroll_runs SET status = 'calculated' WHERE id = ?`, [draft.id]);

    const first = await run('hr', 'hr.pending_actions');
    assert.equal(first.awaitingApproval, 1);
    assert.equal(await openTasks('hr.payroll'), 1);
    const task = (await app.db.findMany('tasks', { school_id: schoolId, task_type: 'hr.payroll' }))[0];
    assert.match(String(task.title), new RegExp(month), 'the task names the month it is asking about');
    assert.match(String(task.title), /net/, 'and what approving it will pay out');
    await drain();
    assert.equal(await events('payroll.approval_due'), 1);
    const told = await notified('hr.payroll_awaiting_approval', draft.id);
    assert.ok(told >= 1);

    const second = await run('hr', 'hr.pending_actions');
    assert.equal(second.awaitingApproval, 1, 'still waiting');
    assert.equal(await openTasks('hr.payroll'), 1, 'and still one task');
    assert.equal(await notified('hr.payroll_awaiting_approval', draft.id), told, 'and one message a fortnight, not one a day');

    // approving it is the person's part; once approved the watch says nothing
    await app.db.execute(`UPDATE payroll_runs SET status = 'approved' WHERE id = ?`, [draft.id]);
    assert.equal((await run('hr', 'hr.pending_actions')).awaitingApproval, 0, 'it stays silent when there is nothing to approve');
  });

  test('somebody who has left and was never settled is costed out for a person to confirm', async () => {
    const leaver = await app.people.createStaff(schoolId, { firstName: 'Kamal', lastName: 'Hossain', phone: '01700100004', staffCategory: 'support', joinDate: '2018-01-01' });
    await app.hr.setStructure(schoolId, { staffId: leaver.id, effectiveFrom: '2018-01-01', basic: 15_000 });
    const exitId = await app.hr.initiateExit(schoolId, { staffId: leaver.id, exitType: 'resignation', lastWorkingDay: day(-5) });
    const first = await run('hr', 'hr.pending_actions');
    assert.equal(first.settlements, 1);
    const tasks = await app.db.query(`SELECT * FROM tasks WHERE school_id = ? AND task_type = 'hr.settlement' AND entity_id = ? AND status = 'open'`, [schoolId, exitId]);
    assert.equal(tasks.length, 1);
    assert.match(String(tasks[0].title), /net/, 'the whole figure is worked out before anybody is asked');
    assert.match(String(tasks[0].description), /gratuity/);
    // the preview and the settlement agree, and nothing was posted by the watch
    const preview = await app.hr.settlementPreview(schoolId, exitId);
    assert.equal(preview.alreadySettled, false);
    assert.equal(await app.db.count('journal_entries', { school_id: schoolId, source_type: 'hr.exit' }), 0, 'a watch never posts a journal');

    assert.equal((await run('hr', 'hr.pending_actions')).settlements, 1);
    assert.equal(Number((await app.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ? AND task_type = 'hr.settlement' AND entity_id = ?`, [schoolId, exitId]))[0].n), 1, 'one task, however many nights pass');

    const settled = await app.hr.settleExit(schoolId, exitId);
    assert.equal(Math.round(Number(settled.net)), Math.round(Number(preview.net)), 'the button pays exactly what the task promised');
    assert.equal((await run('hr', 'hr.pending_actions')).settlements, 0, 'and then it stays quiet');
  });

  // ---------------- facilities ----------------
  test('a cleaning round nobody has done becomes one task, and marking it done closes it', async () => {
    const areaId = await app.facilities.setCleaningSchedule(schoolId, { area: 'Science block toilets', frequency: 'daily' });
    const first = await run('facilities', 'facilities.sla_watch');
    assert.equal(first.cleaning, 1, 'cleaningDue existed and nothing called it');
    assert.equal(await openTasks('facilities.cleaning'), 1);
    await run('facilities', 'facilities.sla_watch');
    assert.equal(await openTasks('facilities.cleaning'), 1, 'twice round, still one task');
    await app.facilities.markCleaned(schoolId, areaId);
    assert.equal(await openTasks('facilities.cleaning'), 0, 'the round is done and so is the chase');
    assert.equal((await run('facilities', 'facilities.sla_watch')).cleaning, 0, 'and it is silent until the next round falls due');
  });

  test('a drill that has never been held is one task and one message a fortnight', async () => {
    await run('facilities', 'facilities.sla_watch');
    const drillTasks = await openTasks('facilities.drill');
    assert.ok(drillTasks >= 1, 'a school with no drill on record is told so');
    const messages = await notified('facilities.drill_due');
    await run('facilities', 'facilities.sla_watch');
    assert.equal(await openTasks('facilities.drill'), drillTasks);
    assert.equal(await notified('facilities.drill_due'), messages);
    await app.facilities.recordDrill(schoolId, { kind: 'fire', participants: 300 });
    const open = await app.db.query(`SELECT * FROM tasks WHERE school_id = ? AND entity_type = 'facilities.drill' AND entity_id = 'fire' AND status = 'open'`, [schoolId]);
    assert.equal(open.length, 0, 'holding the drill closes the task for it');
  });

  // ---------------- governance ----------------
  test('a meeting held and never minuted is chased until the minutes exist', async () => {
    const meeting = await app.governance.scheduleMeeting(schoolId, { title: 'Managing committee, October', heldAt: `${day(-5)} 11:00:00` });
    const first = await run('governance', 'governance.resolution_watch');
    assert.equal(first.unminuted, 1);
    assert.equal(await openTasks('governance.minutes'), 1);
    await drain();
    assert.equal(await events('meeting.minutes_overdue'), 1);
    const saidOnce = await notified('governance.minutes_overdue', meeting.id);
    await run('governance', 'governance.resolution_watch');
    assert.equal(await openTasks('governance.minutes'), 1, 'one task, not one a night');
    assert.equal(await notified('governance.minutes_overdue', meeting.id), saidOnce);
    assert.ok(await notified('governance.minutes_overdue', meeting.id) >= 1);
    await app.governance.recordMinutes(schoolId, meeting.id, { minutes: 'The committee agreed the budget.', resolutions: [] });
    assert.equal(await openTasks('governance.minutes'), 0);
    assert.equal((await run('governance', 'governance.resolution_watch')).unminuted, 0, 'silent once the minutes are written');
  });

  test('a policy nobody acknowledged after a fortnight chases the people still missing, by name', async () => {
    const policy = await app.governance.publishPolicy(schoolId, { title: 'Child protection policy', body: 'Read this.', appliesTo: ['teacher'] });
    // it was published today; nothing is chased for it until a fortnight has gone by
    await run('governance', 'governance.resolution_watch');
    const own = async () => Number((await app.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ? AND entity_type = 'governance.policy' AND entity_id = ? AND status = 'open'`, [schoolId, policy.id]))[0].n);
    assert.equal(await own(), 0, 'a policy published this morning is nobody\'s fault yet');
    await app.db.execute(`UPDATE policy_documents SET created_at = ? WHERE id = ?`, [back(20), policy.id]);
    const first = await run('governance', 'governance.resolution_watch');
    assert.ok(first.policiesChased >= 1);
    assert.equal(await own(), 1);
    const task = (await app.db.query(`SELECT * FROM tasks WHERE school_id = ? AND entity_type = 'governance.policy' AND entity_id = ?`, [schoolId, policy.id]))[0];
    assert.match(String(task.description), /Nusrat/, '"82% acknowledged" chases nobody: the names are in the task');
    const chased = await notified('governance.policy_unacknowledged');
    assert.ok(chased >= 1);
    await run('governance', 'governance.resolution_watch');
    assert.equal(await notified('governance.policy_unacknowledged'), chased, 'and once a fortnight, not once a night');
    assert.equal(await own(), 1);
    for (const u of (await app.governance.policyStatus(schoolId, policy.id)).pending) await app.governance.acknowledgePolicy(schoolId, policy.id, u.id);
    assert.equal(await own(), 0, 'the last name comes off the list and the chase closes');
    assert.equal((await app.governance.policyStatus(schoolId, policy.id)).pending.length, 0);
  });

  // ---------------- compliance ----------------
  test('an export of what the school holds is produced by the system; a deletion never is', async () => {
    const exportReq = await app.compliance.requestData(schoolId, adminUserId, 'export');
    const deleteReq = await app.compliance.requestData(schoolId, adminUserId, 'delete');
    await app.db.execute(`UPDATE data_requests SET created_at = ? WHERE id = ?`, [back(40), deleteReq.id]);
    const first = await run('compliance', 'compliance.daily_watch');
    assert.equal(first.exportsFulfilled, 1);
    const done = await app.db.findOne('data_requests', { id: exportReq.id });
    assert.equal(String(done.status), 'done');
    assert.ok(done.file_id, 'the file is there for them to take away');
    // the deletion is escalated on the clock and is not carried out
    assert.equal(first.requestsOverdue, 1);
    assert.equal(String((await app.db.findOne('data_requests', { id: deleteReq.id })).status), 'requested', 'only a person may weigh what the school must keep');
    assert.equal(await openTasks('compliance.data_request'), 1);

    const second = await run('compliance', 'compliance.daily_watch');
    assert.equal(second.exportsFulfilled, 0, 'nothing left to export');
    assert.equal(await openTasks('compliance.data_request'), 1, 'and one task for the deletion, not two');
  });

  test('consent that has run out is asked for again, once', async () => {
    const consent = await app.compliance.recordConsent(schoolId, { userId: adminUserId, consentType: 'photo_use', granted: true, expiresAt: back(3) });
    const first = await run('compliance', 'compliance.daily_watch');
    assert.equal(first.consentsLapsed, 1);
    await drain();
    assert.equal(await events('consent.expired'), 1);
    const asked = await notified('compliance.consent_expired', consent.id);
    assert.ok(asked >= 1);
    await run('compliance', 'compliance.daily_watch');
    assert.equal(await notified('compliance.consent_expired', consent.id), asked, 'asked once, not every morning for a month');
    // renewing it takes them off the list
    await app.compliance.recordConsent(schoolId, { userId: adminUserId, consentType: 'photo_use', granted: true, expiresAt: `${day(365)} 00:00:00` });
    assert.equal((await run('compliance', 'compliance.daily_watch')).consentsLapsed, 0);
  });

  test('the census builds itself in its window and is not built twice', async () => {
    const july = `${new Date().getUTCFullYear()}-07-15`;
    assert.equal((await run('compliance', 'compliance.review', { onDate: `${new Date().getUTCFullYear()}-03-15` })).censusGenerated, false, 'outside the window it does nothing');
    const first = await run('compliance', 'compliance.review', { onDate: july });
    assert.equal(first.censusGenerated, true);
    const report = await app.db.findOne('govt_reports', { school_id: schoolId, report_type: 'banbeis_census', period: july.slice(0, 7) });
    assert.ok(report.file_id, 'built from the register, with the file to send');
    assert.equal(await openTasks('compliance.return'), 1, 'and a person is asked to check it before it goes');
    const second = await run('compliance', 'compliance.review', { onDate: july });
    assert.equal(second.censusGenerated, false, 'a period already generated is left alone');
    assert.equal(await app.db.count('govt_reports', { school_id: schoolId, report_type: 'banbeis_census' }), 1);
  });

  // ---------------- welfare ----------------
  test('an open safeguarding case is reviewed every fortnight, and the reminder says nothing about it', async () => {
    const secret = 'DETAIL-THAT-MUST-NEVER-TRAVEL';
    const caseId = await app.welfare.safeguardingCase(schoolId, { studentId: students[0].id, category: 'neglect', details: secret, riskLevel: 'high' });
    assert.equal((await run('welfare', 'welfare.followups')).caseReviews, 0, 'a case opened this morning is not overdue for review');
    await app.db.execute(`UPDATE safeguarding_cases SET created_at = ? WHERE id = ?`, [back(20), caseId]);
    const first = await run('welfare', 'welfare.followups');
    assert.equal(first.caseReviews, 1);
    const messages = await app.db.query(`SELECT title, body FROM notifications WHERE school_id = ? AND event_key = 'welfare.case_review_due'`, [schoolId]);
    assert.ok(messages.length >= 1, 'somebody is actually told');
    for (const m of messages) {
      assert.ok(!String(m.body).includes(secret), 'the words of the case never leave the case');
      assert.ok(!String(m.body).toLowerCase().includes('neglect'), 'and neither does its category');
    }
    await drain();
    const payload = (await app.db.query(`SELECT payload FROM outbox_events WHERE school_id = ? AND event_type = 'safeguarding.review_due'`, [schoolId]))[0];
    assert.ok(!JSON.stringify(payload.payload).includes(secret), 'a payload is what a webhook sees');
    assert.equal((await run('welfare', 'welfare.followups')).caseReviews, 0, 'and it waits a fortnight before asking again');
    assert.equal(await openTasks('welfare.safeguarding'), 1);
  });

  test('a vaccination falling due is one message per dose, not one for each of seven nights', async () => {
    await app.welfare.recordVaccination(schoolId, { studentId: students[1].id, vaccine: 'MR', doseNo: 2, nextDueOn: day(3) });
    const first = await run('welfare', 'welfare.behaviour_rules');
    assert.equal(first.vaccinationReminders, 1);
    const sent = await notified('welfare.vaccination_due');
    assert.ok(sent >= 1);
    const second = await run('welfare', 'welfare.behaviour_rules');
    assert.equal(second.vaccinationReminders, 0, 'the window is a week wide; the family is texted once');
    assert.equal(await notified('welfare.vaccination_due'), sent);
  });

  test('a support plan past its review date and a policy about to lapse each become one task', async () => {
    await app.welfare.savePlan(schoolId, { studentId: students[2].id, diagnosis: 'dyslexia', reviewDate: day(-3), coordinatorId: teacher.id });
    await app.db.insert('insurance_policies', { id: `ins-${Date.now()}`, school_id: schoolId, person_type: 'staff', staff_id: teacher.id, provider: 'Green Delta', policy_no: 'GD-1', valid_from: day(-300), valid_to: day(12) });
    const first = await run('welfare', 'welfare.followups');
    assert.equal(first.planReviews, 1);
    assert.equal(first.insurance, 1);
    assert.equal(await openTasks('welfare.plan_review'), 1);
    assert.equal(await openTasks('welfare.insurance'), 1);
    await run('welfare', 'welfare.followups');
    assert.equal(await openTasks('welfare.plan_review'), 1);
    assert.equal(await openTasks('welfare.insurance'), 1);
  });

  // ---------------- transport ----------------
  test('a route that cannot run tomorrow is named tonight, and nobody is reassigned by the system', async () => {
    const vehicleId = await app.transport.addVehicle(schoolId, { registrationNo: 'DHAKA-METRO-GA-11-1111', capacity: 40, insuranceExpiry: day(-2) });
    const routeId = await app.transport.createRoute(schoolId, { name: 'Mirpur route', vehicleId, monthlyFee: 1200, stops: [{ name: 'Mirpur 10', pickupTime: '07:00:00', dropTime: '14:00:00' }] });
    const stopId = String((await app.transport.stops(schoolId, routeId))[0].id);
    await app.transport.assignStudent(schoolId, { studentId: students[0].id, academicYearId: yearId, routeId, stopId });

    const first = await run('transport', 'transport.readiness', { forDate: day(1) });
    assert.equal(first.problems, 1);
    assert.deepEqual(first.routes, ['Mirpur route'], 'it names the route rather than counting them');
    assert.equal(await openTasks('transport.readiness'), 1);
    await drain();
    assert.equal(await events('vehicle.unfit'), 1);
    const messages = await notified('transport.not_ready');
    const second = await run('transport', 'transport.readiness', { forDate: day(1) });
    assert.equal(second.problems, 1, 'the bus is still unfit');
    assert.equal(await notified('transport.not_ready'), messages, 'but the manager is told once for that date');
    assert.equal(await openTasks('transport.readiness'), 1);
    assert.equal(String((await app.db.findOne('vehicles', { id: vehicleId })).driver_id ?? ''), '', 'no driver has been assigned by a machine');

    // papers renewed and a driver named: nothing to say
    await app.db.update('vehicles', { driver_id: warden.id, insurance_expiry: day(200) }, { id: vehicleId });
    assert.equal((await run('transport', 'transport.readiness', { forDate: day(1) })).problems, 0);
  });

  test('a vehicle paper that has already expired is called expired, and is one task', async () => {
    await app.db.update('vehicles', { fitness_expiry: day(-9) }, { school_id: schoolId });
    const first = await run('transport', 'transport.document_expiry');
    assert.ok(first.expired >= 1, 'a date already passed used to drop out of the 30-day window');
    const tasks = await app.db.query(`SELECT * FROM tasks WHERE school_id = ? AND task_type = 'transport.compliance' AND status = 'open'`, [schoolId]);
    assert.ok(tasks.some(t => /fitness certificate expired/.test(String(t.title))));
    const count = tasks.length;
    const second = await run('transport', 'transport.document_expiry');
    assert.equal(second.tasks, 0, 'nothing new to raise');
    assert.equal(Number((await app.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ? AND task_type = 'transport.compliance' AND status = 'open'`, [schoolId]))[0].n), count);
  });

  // ---------------- hostel ----------------
  test('a night roll call nobody took is the alert K4 could never raise', async () => {
    const hostelId = await app.hostel.createHostel(schoolId, { name: 'Boys hostel', hostelType: 'boys', wardenId: warden.id, rooms: [{ roomNo: '101', capacity: 2, monthlyFee: 2500 }] });
    const bed = (await app.hostel.vacantBeds(schoolId, hostelId))[0];
    await app.hostel.allocate(schoolId, { studentId: students[0].id, bedId: String(bed.id), academicYearId: yearId });
    const onDate = day(0);
    const first = await run('hostel', 'hostel.night_watch', { onDate });
    assert.equal(first.rollCallMissing, 1);
    assert.equal(await openTasks('hostel.rollcall'), 1);
    await drain();
    assert.equal(await events('hostel.rollcall_missing'), 1);
    const second = await run('hostel', 'hostel.night_watch', { onDate });
    assert.equal(second.rollCallMissing, 1, 'it is still not taken');
    assert.equal(await openTasks('hostel.rollcall'), 1, 'but the warden is not woken twice');
    assert.equal(await notified('hostel.rollcall_missing', hostelId), await notified('hostel.rollcall_missing'), 'the notice is filed against the hostel; the night it is about is the window');

    await app.hostel.rollCall(schoolId, hostelId, onDate, 'night', [{ studentId: students[0].id, status: 'present' }]);
    assert.equal(await openTasks('hostel.rollcall'), 0, 'taking the call closes the chase');
    assert.equal((await run('hostel', 'hostel.night_watch', { onDate })).rollCallMissing, 0);
  });

  // ---------------- inventory ----------------
  test('an item under its reorder level is found whether or not anything moved', async () => {
    await app.inventory.ensureSetup(schoolId);
    const category = String((await app.inventory.categories(schoolId))[0].id);
    // nothing has ever moved this item, so checkReorder has never seen it
    const chalk = await app.inventory.addItem(schoolId, { categoryId: category, name: 'Chalk box', reorderLevel: 20, reorderQty: 100 });
    const first = await run('inventory', 'inventory.reorder_sweep');
    assert.equal(first.low, 1);
    assert.equal(first.flagged, 1, 'no preferred vendor, so a person picks one');
    assert.equal(await openTasks('inventory.reorder'), 1);
    const second = await run('inventory', 'inventory.reorder_sweep');
    assert.equal(second.flagged, 0, 'the task is already open');
    assert.equal(await openTasks('inventory.reorder'), 1);

    // with a vendor on the item the order drafts itself — and waits for approval
    const vendorId = `ven-${Date.now()}`;
    await app.db.insert('vendors', { id: vendorId, school_id: schoolId, name: 'Dhaka Stationers', status: 'active' });
    await app.db.update('inventory_items', { preferred_vendor_id: vendorId }, { id: chalk.id });
    await app.db.execute(`UPDATE tasks SET status = 'done' WHERE school_id = ? AND task_type = 'inventory.reorder'`, [schoolId]);
    const third = await run('inventory', 'inventory.reorder_sweep');
    assert.equal(third.drafted, 1);
    const po = (await app.db.query(`SELECT * FROM purchase_orders WHERE school_id = ? AND is_auto = TRUE`, [schoolId]))[0];
    assert.ok(po, 'a draft order');
    assert.notEqual(String(po.status), 'received', 'spending money still waits for a person');
    const fourth = await run('inventory', 'inventory.reorder_sweep');
    assert.equal(fourth.drafted, 0, 'an order is already open for it');
    assert.equal(Number((await app.db.query(`SELECT COUNT(*) AS n FROM purchase_orders WHERE school_id = ? AND is_auto = TRUE`, [schoolId]))[0].n), 1);
  });

  test('an asset overdue for service is called overdue and is one task', async () => {
    const assetId = await app.inventory.createAsset(schoolId, { name: 'Generator', purchaseCost: 250_000 });
    await app.inventory.serviceAsset(schoolId, { assetId, serviceType: 'preventive', nextDueDate: day(-6) });
    const first = await run('inventory', 'inventory.maintenance_due');
    assert.equal(first.overdue, 1);
    assert.equal(await openTasks('inventory.maintenance'), 1);
    const second = await run('inventory', 'inventory.maintenance_due');
    assert.equal(second.tasks, 0);
    assert.equal(await openTasks('inventory.maintenance'), 1);
  });

  // ---------------- front office ----------------
  test('the building says who it still thinks is inside, and invents no out time for them', async () => {
    const pass = await app.frontOffice.gatePass(schoolId, { personType: 'staff', staffId: teacher.id, reason: 'Bank work', outAt: back(1), expectedIn: back(0.2) });
    const visitor = await app.frontOffice.checkIn(schoolId, { visitorName: 'Rahim Uddin', phone: '01799999999', purpose: 'meeting' });
    const onDate = day(0);
    const first = await run('frontOffice', 'frontoffice.gate_watch', { onDate });
    assert.equal(first.outstandingPasses, 1);
    assert.equal(first.openBadges, 1);
    assert.equal(await openTasks('frontoffice.gate_pass'), 1);
    assert.equal(await openTasks('frontoffice.visitor_book'), 1);
    await drain();
    assert.equal(await events('gate_pass.outstanding'), 1);
    const openedOnce = await notified('frontoffice.visitors_open', onDate);
    assert.ok(openedOnce >= 1);
    assert.equal((await app.db.findOne('visitor_logs', { id: visitor.id })).out_at ?? null, null, 'the book is not filled in by a machine');
    assert.equal((await app.db.findOne('gate_passes', { id: pass.id })).actual_in ?? null, null);

    const second = await run('frontOffice', 'frontoffice.gate_watch', { onDate });
    assert.equal(second.outstandingPasses, 1);
    assert.equal(await openTasks('frontoffice.gate_pass'), 1, 'one task per open pass');
    assert.equal(await notified('frontoffice.visitors_open', onDate), openedOnce, 'and one message for the day');

    await app.frontOffice.returnFromPass(schoolId, pass.id);
    await app.frontOffice.checkOut(schoolId, visitor.id);
    assert.equal(await openTasks('frontoffice.gate_pass'), 0, 'signing back in closes the chase');
    const third = await run('frontOffice', 'frontoffice.gate_watch', { onDate });
    assert.equal(third.outstandingPasses, 0);
    assert.equal(third.openBadges, 0, 'and the watch is silent when the book is straight');
  });
});
