// Year 4, first batch: several schools of one owner in one installation.
// A group with a head school that may read the others and members that may not; a consolidated view
// built from the same kpi_daily rows each head teacher's own dashboard reads; a child moving between
// two schools of the group without being lost or duplicated; a shared staff pool; money that refuses
// to add two currencies together until somebody records a rate; and one guardian login that reaches
// their children in both schools and nobody else's child anywhere.
//   node --test tests/groups.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-groups');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'groups-key'.padEnd(64, 'x'), CRON_KEY: 'cron-groups', UPLOADS_DIR: 'tests/.tmp-groups/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-groups/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, http, baseUrl;
let dhaka, sylhet, ctg, outsider;            // { schoolId, userId, cookie }
let groupId, familyCookie, transferId;
const kids = {};                             // label → { id, admissionNo, schoolId }
const t0 = Date.now();
const today = new Date().toISOString().slice(0, 10);

describe('year 4: multi-school groups, transfers, multi-currency and the parent super-app', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    // the school the owner installed with, then three more tenants in the same database
    dhaka = await app.installer.createSchool({ schoolName: 'Trust Dhaka School', institutionType: 'school', locale: 'bn', adminName: 'Owner', adminPhone: '01700000001', adminEmail: 'dhaka@groups.test', adminPassword: 'secret-pass-1' });
    await app.installer.finish(dhaka.schoolId);
    sylhet = await app.installer.addTenant({ schoolName: 'Trust Sylhet School', institutionType: 'school', locale: 'bn', adminName: 'Sylhet Head', adminPhone: '01700000002', adminEmail: 'sylhet@groups.test', adminPassword: 'secret-pass-2' });
    ctg = await app.installer.addTenant({ schoolName: 'Trust International', institutionType: 'school', locale: 'en', adminName: 'Ctg Head', adminPhone: '01700000003', adminEmail: 'ctg@groups.test', adminPassword: 'secret-pass-3' });
    outsider = await app.installer.addTenant({ schoolName: 'Unrelated Academy', institutionType: 'school', locale: 'bn', adminName: 'Other Head', adminPhone: '01700000004', adminEmail: 'other@groups.test', adminPassword: 'secret-pass-4' });
    for (const s of [dhaka, sylhet, ctg, outsider]) await app.settings.set(s.schoolId, 'notifications.quiet_hours', null);
    // the installer writes BDT for every school; an international school bills in dollars
    await app.db.execute(`UPDATE schools SET currency = 'USD' WHERE id = ?`, [ctg.schoolId]);

    const classOf = async (schoolId, level) => String((await app.academic.classes(schoolId)).find(c => Number(c.numeric_level) === level).id);
    // one family with a child in Dhaka and a child in Sylhet — the same phone in two schools
    kids.dhakaShared = await app.people.createStudent(dhaka.schoolId, { firstName: 'Ayesha', gender: 'female', dateOfBirth: '2013-03-02', classId: await classOf(dhaka.schoolId, 5), admissionDate: '2022-01-05', guardians: [{ fullName: 'Rahim Mia', phone: '01911000001', relation: 'father', isPrimary: true, paysFees: true }] });
    kids.sylhetShared = await app.people.createStudent(sylhet.schoolId, { firstName: 'Karim', gender: 'male', dateOfBirth: '2011-06-11', classId: await classOf(sylhet.schoolId, 7), admissionDate: '2022-01-05', guardians: [{ fullName: 'Rahim Mia', phone: '01911000001', relation: 'father', isPrimary: true, paysFees: true }] });
    // another family, in Dhaka only — the child that must never appear in the first family's view
    kids.dhakaOther = await app.people.createStudent(dhaka.schoolId, { firstName: 'Nusrat', gender: 'female', dateOfBirth: '2013-09-19', classId: await classOf(dhaka.schoolId, 5), admissionDate: '2022-01-05', guardians: [{ fullName: 'Shirin Akter', phone: '01911000002', relation: 'mother', isPrimary: true, paysFees: true }] });
    kids.ctg = await app.people.createStudent(ctg.schoolId, { firstName: 'Emily', gender: 'female', dateOfBirth: '2012-04-04', classId: await classOf(ctg.schoolId, 6), admissionDate: '2022-01-05', guardians: [{ fullName: 'John Doe', phone: '01911000003', relation: 'father', isPrimary: true, paysFees: true }] });
    // staff in two schools, so the pool has something to pool
    await app.people.createStaff(dhaka.schoolId, { firstName: 'Mizanur', lastName: 'Rahman', staffCategory: 'teaching', joinDate: '2020-01-01', phone: '01811000001' });
    await app.people.createStaff(sylhet.schoolId, { firstName: 'Farhana', lastName: 'Haque', staffCategory: 'teaching', joinDate: '2020-01-01', phone: '01811000002' });

    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    for (const [s, email, pass] of [[dhaka, 'dhaka@groups.test', 'secret-pass-1'], [sylhet, 'sylhet@groups.test', 'secret-pass-2'], [ctg, 'ctg@groups.test', 'secret-pass-3'], [outsider, 'other@groups.test', 'secret-pass-4']]) {
      const r = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password: pass }) });
      s.cookie = r.headers.get('set-cookie').split(';')[0];
    }
    // the guardian of the two-school family signs in as themselves
    const g = await app.db.findOne('guardians', { school_id: dhaka.schoolId, phone: '+8801911000001' });
    const uid = g.user_id ?? await app.people.ensureGuardianAccount(dhaka.schoolId, String(g.id));
    familyCookie = `ps_session=${(await app.auth.createSession(await app.db.findOne('users', { id: uid }))).token}`;
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`groups finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => {
    const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? dhaka.cookie }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 160)}`); }
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const status = async (p, cookie, method = 'GET', body) => (await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined })).status;
  /** Bills a student and takes the money, through the school's own console. */
  const collect = async (school, studentId, amount) => {
    const head = (await api('/fees/overview', null, 'GET', { cookie: school.cookie })).heads[0];
    const invoice = await api('/fees/invoices', { studentId, items: [{ feeHeadId: String(head.id), description: 'Tuition', amount }] }, 'POST', { cookie: school.cookie });
    await api('/fees/payments', { studentId, amount, method: 'cash', invoiceIds: [invoice.id] }, 'POST', { cookie: school.cookie });
    return invoice.id;
  };

  // ---------------- the group ----------------
  test('the owner’s school makes a group; no other school in the installation can', async () => {
    const made = await api('/groups', { name: 'Trust of Bengal', schoolIds: [sylhet.schoolId, ctg.schoolId], baseCurrency: 'BDT' });
    groupId = made.id;
    assert.equal(made.schools, 3);
    assert.equal(made.baseCurrency, 'BDT');

    const mine = await api('/groups');
    assert.equal(mine.length, 1);
    assert.ok(Number(mine[0].is_head), 'the school that made the group is its head');
    assert.equal(Number(mine[0].schools), 3);

    const theirs = await api('/groups', null, 'GET', { cookie: sylhet.cookie });
    assert.equal(theirs.length, 1);
    assert.ok(!Number(theirs[0].is_head), 'a member school is a member, not a head');

    // a branch cannot group itself with head office and become the head of that group
    assert.equal(await status('/groups', sylhet.cookie, 'POST', { name: 'Sylhet first', schoolIds: [dhaka.schoolId] }), 403);
    assert.equal(await app.db.count('school_groups', {}), 1);

    const schools = await api(`/groups/${groupId}/schools`);
    assert.equal(schools.length, 3);
    assert.deepEqual([...new Set(schools.map(s => String(s.currency)))].sort(), ['BDT', 'USD']);
  });

  test('the consolidated view is the schools’ own numbers added up, and every row says which school it came from', async () => {
    await collect(dhaka, kids.dhakaShared.id, 3000);
    await collect(sylhet, kids.sylhetShared.id, 2000);
    await app.attendance.mark(dhaka.schoolId, kids.dhakaShared.id, today, 'present', { notify: false });
    await app.attendance.mark(dhaka.schoolId, kids.dhakaOther.id, today, 'absent', { notify: false });

    const view = await api(`/groups/${groupId}/consolidated`);
    assert.equal(view.schools.length, 3);
    assert.equal(view.totals.roll, 4, 'two children in Dhaka, one in Sylhet, one in Chattogram');
    assert.equal(view.totals.staff, 2);
    const dhakaRow = view.schools.find(s => s.schoolId === dhaka.schoolId);
    const sylhetRow = view.schools.find(s => s.schoolId === sylhet.schoolId);
    assert.equal(dhakaRow.schoolName, 'Trust Dhaka School');
    assert.equal(dhakaRow.roll, 2);
    assert.equal(dhakaRow.collected, 3000);
    assert.equal(sylhetRow.collected, 2000);
    assert.equal(dhakaRow.attendancePct, 50, 'one of two present');
    assert.ok(dhakaRow.daysCovered >= 1, 'the days behind the figure are stated, never assumed');

    // the same rows the school's own dashboard reads: the trust and the head teacher cannot disagree
    const own = await app.analytics.dashboard(dhaka.schoolId, 'admin');
    const ownCollected = own.cards.find(c => c.key === 'fees_collected');
    assert.equal(ownCollected.value, dhakaRow.collected);
    assert.equal(own.cards.find(c => c.key === 'students_active').value, dhakaRow.roll);
  });

  test('a member school cannot read the other schools’ numbers, and neither can an outsider', async () => {
    // Sylhet's administrator is a super admin inside Sylhet and still gets nothing across the group
    assert.equal(await status(`/groups/${groupId}/consolidated`, sylhet.cookie), 403);
    assert.equal(await status(`/groups/${groupId}/staff`, sylhet.cookie), 403);
    assert.equal(await status(`/groups/${groupId}/schools`, sylhet.cookie), 403);
    assert.equal(await status(`/groups/${groupId}/schools`, sylhet.cookie, 'POST', { schoolId: outsider.schoolId }), 403);
    // a school that is not in the group at all is not even told what the group holds
    assert.equal(await status(`/groups/${groupId}/consolidated`, outsider.cookie), 403);
    assert.equal((await api('/groups', null, 'GET', { cookie: outsider.cookie })).length, 0);
    // and a guardian never reaches a console endpoint, group or not
    assert.equal(await status('/groups', familyCookie), 403);
    assert.equal(await status(`/groups/${groupId}/consolidated`, familyCookie), 403);
  });

  // ---------------- multi-currency ----------------
  test('two currencies do not add up until somebody records a rate, and the rate used is reported', async () => {
    await collect(ctg, kids.ctg.id, 500);                       // 500 dollars, not 500 taka
    const before = await api(`/groups/${groupId}/consolidated`);
    assert.equal(before.money.collected, null, 'BDT and USD are not summed just because both are numbers');
    assert.equal(before.money.outstanding, null);
    assert.equal(before.money.missingRates.length, 1);
    assert.equal(before.money.missingRates[0].from, 'USD');
    assert.match(before.money.error, /no exchange rate USD→BDT/);
    assert.equal(before.totals.roll, 4, 'the counts are still counts');

    await api('/groups/rates', { baseCcy: 'USD', quoteCcy: 'BDT', rate: 120, asOf: today, source: 'Bangladesh Bank' });
    const after = await api(`/groups/${groupId}/consolidated`);
    assert.equal(after.money.collected, 3000 + 2000 + 500 * 120);
    assert.equal(after.money.missingRates.length, 0);
    assert.equal(after.money.rates.length, 1);
    assert.equal(after.money.rates[0].rate, 120);
    assert.equal(after.money.rates[0].asOf, today, 'a total records the rate it was made with');
    const ctgRow = after.schools.find(s => s.schoolId === ctg.schoolId);
    assert.equal(ctgRow.currency, 'USD');
    assert.equal(ctgRow.collected, 500, 'the school still reads its own books in its own money');
    assert.equal(ctgRow.collectedBase, 60_000);
    assert.equal(after.schools.find(s => s.schoolId === dhaka.schoolId).rate, 1);

    // the opposite direction comes from the same row rather than a second hand-kept one
    const back = await app.groups.rateFor('BDT', 'USD', today);
    assert.equal(back.inverted, true);
    assert.ok(Math.abs(back.rate - 1 / 120) < 1e-9);
    // a rate recorded after the day being reported is not used for that day
    assert.equal(await app.groups.rateFor('USD', 'BDT', '2000-01-01'), null);
    await assert.rejects(() => app.groups.convert(100, 'EUR', 'BDT'), /no exchange rate EUR→BDT/);
  });

  // ---------------- the shared staff pool ----------------
  test('the head office sees who works for the group and how loaded they are', async () => {
    const pool = await api(`/groups/${groupId}/staff`);
    assert.equal(pool.schools, 3);
    assert.equal(pool.staff.length, 2);
    const names = pool.staff.map(s => `${s.school_code}:${s.first_name}`).sort();
    assert.deepEqual(names, ['TRUSTDHA:Mizanur', 'TRUSTSYL:Farhana'].sort(), 'each person carries the school they belong to');
    assert.ok(pool.staff.every(s => 'periods' in s), 'and the teaching load the head office is looking for');
    assert.equal(await status(`/groups/${groupId}/staff?q=Farhana`, sylhet.cookie), 403);

    // a trust of twenty schools has more staff than one request may carry, so the pool is a page
    // that says what it is a page of
    assert.equal(pool.total, 2);
    const firstPage = await api(`/groups/${groupId}/staff?limit=1`);
    assert.equal(firstPage.staff.length, 1);
    assert.equal(firstPage.total, 2, 'the page says how many there are altogether');
    const secondPage = await api(`/groups/${groupId}/staff?limit=1&offset=1`);
    assert.equal(secondPage.staff.length, 1);
    assert.notEqual(String(secondPage.staff[0].id), String(firstPage.staff[0].id), 'the second page is not the first again');
    assert.equal((await api(`/groups/${groupId}/staff?limit=1&offset=99`)).staff.length, 0);
  });

  test('the schools a group may add are offered as a list, and only to the founder', async () => {
    const addable = await api(`/groups/${groupId}/addable`);
    const ids = addable.map(s => String(s.id));
    assert.ok(ids.includes(String(outsider.schoolId)), 'a school on this installation that is not in the group can be added');
    for (const member of [dhaka, sylhet, ctg]) {
      assert.equal(ids.includes(String(member.schoolId)), false, 'a member is not offered again');
    }
    assert.ok(addable.every(s => s.name && s.code), 'each one is named, so nobody has to type an id');
    // the list is every tenant on the host, which is exactly what an unauthorised caller would like
    assert.equal(await status(`/groups/${groupId}/addable`, sylhet.cookie), 403);
    assert.equal(await status(`/groups/${groupId}/addable`, outsider.cookie), 403);
  });

  // ---------------- transfers ----------------
  test('a child moves to the sister school, keeps their family, and is never counted twice', async () => {
    const before = await api(`/groups/${groupId}/consolidated`);
    const r = await api('/groups/transfers', { studentId: kids.dhakaOther.id, toSchoolId: sylhet.schoolId, reason: 'family moved to Sylhet' });
    transferId = r.id;
    assert.notEqual(r.toStudentId, kids.dhakaOther.id);
    assert.equal(r.alreadyTransferred, false);

    const arrived = await app.db.findOne('students', { id: r.toStudentId });
    assert.equal(String(arrived.school_id), sylhet.schoolId, 'the new row belongs to the receiving school');
    assert.equal(String(arrived.status), 'active');
    assert.equal(String(arrived.admission_no), r.admissionNo);
    // the same rung of the ladder: Class 5 in Dhaka is Class 5 in Sylhet, never Class 1
    const fromClass = await app.db.findOne('classes', { id: String((await app.db.findOne('students', { id: kids.dhakaOther.id })).current_class_id) });
    const toClass = await app.db.findOne('classes', { id: String(arrived.current_class_id) });
    assert.equal(Number(toClass.numeric_level), Number(fromClass.numeric_level));

    const left = await app.db.findOne('students', { id: kids.dhakaOther.id });
    assert.equal(String(left.status), 'transferred', 'the row they left is closed, not deleted');
    assert.equal(await app.db.count('student_status_history', { student_id: kids.dhakaOther.id, to_status: 'transferred' }), 1);

    // the family came with them: the mother's phone is now a guardian of the new row too
    const guardians = await app.db.query(`SELECT g.phone, g.school_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ?`, [r.toStudentId]);
    assert.equal(guardians.length, 1);
    assert.equal(String(guardians[0].phone), '+8801911000002');
    assert.equal(String(guardians[0].school_id), sylhet.schoolId);

    // a repeat — a double click, or the relay delivering twice — returns the first transfer
    const again = await api('/groups/transfers', { studentId: kids.dhakaOther.id, toSchoolId: sylhet.schoolId });
    assert.equal(again.alreadyTransferred, true);
    assert.equal(again.toStudentId, r.toStudentId);
    assert.equal(await app.db.count('students', { school_id: sylhet.schoolId, status: 'active' }), 2);

    // the trust's roll did not change: one school lost a child and the other gained the same one
    const after = await api(`/groups/${groupId}/consolidated`);
    assert.equal(after.totals.roll, before.totals.roll);
    assert.equal(after.schools.find(s => s.schoolId === dhaka.schoolId).roll, 1);
    assert.equal(after.schools.find(s => s.schoolId === sylhet.schoolId).roll, 2);

    const listed = await api('/groups/transfers');
    assert.equal(listed.length, 1);
    assert.equal(String(listed[0].from_school_id), dhaka.schoolId);
    assert.equal(String(listed[0].to_school_id), sylhet.schoolId);
    assert.equal(String(listed[0].from_school), 'Trust Dhaka School');
    // the receiving school sees the same row from its own side
    assert.equal((await api('/groups/transfers', null, 'GET', { cookie: sylhet.cookie })).length, 1);
  });

  test('a school outside the group is not somewhere a child can be transferred to', async () => {
    await assert.rejects(() => api('/groups/transfers', { studentId: kids.dhakaShared.id, toSchoolId: outsider.schoolId }), /not in the same group/);
    await assert.rejects(() => api('/groups/transfers', { studentId: kids.dhakaShared.id, toSchoolId: dhaka.schoolId }), /a transfer needs two schools/);
    // and one school cannot reach into another to move its children out
    assert.equal(await status('/groups/transfers', sylhet.cookie, 'POST', { studentId: kids.dhakaShared.id, toSchoolId: ctg.schoolId }), 404, 'a transfer is always out of the caller’s own school');
    assert.equal(String((await app.db.findOne('students', { id: kids.dhakaShared.id })).status), 'active');
  });

  // ---------------- the parent super-app ----------------
  test('a guardian with children in two schools sees exactly their two children', async () => {
    const family = await api('/portal/family', null, 'GET', { cookie: familyCookie });
    assert.equal(family.children.length, 2);
    assert.equal(family.schools, 2);
    assert.deepEqual(family.children.map(c => c.name).sort(), ['Ayesha', 'Karim']);
    const karim = family.children.find(c => c.name === 'Karim');
    assert.equal(karim.school.id, sylhet.schoolId);
    assert.equal(karim.school.name, 'Trust Sylhet School');
    assert.equal(karim.isHomeSchool, false, 'the child in the other school is marked as such');
    assert.equal(family.children.find(c => c.name === 'Ayesha').isHomeSchool, true);
    // nobody else's child, in either school
    assert.ok(!family.children.some(c => c.name === 'Nusrat' || c.name === 'Emily'));
    // dues travel with the child in the child's own school's currency and are never added together
    assert.equal(karim.duesCurrency, 'BDT');
    assert.ok('dues' in karim);

    // the other family sees only their own child, and it is the transferred row in the new school
    const other = await app.db.findOne('guardians', { school_id: sylhet.schoolId, phone: '+8801911000002' });
    const otherUser = other.user_id ?? await app.people.ensureGuardianAccount(sylhet.schoolId, String(other.id));
    const otherCookie = `ps_session=${(await app.auth.createSession(await app.db.findOne('users', { id: otherUser }))).token}`;
    const otherFamily = await api('/portal/family', null, 'GET', { cookie: otherCookie });
    assert.equal(otherFamily.children.length, 1, 'the row they left is closed, so the child appears once');
    assert.equal(otherFamily.children[0].name, 'Nusrat');
    assert.equal(otherFamily.children[0].school.id, sylhet.schoolId);
  });

  test('the family view belongs to a guardian, and a school console cannot borrow it', async () => {
    assert.equal(await status('/portal/family', dhaka.cookie), 403, 'an administrator gets no cross-school reach through the portal');
    assert.equal(await status('/portal/family', sylhet.cookie), 403);
    assert.equal((await fetch(`${baseUrl}/api/portal/family`)).status, 401, 'and neither does nobody at all');
  });

  test('the transfer was announced as an event the rest of the platform can react to', async () => {
    for (let i = 0; i < 10; i++) await app.tick({ budgetMs: 300 });
    const events = await app.db.query(`SELECT event_type, school_id, payload FROM outbox_events WHERE event_type IN ('group.created', 'student.transferred') ORDER BY occurred_at, id`);
    assert.equal(events.filter(e => String(e.event_type) === 'group.created').length, 1);
    const moved = events.find(e => String(e.event_type) === 'student.transferred');
    assert.ok(moved, 'a transfer is an event, not just a row');
    assert.equal(String(moved.school_id), dhaka.schoolId, 'raised by the school the child left');
    const payload = typeof moved.payload === 'string' ? JSON.parse(moved.payload) : moved.payload;
    assert.equal(payload.transferId, transferId);
    assert.equal(payload.toSchoolId, sylhet.schoolId);
  });
});
