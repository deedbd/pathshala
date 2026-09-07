// Year 2, second batch: the building, the committee, and what the government asks for.
// Room bookings the timetable wins, work orders with a deadline set by their priority, cleaning,
// meters that only count up, drills; minutes whose resolutions are chased, policies with names
// against them, a secret ballot; the census built from the register, stipends, consent, and a
// retention review that reports and never deletes.
//   node --test tests/year2b.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-y2b');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'y2b-key'.padEnd(64, 'x'), CRON_KEY: 'cron-y2b', UPLOADS_DIR: 'tests/.tmp-y2b/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-y2b/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, schoolId, yearId, classId, http, baseUrl, cookie, teacherCookie, teacherUserId, roomId, committeeId, meetingId, programId;
const students = [];
const t0 = Date.now();
const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const yesterday = day(-1), nextWeek = day(7);

describe('year 2: facilities, governance, compliance', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Governed School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01777777777', adminEmail: 'admin@y2b.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    await app.settings.set(schoolId, 'notifications.channels', { push: true, sms: true, email: true, in_app: true });
    await app.db.update('schools', { eiin: '123456' }, { id: schoolId });
    yearId = String((await app.academic.currentYear(schoolId)).id);
    const classes = await app.academic.classes(schoolId);
    classId = String(classes[2].id);
    for (let i = 0; i < 5; i++) students.push(await app.people.createStudent(schoolId, { firstName: `Child${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2015-03-03', classId: i < 3 ? classId : String(classes[3].id), admissionDate: '2021-01-05', guardians: [{ fullName: `Guardian ${i + 1}`, phone: `0195100000${i}`, relation: 'father', isPrimary: true }] }));
    const teacher = await app.people.createStaff(schoolId, { firstName: 'Shahin', lastName: 'Akter', phone: '01911330001', staffCategory: 'teaching', joinDate: '2022-01-01', gender: 'female' });
    teacherUserId = teacher.userId ?? await app.auth.createUser({ schoolId, userType: 'staff', displayName: 'Shahin Akter', username: 'shahin', roles: ['teacher'] });
    if (!teacher.userId) await app.db.update('staff', { user_id: teacherUserId }, { id: teacher.id });
    await app.people.createStaff(schoolId, { firstName: 'Karim', lastName: 'Mia', phone: '01911330002', staffCategory: 'support', joinDate: '2022-01-01', gender: 'male' });
    roomId = String((await app.db.findMany('rooms', { school_id: schoolId }, { limit: 1 }))[0].id);
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@y2b.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
    teacherCookie = `ps_session=${(await app.auth.createSession(await app.db.findOne('users', { id: teacherUserId }))).token}`;
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`year 2b finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 160)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const notified = async key => Number((await app.db.query(`SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND event_key = ?`, [schoolId, key]))[0].n);

  // ---------------- facilities ----------------
  test('a room is booked once, and the timetable keeps the room it was given', async () => {
    const first = await api('/facilities/bookings', { roomId, purpose: 'Parents meeting', startsAt: '2026-11-05 15:00:00', endsAt: '2026-11-05 17:00:00', autoApprove: true });
    assert.equal(first.status, 'approved');
    await assert.rejects(() => api('/facilities/bookings', { roomId, purpose: 'Science club', startsAt: '2026-11-05 16:00:00', endsAt: '2026-11-05 18:00:00' }), /already booked for Parents meeting/);
    // the edges do not overlap, so this one is fine
    const after = await api('/facilities/bookings', { roomId, purpose: 'Science club', startsAt: '2026-11-05 17:00:00', endsAt: '2026-11-05 18:00:00' });
    assert.equal(after.status, 'pending', 'a booking waits for the office unless it is told not to');
    await api(`/facilities/bookings/${after.id}/decide`, { status: 'approved' });
    assert.ok(await notified('facilities.booking_decided') >= 1, 'whoever asked is told either way');
    await assert.rejects(() => api('/facilities/bookings', { roomId, purpose: 'Backwards', startsAt: '2026-11-05 18:00:00', endsAt: '2026-11-05 17:00:00' }), /ends before it starts/);
    const list = await api('/facilities/bookings?from=2026-11-01');
    assert.equal(list.length, 2);
  });

  test('a work order gets its deadline from its priority, and the reporter hears when it is done', async () => {
    const urgent = await api('/facilities/work-orders', { title: 'Water pipe burst in the science block', category: 'plumbing', priority: 'urgent', roomId });
    const normal = await api('/facilities/work-orders', { title: 'Squeaking door', category: 'furniture' });
    const hours = (w) => Math.round((Date.parse(`${w.dueAt.replace(' ', 'T')}Z`) - Date.now()) / 3600_000);
    assert.equal(hours(urgent), 4, 'four hours for an urgent job');
    assert.equal(hours(normal), 72);
    // raising one also puts it on somebody's task list
    assert.ok((await app.db.findMany('tasks', { school_id: schoolId, entity_type: 'facilities.work_order' })).length >= 2);

    const support = (await app.people.staff(schoolId, { q: 'Karim' }))[0];
    await api(`/facilities/work-orders/${urgent.id}/assign`, { staffId: String(support.id) });
    assert.equal(String((await app.db.findOne('work_orders', { id: urgent.id })).status), 'assigned');
    const done = await api(`/facilities/work-orders/${urgent.id}/complete`, { cost: 3500, note: 'new section of pipe' });
    assert.ok(done.expenseId, 'a job that cost money is an expense in the same books as everything else');
    const expense = await app.db.findOne('expenses', { id: done.expenseId });
    assert.equal(Math.round(Number(expense.amount)), 3500);
    assert.ok(await notified('facilities.work_done') >= 1);
    // completing it again changes nothing
    assert.equal((await api(`/facilities/work-orders/${urgent.id}/complete`, {})).alreadyDone, true);

    // the daily watch chases what is late
    await app.db.execute(`UPDATE work_orders SET due_at = ? WHERE id = ?`, ['2020-01-01 09:00:00', normal.id]);
    const watch = await app.facilities.jobs()['facilities.sla_watch']({ schoolId, jobKey: 'facilities.sla_watch', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(watch.overdue, 1);
    assert.ok(await notified('facilities.work_overdue') >= 1);
    assert.ok(watch.drills >= 1, 'a school with no drill on record is told so');
  });

  test('a meter counts up, and cleaning that is overdue says how late it is', async () => {
    const first = await api('/facilities/utilities', { utility: 'electricity', reading: 12_000, readAt: '2026-09-01' });
    assert.equal(first.used, null, 'nothing to compare the first reading with');
    const second = await api('/facilities/utilities', { utility: 'electricity', reading: 12_450, readAt: '2026-10-01', cost: 5400 });
    assert.equal(second.used, 450);
    assert.ok(second.expenseId, 'the bill is booked where the accountant will find it');
    await assert.rejects(() => api('/facilities/utilities', { utility: 'electricity', reading: 900, readAt: '2026-11-01' }), /a lower one needs the meter-replaced flag/);
    const replaced = await api('/facilities/utilities', { utility: 'electricity', reading: 900, readAt: '2026-11-01', allowReset: true });
    assert.equal(replaced.used, null, 'a replaced meter starts again rather than reporting a negative month');
    const history = await api('/facilities/utilities?utility=electricity');
    assert.equal(history.length, 3);

    const cleaning = await api('/facilities/cleaning', { area: 'Toilets, ground floor', frequency: 'daily', checklist: ['floors', 'basins', 'bins'] });
    await api(`/facilities/cleaning/${cleaning.id}/done`, {});
    assert.equal((await api('/facilities/cleaning')).due.length, 0, 'just done, so not due');
    await app.db.execute(`UPDATE cleaning_schedules SET last_done_at = ? WHERE id = ?`, ['2020-01-01 08:00:00', cleaning.id]);
    const due = (await api('/facilities/cleaning')).due;
    assert.equal(due.length, 1);
    assert.ok(due[0].hoursLate > 24, `${due[0].hoursLate} hours late`);
  });

  test('drills are tracked by kind, and the overdue ones say when the last one was', async () => {
    await api('/facilities/drills', { kind: 'fire', heldOn: '2026-08-15', participants: 320, findings: 'Ground floor took four minutes to clear.' });
    const status = await api('/facilities/drills');
    const fire = status.drills.find(d => d.kind === 'fire');
    assert.equal(fire.lastOn, '2026-08-15');
    assert.equal(fire.overdue, false);
    assert.ok(status.drills.filter(d => d.overdue).length >= 3, 'the ones never held are overdue');
  });

  // ---------------- governance ----------------
  test('minutes turn resolutions into tasks with owners, and the overdue ones are chased', async () => {
    committeeId = (await api('/governance/committees', { name: 'Managing committee', kind: 'managing' })).id;
    await api(`/governance/committees/${committeeId}/members`, { personName: 'Shahin Akter', role: 'Teacher representative', userId: teacherUserId, termStart: '2026-01-01', termEnd: '2028-12-31' });
    await api(`/governance/committees/${committeeId}/members`, { personName: 'Nasima Begum', role: 'Guardian representative', termStart: '2024-01-01', termEnd: '2025-12-31' });
    assert.equal(Number((await api('/governance/committees')).committees[0].members), 2);

    const meeting = await api('/governance/meetings', { committeeId, title: 'Third quarter meeting', heldAt: '2026-10-20 11:00:00', venue: 'Head teacher’s office', agenda: [{ title: 'Fee revision' }, { title: 'Roof repair' }] });
    meetingId = meeting.id;
    assert.equal(meeting.agenda, 2);
    assert.ok(await notified('governance.meeting_called') >= 1, 'members with an account are told');

    const minuted = await api(`/governance/meetings/${meetingId}/minutes`, {
      minutes: 'Fees held at last year’s rate. The roof is to be repaired before the monsoon.',
      attendees: ['Shahin Akter', 'Nasima Begum'],
      resolutions: [
        { text: 'Obtain three quotations for the roof', ownerId: teacherUserId, dueDate: yesterday },
        { text: 'Publish the fee decision to guardians', dueDate: nextWeek },
      ],
    });
    assert.equal(minuted.resolutions, 2);
    assert.equal(String((await app.db.findOne('meetings', { id: meetingId })).status), 'held');
    const tasks = await app.db.findMany('tasks', { school_id: schoolId, entity_type: 'governance.resolution' });
    assert.equal(tasks.length, 2, 'a decision nobody is chasing is a decision that will not happen');

    const overdue = await api('/governance/meetings');
    assert.equal(overdue.resolutions.length, 2);
    const watch = await app.governance.jobs()['governance.resolution_watch']({ schoolId, jobKey: 'governance.resolution_watch', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(watch.overdue, 1, 'one date has passed, the other has not');
    assert.ok(await notified('governance.resolution_overdue') >= 1);
    // a term that has run out ends itself
    assert.equal(Number((await api('/governance/committees')).committees[0].members), 1);

    const late = (await api('/governance/meetings')).resolutions.find(r => String(r.due_date).slice(0, 10) === yesterday);
    const closed = await api(`/governance/resolutions/${String(late.id)}/close`, { status: 'done' });
    assert.equal(closed.status, 'done');
    assert.equal((await api('/governance/meetings?status=open')).resolutions.length, 1);
  });

  test('a policy names who has not read it, and a new version does not rewrite what was acknowledged', async () => {
    const v1 = await api('/governance/policies', { title: 'Child protection policy', category: 'safeguarding', body: 'Every allegation is recorded and referred the same day.', appliesTo: ['teacher'] });
    assert.equal(v1.version, 1);
    assert.ok(await notified('governance.policy_published') >= 1);
    const before = await api(`/governance/policies?id=${v1.id}`);
    assert.equal(before.expected, 1, 'one teacher account');
    assert.equal(before.acknowledged, 0);
    assert.equal(before.pending[0].name, 'Shahin Akter');

    await api(`/governance/policies/${v1.id}/acknowledge`, {}, 'POST', { cookie: teacherCookie });
    const after = await api(`/governance/policies?id=${v1.id}`);
    assert.equal(after.acknowledged, 1);
    assert.equal(after.pending.length, 0);
    assert.equal((await api(`/governance/policies/${v1.id}/acknowledge`, {}, 'POST', { cookie: teacherCookie })).alreadyAcknowledged, true);

    const v2 = await api('/governance/policies', { title: 'Child protection policy', body: 'Every allegation is recorded, referred the same day, and reviewed after a week.', appliesTo: ['teacher'] });
    assert.equal(v2.version, 2);
    assert.equal(String((await app.db.findOne('policy_documents', { id: v1.id })).status), 'retired');
    assert.equal((await api(`/governance/policies?id=${v2.id}`)).acknowledged, 0, 'the new version has to be read again');
    assert.equal((await api(`/governance/policies?id=${v1.id}`)).acknowledged, 1, 'and what was acknowledged before still stands');
  });

  test('the ballot is secret, one vote each, and the count closes itself', async () => {
    const election = await api('/governance/elections', {
      title: 'Student council 2027', opensAt: '2026-01-01 08:00:00', closesAt: '2099-12-31 16:00:00',
      candidates: [{ id: 'a', name: 'Rafi', post: 'President' }, { id: 'b', name: 'Sumaiya', post: 'President' }],
    });
    await assert.rejects(() => api(`/governance/elections/${election.id}/vote`, { candidateId: 'a' }, 'POST', { cookie: teacherCookie }), /draft/);
    await api(`/governance/elections/${election.id}/status`, { status: 'open' });
    await api(`/governance/elections/${election.id}/vote`, { candidateId: 'a' }, 'POST', { cookie: teacherCookie });
    await assert.rejects(() => api(`/governance/elections/${election.id}/vote`, { candidateId: 'b' }, 'POST', { cookie: teacherCookie }), /already voted/);
    await api(`/governance/elections/${election.id}/vote`, { candidateId: 'b' });
    await assert.rejects(() => api(`/governance/elections/${election.id}/vote`, { candidateId: 'z' }, 'POST', { cookie: teacherCookie }), /no such candidate/);

    const votes = await app.db.findMany('election_votes', { election_id: election.id });
    assert.equal(votes.length, 2);
    assert.ok(votes.every(v => String(v.voter_hash).length === 64 && String(v.voter_hash) !== teacherUserId), 'the ballot carries a hash, not a name');
    const result = await api(`/governance/elections/${election.id}/status`, { status: 'closed' });
    assert.equal(result.status, 'closed');
    assert.equal(result.tie, true, 'one each');
    assert.deepEqual(result.results.map(r => r.votes), [1, 1]);
    await assert.rejects(() => api(`/governance/elections/${election.id}/vote`, { candidateId: 'a' }), /closed/);
  });

  // ---------------- compliance ----------------
  test('the census counts the register rather than asking somebody to remember', async () => {
    const census = await api('/compliance/reports/census', {});
    assert.equal(census.data.students.total, students.length);
    assert.equal(census.data.students.boys + census.data.students.girls, students.length);
    assert.equal(census.data.students.byClass.length, 2, 'two classes have children in them');
    assert.equal(census.data.staff.total, 2);
    assert.equal(census.data.school.eiin, '123456');
    assert.ok(census.data.facilities.rooms >= 1);
    assert.ok(census.fileId, 'and it comes out as a file the office can send');
    // regenerating replaces the same period rather than piling up
    const again = await api('/compliance/reports/census', {});
    assert.equal(again.id, census.id);
    assert.equal((await api('/compliance/reports?type=banbeis_census')).length, 1);
    // once it has been submitted it is frozen
    await api(`/compliance/reports/${census.id}/submitted`, {});
    await assert.rejects(() => api('/compliance/reports/census', {}), /already been submitted/);
  });

  test('a stipend list is built from who is actually enrolled, and arrears are visible', async () => {
    programId = (await api('/compliance/stipends/programs', { name: 'Primary Education Stipend', authority: 'DPE', amount: 300, frequency: 'quarterly' })).id;
    for (const s of students.slice(0, 3)) await api('/compliance/stipends/enrol', { programId, studentId: s.id, bankOrMfs: { kind: 'bkash', number: `0171000000${students.indexOf(s)}` } });
    await assert.rejects(() => api('/compliance/stipends/enrol', { programId, studentId: students[0].id }), /already on that programme/);
    const list = await api('/compliance/reports/stipend', { programId, period: '2026-Q3' });
    assert.equal(list.data.students, 3);
    assert.equal(list.data.total, 900);

    const enrolment = (await api(`/compliance/stipends?programId=${programId}`)).enrolments[0];
    const paid = await api(`/compliance/stipends/${String(enrolment.id)}/disbursement`, { period: '2026-Q3', amount: 300, reference: 'DPE/2026/Q3' });
    assert.equal(paid.periods, 1);
    assert.equal(paid.total, 300);
    await assert.rejects(() => api(`/compliance/stipends/${String(enrolment.id)}/disbursement`, { period: '2026-Q3', amount: 300 }), /already recorded/);
  });

  test('consent is the latest answer, and withdrawing it is a new row rather than an edit', async () => {
    const guardian = (await app.db.query(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ?`, [students[0].id]))[0];
    const userId = guardian.user_id ?? await app.people.ensureGuardianAccount(schoolId, String(guardian.id));
    const guardianCookie = `ps_session=${(await app.auth.createSession(await app.db.findOne('users', { id: userId }))).token}`;

    assert.equal((await app.compliance.hasConsent(schoolId, userId, 'photo_use')).granted, false);
    await api('/portal/consents', { consentType: 'photo_use', granted: true, studentId: students[0].id }, 'POST', { cookie: guardianCookie });
    assert.equal((await app.compliance.hasConsent(schoolId, userId, 'photo_use', students[0].id)).granted, true);
    await api('/portal/consents', { consentType: 'photo_use', granted: false, studentId: students[0].id }, 'POST', { cookie: guardianCookie });
    const now = await app.compliance.hasConsent(schoolId, userId, 'photo_use', students[0].id);
    assert.equal(now.granted, false);
    assert.equal(now.reason, 'withdrawn');
    assert.equal((await api(`/compliance/consents?userId=${userId}`)).length, 2, 'both answers are kept: the school must be able to show what it was allowed to do at the time');
    // one that has run out is not consent either
    await app.compliance.recordConsent(schoolId, { userId, consentType: 'trip', granted: true, expiresAt: '2020-01-01 00:00:00' });
    assert.equal((await app.compliance.hasConsent(schoolId, userId, 'trip')).reason, 'expired');

    // and a guardian can ask for what is held about them
    const request = await api('/portal/data-requests', { kind: 'export' }, 'POST', { cookie: guardianCookie });
    assert.equal(request.status, 'requested');
    assert.ok(await notified('compliance.data_request') >= 1, 'a person decides, not the system');
    const done = await api(`/compliance/data-requests/${request.id}/export`, {});
    assert.ok(done.fileId);
    const { stream } = await app.files.stream(done.fileId, schoolId);
    const parts = []; for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const bundle = JSON.parse(Buffer.concat(parts).toString('utf8'));
    assert.equal(bundle.guardian.phone, guardian.phone);
    assert.equal(bundle.children.length, 1);
    assert.ok(bundle.consents.length >= 2);
    assert.ok(await notified('compliance.data_ready') >= 1);
    // a deletion is never carried out by the system
    const del = await api('/portal/data-requests', { kind: 'delete' }, 'POST', { cookie: guardianCookie });
    await assert.rejects(() => api(`/compliance/data-requests/${del.id}/export`, {}), /only an export/);
  });

  test('retention reports what is past its date and deletes nothing', async () => {
    await api('/compliance/retention', { entityType: 'notification', keepYears: 1, action: 'delete' });
    await api('/compliance/retention', { entityType: 'student', keepYears: 7, action: 'archive' });
    const before = await app.db.count('notifications', { school_id: schoolId });
    assert.ok(before > 0);
    await app.db.execute(`UPDATE notifications SET created_at = ? WHERE school_id = ?`, ['2020-01-01 09:00:00', schoolId]);
    const review = (await api('/compliance/retention')).review;
    const rule = review.policies.find(p => p.entityType === 'notification');
    assert.equal(rule.rows, before, 'every one of them is older than a year now');
    assert.equal(review.due, 1);
    assert.equal(await app.db.count('notifications', { school_id: schoolId }), before, 'and not one of them was deleted');
    const monthly = await app.compliance.jobs()['compliance.review']({ schoolId, jobKey: 'compliance.review', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(monthly.retentionDue, 1);
    assert.ok(monthly.unsentReports >= 0);
  });
});
