// The vendor's half of the platform: the console the owner of Pathshala sells the software from.
//
// What this proves: the gate (a school's own admin and another school's super admin are both refused,
// on every route and inside the service itself, not only at the door); provisioning a real client
// under their own name, with an administrator who can actually sign in and reach the console; a
// one-time password that exists in the reply and nowhere else afterwards; suspension that stops new
// work and never stops a school reading its own register; an overview whose counts and MRR come from
// the same rows anybody can count by hand; and an audit row behind every write.
//   node --test tests/owner.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-owner');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'owner-key'.padEnd(64, 'x'), CRON_KEY: 'cron-owner', OWNER_DOOR: 'test-door-9x7k2p', UPLOADS_DIR: 'tests/.tmp-owner/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-owner/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, http, baseUrl;
let hq, client, clerk;                 // { schoolId, userId, cookie }
let plans = [], provisioned = null, saasInvoiceId = null, ticketId = null;
const t0 = Date.now();

describe('the owner console: one vendor, many client schools', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    // the school the owner installed with — the vendor's own tenant, and the only one this console answers to
    hq = await app.installer.createSchool({ schoolName: 'Pathshala HQ School', institutionType: 'school', locale: 'en', adminName: 'The Owner', adminPhone: '01700000101', adminEmail: 'owner@vendor.test', adminPassword: 'owner-pass-1' });
    await app.installer.finish(hq.schoolId);
    // an existing client, added before this console existed
    client = await app.installer.addTenant({ schoolName: 'Shapla High School', institutionType: 'school', locale: 'bn', adminName: 'Shapla Head', adminPhone: '01700000102', adminEmail: 'head@shapla.test', adminPassword: 'shapla-pass-1' });
    for (const s of [hq, client]) await app.settings.set(s.schoolId, 'notifications.quiet_hours', null);

    // a clerk inside the vendor's own school: the right school, the wrong role
    clerk = { schoolId: hq.schoolId };
    clerk.userId = await app.auth.createUser({ schoolId: hq.schoolId, userType: 'admin', displayName: 'HQ Clerk', phone: '01700000103', email: 'clerk@vendor.test', password: 'clerk-pass-1', roles: ['admin'] });

    // a student on the books of the client school, entered before anything is suspended
    const classes = await app.academic.classes(client.schoolId);
    client.classId = String(classes.find(c => Number(c.numeric_level) === 6)?.id ?? classes[0].id);
    await app.people.createStudent(client.schoolId, { firstName: 'Rumi', gender: 'female', dateOfBirth: '2012-02-02', classId: client.classId, admissionDate: '2023-01-05', guardians: [{ fullName: 'Kamal Uddin', phone: '01911000101', relation: 'father', isPrimary: true, paysFees: true }] });

    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    for (const [who, email, pass] of [[hq, 'owner@vendor.test', 'owner-pass-1'], [client, 'head@shapla.test', 'shapla-pass-1'], [clerk, 'clerk@vendor.test', 'clerk-pass-1']]) who.cookie = await login(email, pass);
    await app.saas.ensurePlans();
    plans = await app.saas.plans();
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`owner finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const login = async (identifier, password) => {
    const r = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password }) });
    assert.equal(r.status, 200, `login ${identifier} → ${r.status} ${await r.text()}`);
    return r.headers.get('set-cookie').split(';')[0];
  };
  const call = async (p, body, method = body ? 'POST' : 'GET', cookie = hq.cookie) => {
    const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { /* html or empty */ }
    return { status: r.status, body: j, text };
  };
  const api = async (p, body, method = body ? 'POST' : 'GET', cookie = hq.cookie) => {
    const r = await call(p, body, method, cookie);
    assert.ok(r.status < 400, `${method} ${p} → ${r.status} ${r.text.slice(0, 200)}`);
    return r.body;
  };

  /** A page, not an API call: the door and the console are server-rendered HTML. */
  const page = async (p, opts = {}) => {
    const r = await fetch(`${baseUrl}${p}`, { redirect: 'manual', headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers ?? {}) } });
    return { status: r.status, location: r.headers.get('location'), text: await r.text(), setCookie: r.headers.getSetCookie?.() ?? [] };
  };
  const postForm = async (p, fields, opts = {}) => {
    const r = await fetch(`${baseUrl}${p}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', origin: baseUrl, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
      body: new URLSearchParams(fields).toString(),
    });
    return { status: r.status, location: r.headers.get('location'), text: await r.text(), setCookie: r.headers.getSetCookie?.() ?? [] };
  };

  // ---------------- the door ----------------
  test('the vendor signs in at its own door, and nowhere else', async () => {
    const DOOR = '/x/test-door-9x7k2p';

    // Until somebody comes through the door this installation belongs to nobody but the school that
    // installed it, and its own administrator signs in on its own page like anybody else. That is the
    // whole point: a single-school customer's head teacher is a super admin of the founder school, and
    // making *that* the vendor would lock every customer out of their own console.
    assert.equal(await app.owner.hasOwner(), false, 'a fresh installation has no vendor');
    const beforeClaim = await postForm('/login', { intent: 'password', identifier: 'owner@vendor.test', password: 'owner-pass-1', next: '/dashboard' });
    assert.equal(beforeClaim.status, 302, 'the founder school signs in on its own page while nobody is the vendor');

    // a wrong path is a 404 like any other address on the site
    assert.equal((await page('/x/not-the-door')).status, 404);
    assert.equal([301, 302, 404].includes((await page('/x/')).status), true, 'a bare /x/ is nothing either');
    assert.equal((await page(DOOR)).status, 200, 'the door itself is there for whoever knows it');

    // the door signs the vendor in, and hands the machine a device key so tomorrow's address may differ
    const inside = await postForm(DOOR, { identifier: 'owner@vendor.test', password: 'owner-pass-1' });
    assert.equal(inside.status, 302);
    assert.equal(inside.location, '/owner');
    assert.ok(inside.setCookie.some(c => c.startsWith('ps_session=')), 'a session');
    assert.ok(inside.setCookie.some(c => c.startsWith('ps_owner_device=') && c.includes('HttpOnly')), 'and a device key the browser cannot read');
    const ownerCookie = inside.setCookie.find(c => c.startsWith('ps_session=')).split(';')[0];

    // now this account is the vendor, and a school's own sign-in page stops answering it — with the
    // answer a wrong password gets, so the page never admits such an account exists
    assert.equal(await app.owner.hasOwner(), true, 'the first arrival through the door claimed it');
    const refused = await postForm('/login', { intent: 'password', identifier: 'owner@vendor.test', password: 'owner-pass-1', next: '/dashboard' });
    assert.equal(refused.status, 200, 'the school login answers with its own page, not a redirect');
    assert.equal(refused.setCookie.some(c => c.startsWith('ps_session=') && !c.includes('Max-Age=0')), false, 'no session was handed out');
    assert.match(refused.text, /login\.failed|match/i, 'and the answer is the one a wrong password gets');
    // and it still works for a school's own head teacher
    const school = await postForm('/login', { intent: 'password', identifier: 'head@shapla.test', password: 'shapla-pass-1', next: '/dashboard' });
    assert.equal(school.status, 302);
    assert.ok(school.setCookie.some(c => c.startsWith('ps_session=')), 'a school signs in exactly as before');

    // a school's head teacher who somehow finds the door gets nothing from it
    const wrongPerson = await postForm(DOOR, { identifier: 'head@shapla.test', password: 'shapla-pass-1' });
    assert.equal(wrongPerson.status, 404, 'the page is gone rather than forbidden');
    assert.equal(wrongPerson.setCookie.some(c => c.startsWith('ps_session=') && !c.includes('Max-Age=0')), false, 'and the session it just made was dropped');

    // the console answers the vendor and nobody else — as a 404, so there is nothing to find
    assert.equal((await page('/owner', { cookie: ownerCookie })).status, 200);
    assert.equal((await page('/owner')).status, 404, 'signed out');
    assert.equal((await page('/owner', { cookie: client.cookie })).status, 404, "a client's head teacher");
    assert.equal((await page('/owner', { cookie: clerk.cookie })).status, 404, 'a clerk in the vendor\u2019s own school');

    // and so does its API: 404, never 403
    assert.equal((await call('/owner/overview', null, 'GET', client.cookie)).status, 404);
    assert.equal((await call('/owner/schools', null, 'GET', clerk.cookie)).status, 404);
    assert.equal((await call('/owner/overview', null, 'GET', null)).status, 404);
    assert.equal((await call('/owner/overview', null, 'GET', ownerCookie)).status, 200, 'the owner still gets their own answer');
  });

  test('a machine the owner has trusted is remembered, and the list is theirs to shorten', async () => {
    const devices = await app.ownerAccess.devices();
    assert.ok(devices.length >= 1, 'signing in through the door trusted this machine');
    const mine = devices[0];
    assert.match(mine.label, /on/, 'the label says what kind of machine it was');
    assert.ok(mine.addedAt && mine.lastSeenAt, 'and when it was first and last seen');
    assert.equal(await app.ownerAccess.forgetDevice(mine.id), true);
    assert.equal((await app.ownerAccess.devices()).some(d => d.id === mine.id), false, 'a machine can be taken off the list');
    assert.equal(await app.ownerAccess.forgetDevice('01NOTADEVICE0000000000000'), false);
  });

  test('a MAC is not asked for over the internet, and an address rule is an OR not an AND', async () => {
    const access = app.ownerAccess;
    // the three rules, as rules
    assert.equal(core.ipMatches('203.0.113.9', '203.0.113.9'), true);
    assert.equal(core.ipMatches('203.0.113.9', '203.0.113.0/24'), true);
    assert.equal(core.ipMatches('198.51.100.9', '203.0.113.0/24'), false);
    assert.equal(core.normalizeIp('::ffff:203.0.113.9'), '203.0.113.9', 'the address people write down');
    assert.equal(core.normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(core.normalizeMac('not a mac'), null);
    // a MAC only exists on our own segment; a public address is never asked
    assert.equal(core.isLanIp('192.168.1.40'), true);
    assert.equal(core.isLanIp('203.0.113.9'), false);
    assert.equal(await access.macFor('203.0.113.9'), null, 'a MAC does not cross the internet');

    // with nothing configured and nothing trusted, the door is open to the password alone —
    // an owner locked out of their own console by a network rule is the worse failure
    for (const d of await access.devices()) await access.forgetDevice(d.id);
    const open = await access.check({ ip: '203.0.113.9', deviceToken: null });
    assert.equal(open.allowed, true);
    assert.equal(open.matched, 'open');

    // trust one machine, and now the rule bites: that machine yes, an unknown one no
    const device = await access.trustDevice({ label: 'the owner\u2019s laptop', ip: '203.0.113.9' });
    assert.equal((await access.check({ ip: '198.51.100.7', deviceToken: device.token })).matched, 'device', 'the key travels with the laptop');
    assert.equal((await access.check({ ip: '203.0.113.9', deviceToken: null })).allowed, false, 'a different browser at the same desk is not the same machine');
    assert.equal((await access.check({ ip: '203.0.113.9', deviceToken: `${device.id}.forged` })).allowed, false, 'and an id without the signature is nothing');

    // an address on the allowlist is enough on its own, with no device key at all
    app.config.ownerIps = ['203.0.113.0/24'];
    assert.equal((await access.check({ ip: '203.0.113.9', deviceToken: null })).matched, 'ip');
    assert.equal((await access.check({ ip: '198.51.100.7', deviceToken: null })).allowed, false);
    assert.equal((await access.check({ ip: '198.51.100.7', deviceToken: device.token })).matched, 'device', 'either one, never both');
    app.config.ownerIps = [];
    for (const d of await access.devices()) await access.forgetDevice(d.id);
  });

  /** Every route of the owner API, with a body good enough to reach the gate. */
  const ROUTES = () => [
    ['GET', '/owner/overview'],
    ['GET', '/owner/schools'],
    ['GET', `/owner/schools/${client.schoolId}`],
    ['POST', '/owner/schools', { schoolName: 'Gate Test School', adminName: 'Gate Admin', adminPhone: '01700000199', adminEmail: 'gate@test.test' }],
    ['POST', `/owner/schools/${client.schoolId}/status`, { status: 'suspended' }],
    ['POST', `/owner/schools/${client.schoolId}/plan`, { planId: String(plans[0]?.id ?? 'x') }],
    ['POST', `/owner/schools/${client.schoolId}/admin`, { name: 'Gate Admin', phone: '01700000198' }],
    ['GET', '/owner/billing'],
    ['POST', '/owner/invoices/none/paid', {}],
    ['GET', '/owner/tickets'],
    ['POST', '/owner/tickets/none/close', {}],
    ['GET', '/owner/health'],
  ];

  // ---------------------------------------------------------------- the gate
  test('a school admin and another school\'s super admin are refused on every route', async () => {
    for (const [method, p, body] of ROUTES()) {
      // every refusal leaves as a 404: a 403 would tell a school's administrator that a vendor
      // console is at this address and that they are one role away from it
      const clerkTry = await call(p, body, method, clerk.cookie);
      assert.equal(clerkTry.status, 404, `${method} ${p} for a clerk of the vendor's own school → ${clerkTry.status}`);
      const clientTry = await call(p, body, method, client.cookie);
      assert.equal(clientTry.status, 404, `${method} ${p} for another school's super admin → ${clientTry.status}`);
      const anon = await call(p, body, method, null);
      assert.equal(anon.status, 404, `${method} ${p} signed out → ${anon.status}`);
    }
    // nothing was created by any of those attempts
    assert.equal(await app.db.count('schools', { name: 'Gate Test School' }), 0);
  });

  test('the gate is in the service, not only in the route', async () => {
    const clientAdmin = await app.auth.findByIdentifier('head@shapla.test', client.schoolId);
    const forbidden = e => e instanceof core.HttpError && e.status === 403;
    // a super admin, of the wrong school
    await assert.rejects(() => app.owner.overview({ id: clientAdmin.id, school_id: client.schoolId, user_type: 'admin' }), forbidden);
    await assert.rejects(() => app.owner.schools({ id: clientAdmin.id, school_id: client.schoolId }), forbidden);
    await assert.rejects(() => app.owner.provision({ id: clientAdmin.id, school_id: client.schoolId }, { schoolName: 'Nope', adminName: 'Nope', adminPhone: '01700000197' }), forbidden);
    // the right school, the wrong role
    await assert.rejects(() => app.owner.overview({ id: clerk.userId, school_id: hq.schoolId }), forbidden);
    // and no caller at all: fail closed
    await assert.rejects(() => app.owner.requireOwner(null), forbidden);
    await assert.rejects(() => app.owner.requireOwner({ id: '', school_id: '' }), forbidden);
    // the founder's super admin gets through
    const ok = await app.owner.requireOwner({ id: hq.userId, school_id: hq.schoolId });
    assert.equal(ok.founderId, hq.schoolId);
  });

  test('the founder\'s super admin gets through', async () => {
    const o = await api('/owner/overview');
    assert.ok(o.schools.total >= 2, 'both schools are listed');
    const list = await api('/owner/schools');
    assert.equal(list.total, o.schools.total);
    assert.ok(list.schools.some(s => s.id === client.schoolId));
  });

  // ---------------------------------------------------------------- provisioning
  test('a new client is provisioned under their own name and can sign in', async () => {
    const before = await app.db.count('schools', {});
    provisioned = await api('/owner/schools', {
      schoolName: 'Nabin Adarsha College', institutionType: 'college', locale: 'bn',
      adminName: 'Nabin Principal', adminPhone: '01700000110', adminEmail: 'principal@nabin.test',
      planId: String(plans.find(p => Number(p.price_yearly) > 0).id), trialDays: 0, billingCycle: 'yearly',
    });
    assert.equal(await app.db.count('schools', {}), before + 1);
    assert.ok(provisioned.schoolId && provisioned.code, 'the school has its own id and code');
    assert.ok(provisioned.password && provisioned.password.length >= 12, 'a password was generated');
    assert.equal(provisioned.passwordGenerated, true);
    assert.equal(provisioned.subscription.status, 'active');

    const school = await app.db.findOne('schools', { id: provisioned.schoolId });
    assert.equal(String(school.name), 'Nabin Adarsha College', 'the client\'s own name, not the vendor\'s');
    assert.equal(String(school.institution_type), 'college');
    assert.equal(String(school.code), provisioned.code);
    assert.notEqual(String(school.code), String((await app.db.findOne('schools', { id: hq.schoolId })).code), 'its own code, unique on the installation');
    // the tenant was seeded, not merely inserted
    assert.ok(await app.db.count('academic_years', { school_id: provisioned.schoolId }) > 0, 'a current academic year');
    assert.ok(await app.db.count('roles', { school_id: provisioned.schoolId }) > 0, 'its own roles');

    // the admin can actually sign in and reach the console
    const cookie = await login('principal@nabin.test', provisioned.password);
    const me = await api('/auth/me', null, 'GET', cookie);
    assert.equal(me.user.schoolId, provisioned.schoolId);
    assert.ok(me.roles.includes('super_admin'));
    const page = await fetch(`${baseUrl}/dashboard`, { headers: { cookie } });
    assert.equal(page.status, 200, 'the new administrator reaches /dashboard');
    assert.match(await page.text(), /Nabin Principal/, 'and it is their own console');
    provisioned.cookie = cookie;
  });

  test('the one-time password is returned once and is readable nowhere afterwards', async () => {
    const secret = provisioned.password;
    const detail = await call(`/owner/schools/${provisioned.schoolId}`);
    assert.equal(detail.status, 200);
    assert.ok(!detail.text.includes(secret), 'the client page does not carry it');
    assert.ok(!JSON.stringify(await api('/owner/schools')).includes(secret), 'nor the client list');

    const user = await app.auth.findByIdentifier('principal@nabin.test', provisioned.schoolId);
    assert.ok(String(user.password_hash).startsWith('$2'), 'only a bcrypt hash is stored');
    assert.ok(!String(user.password_hash).includes(secret));

    // and nowhere in the rows the write left behind
    for (const table of ['audit_logs', 'outbox_events', 'notifications', 'schools', 'saas_subscriptions']) {
      const rows = await app.db.findMany(table, {});
      assert.ok(!JSON.stringify(rows).includes(secret), `${table} does not hold the password`);
    }
    // a lost password costs a reset, which is the whole point of not keeping one
    const reset = await api(`/owner/schools/${provisioned.schoolId}/admin`, { name: 'Nabin Principal', phone: '01700000110' });
    assert.equal(reset.reset, true);
    assert.notEqual(reset.password, secret);
    await login('principal@nabin.test', reset.password);
    const stale = await call('/auth/login', { identifier: 'principal@nabin.test', password: secret }, 'POST', null);
    assert.equal(stale.status, 401, 'the old password no longer works');
    provisioned.password = reset.password;
    provisioned.cookie = await login('principal@nabin.test', reset.password);
  });

  test('a second administrator can be added for a client', async () => {
    const added = await api(`/owner/schools/${client.schoolId}/admin`, { name: 'Shapla Deputy', phone: '01700000111', email: 'deputy@shapla.test' });
    assert.equal(added.created, true);
    assert.ok(added.password.length >= 12);
    const cookie = await login('deputy@shapla.test', added.password);
    assert.equal((await api('/auth/me', null, 'GET', cookie)).user.schoolId, client.schoolId);
    const detail = await api(`/owner/schools/${client.schoolId}`);
    assert.ok(detail.admins.some(a => a.email === 'deputy@shapla.test'), 'and shows up in the client\'s admins');
    assert.ok(detail.admins.every(a => !('password' in a)));
  });

  // ---------------------------------------------------------------- suspension
  test('a suspended school cannot admit a student and can still read its register', async () => {
    const rows = r => Number(r.total ?? (Array.isArray(r) ? r.length : 0));
    const beforeCount = rows(await api('/people/students', null, 'GET', client.cookie));
    assert.ok(beforeCount >= 1, 'the school has a register to read');

    const r = await api(`/owner/schools/${client.schoolId}/status`, { status: 'suspended', reason: 'unpaid since March' });
    assert.equal(r.status, 'suspended');
    assert.equal(String((await app.db.findOne('schools', { id: client.schoolId })).status), 'suspended');

    const admit = await call('/people/students', { firstName: 'Notun', gender: 'male', dateOfBirth: '2014-01-01', classId: client.classId, admissionDate: '2025-01-05' }, 'POST', client.cookie);
    assert.equal(admit.status, 403, 'no new work');
    assert.equal(admit.body.code, 'school_suspended');

    const register = await call('/people/students', null, 'GET', client.cookie);
    assert.equal(register.status, 200, 'the register is still readable');
    const after = rows(register.body);
    assert.equal(after, beforeCount, 'and unchanged');
    assert.equal((await call('/fees/overview', null, 'GET', client.cookie)).status, 200, 'so are the fees');
    // being suspended does not lock anybody out of the building
    assert.equal((await call('/auth/me', null, 'GET', client.cookie)).status, 200);
    assert.equal((await login('head@shapla.test', 'shapla-pass-1')).length > 0, true);

    // and the switch goes back
    await api(`/owner/schools/${client.schoolId}/status`, { status: 'active' });
    const admitted = await call('/people/students', { firstName: 'Notun', gender: 'male', dateOfBirth: '2014-01-01', classId: client.classId, admissionDate: '2025-01-05' }, 'POST', client.cookie);
    assert.equal(admitted.status, 200, 'new work resumes');
  });

  test('the vendor\'s own school cannot be suspended', async () => {
    const r = await call(`/owner/schools/${hq.schoolId}/status`, { status: 'suspended' }, 'POST');
    assert.equal(r.status, 409);
    assert.equal(String((await app.db.findOne('schools', { id: hq.schoolId })).status), 'active');
  });

  // ---------------------------------------------------------------- the numbers
  test('the overview\'s counts and MRR match the rows', async () => {
    await api(`/owner/schools/${client.schoolId}/plan`, { planId: String(plans.find(p => Number(p.price_yearly) > 0).id), billingCycle: 'monthly', trialDays: 0 });
    const o = await api('/owner/overview');

    const schools = await app.db.query('SELECT id, status FROM schools WHERE deleted_at IS NULL');
    assert.equal(o.schools.total, schools.length, 'every school on the installation');
    assert.equal(o.schools.suspended, schools.filter(s => String(s.status) === 'suspended').length);
    assert.equal(o.people.students, await app.db.count('students', { status: 'active' }));

    const subs = await app.db.query(`SELECT s.billing_cycle, s.price, s.status, p.currency FROM saas_subscriptions s JOIN saas_plans p ON p.id = s.plan_id WHERE s.status IN ('active','past_due','trial')`);
    const expected = Math.round(subs.filter(s => String(s.status) === 'active')
      .reduce((t, s) => t + (String(s.billing_cycle) === 'monthly' ? Number(s.price) : Number(s.price) / 12), 0) * 100) / 100;
    assert.ok(expected > 0, 'there is revenue to check');
    assert.equal(o.mrr.amount, expected, 'MRR is the active subscriptions, monthlyised');
    assert.equal(o.mrr.currency, 'BDT');
    assert.equal(o.mrr.mixedCurrency, false);
    assert.equal(o.mrr.byCurrency.find(c => c.currency === 'BDT').mrr, expected);

    // one row per school, and the counts on it are the school's own
    const list = await api('/owner/schools?limit=200');
    const row = list.schools.find(s => s.id === client.schoolId);
    assert.equal(row.students, await app.db.count('students', { school_id: client.schoolId, status: 'active' }));
    assert.equal(row.status, 'active');
    assert.ok(row.lastActivity && row.lastActivitySource, 'and it says what "last activity" means');
    // paging and filters
    const page = await api('/owner/schools?limit=1&offset=0');
    assert.equal(page.schools.length, 1);
    assert.equal(page.total, list.total);
    assert.ok((await api('/owner/schools?q=nabin')).schools.every(s => /nabin/i.test(s.name)));
    assert.ok((await api('/owner/schools?status=active')).schools.every(s => s.status === 'active'));
  });

  test('one client in full: usage against the plan, invoices, admins, health', async () => {
    const d = await api(`/owner/schools/${provisioned.schoolId}`);
    assert.equal(d.school.id, provisioned.schoolId);
    assert.equal(d.school.name, 'Nabin Adarsha College');
    assert.ok(d.subscription && d.subscription.plan.name);
    assert.equal(d.usage.students.used, await app.db.count('students', { school_id: provisioned.schoolId, status: 'active' }));
    assert.ok('limit' in d.usage.sms && 'limit' in d.usage.storageMb);
    assert.ok(Array.isArray(d.invoices) && d.invoices.length <= 10);
    assert.ok(d.admins.length >= 1 && d.admins[0].name);
    assert.ok(d.health && Array.isArray(d.health.findings));
    assert.ok(d.counts.users >= 1);
    // reading a client's page writes nothing
    const usageRows = await app.db.count('saas_usage', { school_id: provisioned.schoolId });
    await api(`/owner/schools/${provisioned.schoolId}`);
    assert.equal(await app.db.count('saas_usage', { school_id: provisioned.schoolId }), usageRows);
    assert.equal((await call('/owner/schools/does-not-exist')).status, 404);
  });

  test('billing lists every invoice with the dunning bucket it falls in', async () => {
    const raised = await app.saas.invoice(provisioned.schoolId, { dueDays: 14 });
    saasInvoiceId = raised.id;
    // one that is well past its due date, to prove the ladder
    const old = await app.db.findOne('saas_invoices', { id: raised.id });
    await app.db.update('saas_invoices', { due_date: new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10) }, { id: raised.id });

    const b = await api('/owner/billing');
    const row = b.invoices.find(i => i.id === saasInvoiceId);
    assert.equal(row.schoolId, provisioned.schoolId);
    assert.equal(row.bucket, 'over 30 days');
    assert.ok(row.daysOverdue >= 30);
    assert.ok(b.totals.outstanding >= row.total);
    assert.ok(Array.isArray(b.partners) && Array.isArray(b.payouts));
    assert.ok((await api(`/owner/billing?schoolId=${provisioned.schoolId}`)).invoices.every(i => i.schoolId === provisioned.schoolId));

    const paid = await api(`/owner/invoices/${saasInvoiceId}/paid`, { reference: 'bank slip 4471' });
    assert.equal(paid.status, 'paid');
    assert.equal(String((await app.db.findOne('saas_invoices', { id: saasInvoiceId })).status), 'paid');
    assert.equal((await api('/owner/billing')).invoices.find(i => i.id === saasInvoiceId).bucket, 'paid');
    assert.equal(String(old.status), 'issued');
    assert.equal((await call('/owner/invoices/nope/paid', {})).status, 404);
  });

  test('support tickets across every client', async () => {
    ticketId = await app.saas.openTicket(client.schoolId, { subject: 'SMS not going out', body: 'Since Sunday.', priority: 'urgent' });
    const t = await api('/owner/tickets?status=open');
    const row = t.tickets.find(x => x.id === ticketId);
    assert.equal(row.school, 'Shapla High School');
    assert.equal(row.priority, 'urgent');
    assert.ok(t.counts.open >= 1 && t.counts.urgent >= 1);
    const closed = await api(`/owner/tickets/${ticketId}/close`, { resolution: 'Provider credentials were wrong.' });
    assert.equal(closed.status, 'closed');
    assert.ok(!(await api('/owner/tickets?status=open')).tickets.some(x => x.id === ticketId));
    assert.equal((await call('/owner/tickets/nope/close', {})).status, 404);
  });

  test('health rolls the watchdog up across the installation', async () => {
    const h = await api('/owner/health');
    assert.equal(h.totals.schools, (await app.db.query('SELECT id FROM schools WHERE deleted_at IS NULL')).length);
    assert.ok(h.schools.every(s => typeof s.ok === 'boolean' && Array.isArray(s.findings)));
    assert.ok(h.installation.engine === app.db.engine);
    // a failed job shows up against the school it failed in
    await app.db.insert('background_jobs', { id: (await import('../packages/db/dist/index.js')).ulid(), school_id: client.schoolId, queue: 'default', job_name: 'owner.test.broken', payload: null, status: 'failed', attempts: 5, max_attempts: 5, error: 'deliberate' });
    const after = await api('/owner/health');
    const row = after.schools.find(s => s.schoolId === client.schoolId);
    assert.ok(row.failedJobs >= 1);
    assert.equal(row.ok, false);
    assert.ok(row.findings.some(f => /background job/.test(f)));
    assert.ok(after.totals.unhealthy >= 1);
    assert.ok((await api('/owner/overview')).health.failedJobs >= 1);
  });

  // ---------------------------------------------------------------- the trail
  test('every write left a row in the audit log', async () => {
    const rows = await app.db.query(`SELECT action, entity_type, entity_id, actor_user_id, after_data FROM audit_logs WHERE school_id = ? AND entity_type LIKE 'owner.%' ORDER BY created_at, id`, [hq.schoolId]);
    const actions = new Set(rows.map(r => `${r.action} ${r.entity_type}`));
    for (const want of ['provision owner.school', 'status owner.school', 'plan owner.subscription', 'create owner.admin', 'reset_password owner.admin', 'paid owner.invoice', 'close owner.ticket']) {
      assert.ok(actions.has(want), `${want} is in the audit log (has: ${[...actions].join(', ')})`);
    }
    assert.ok(rows.every(r => String(r.actor_user_id) === hq.userId), 'and every one names the owner who did it');
    // the client school is told, in its own trail, what was done to it
    const theirs = await app.db.query(`SELECT action, entity_type FROM audit_logs WHERE school_id = ? AND entity_type LIKE 'owner.%'`, [client.schoolId]);
    assert.ok(theirs.some(r => String(r.action) === 'status'), 'a school can see that it was suspended');
    assert.ok(theirs.some(r => String(r.action) === 'create'), 'and that an administrator was added for it');
  });
});
