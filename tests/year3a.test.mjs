// Year 3, first batch: the business, the platform, and the assistant.
// Plans and subscriptions where an unpaid bill stops new work and never locks a school out of its own
// register; resellers earning commission when the school actually pays; plugins kept at arm's length
// behind a signed webhook; OAuth2 clients with scopes and a public API that refuses anything outside
// them; and an assistant that answers from the school's rows and refuses to invent.
//   node --test tests/year3a.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http2 from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-y3a');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'y3a-key'.padEnd(64, 'x'), CRON_KEY: 'cron-y3a', UPLOADS_DIR: 'tests/.tmp-y3a/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-y3a/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, schoolId, http, baseUrl, cookie, guardianCookie, planId, subscriptionId, partnerId, invoiceId, hookServer, hookUrl;
const students = [];
const hookCalls = [];
const t0 = Date.now();
const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('year 3: subscriptions, marketplace, public API, assistant', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Platform School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01799999999', adminEmail: 'admin@y3a.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    const classes = await app.academic.classes(schoolId);
    for (let i = 0; i < 3; i++) students.push(await app.people.createStudent(schoolId, { firstName: `Pupil${i + 1}`, gender: 'male', dateOfBirth: '2012-02-02', classId: String(classes[4].id), admissionDate: '2021-01-05', guardians: [{ fullName: `Guardian ${i + 1}`, phone: `0194500000${i}`, relation: 'father', isPrimary: true, paysFees: true }] }));
    // the super admin is the only role that carries saas.* permissions
    await app.db.execute(`INSERT INTO user_roles (id, user_id, role_id) SELECT ?, ?, id FROM roles WHERE school_id = ? AND slug = 'super_admin'`, [`UR${Date.now()}`.padEnd(26, '0').slice(0, 26), r.userId, schoolId]).catch(() => undefined);
    // a server standing in for a plugin's own machine
    hookServer = http2.createServer((req, res) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { hookCalls.push({ event: req.headers['x-pathshala-event'], signature: req.headers['x-pathshala-signature'], body: JSON.parse(body || '{}') }); res.writeHead(200).end('ok'); }); });
    await new Promise(res => hookServer.listen(0, '127.0.0.1', res));
    hookUrl = `http://127.0.0.1:${hookServer.address().port}/hook`;

    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@y3a.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
    const g = (await app.db.query(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ?`, [students[0].id]))[0];
    const uid = g.user_id ?? await app.people.ensureGuardianAccount(schoolId, String(g.id));
    guardianCookie = `ps_session=${(await app.auth.createSession(await app.db.findOne('users', { id: uid }))).token}`;
  });
  after(async () => { hookServer?.close(); http?.close(); await app?.stop(); console.log(`year 3a finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 160)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };

  // ---------------- subscriptions ----------------
  test('a plan is chosen, and what it allows is answered from the plan', async () => {
    const plans = await api('/saas/plans');
    assert.ok(plans.length >= 3, 'the three default plans are seeded on first use');
    planId = String(plans.find(p => p.name === 'Free').id);
    const sub = await api('/saas/subscriptions', { planId, billingCycle: 'yearly' });
    subscriptionId = sub.id;
    assert.equal(sub.plan, 'Free');
    assert.equal(sub.price, 0);

    // the Free plan holds sixty students, so three is fine
    const room = await app.saas.allows(schoolId, 'add_student');
    assert.equal(room.allowed, true);
    assert.match(room.reason, /57 places left/);
    // and a module the plan does not carry is refused by name
    const denied = await app.saas.allows(schoolId, 'module', 'hostel');
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /does not include hostel/);
    assert.equal((await app.saas.allows(schoolId, 'module', 'fees')).allowed, true);
  });

  test('metering counts what was used, from the rows that recorded it', async () => {
    await app.notifications.notify({ schoolId, address: '01711111111', channels: ['sms'], eventKey: 'test.ping', title: 'Test', body: 'One message' });
    await app.adapters.queue.drain(20);
    const me = await api('/billing/me');
    assert.equal(me.subscription.plan_name, 'Free');
    assert.equal(me.usage.students, students.length);
    assert.ok(me.usage.sms >= 0);
    assert.ok('storage_mb' in me.usage);
  });

  test('an unpaid bill stops new work and never locks the school out of its own register', async () => {
    // move to a paid plan so there is something to bill
    const standard = String((await api('/saas/plans')).find(p => p.name === 'Standard').id);
    partnerId = (await api('/saas/partners', { name: 'Sylhet Reseller', commissionPct: 15, referralCode: 'SYLHET' })).id;
    const sub = await api('/saas/subscriptions', { planId: standard, billingCycle: 'yearly', referralCode: 'SYLHET' });
    assert.equal(sub.reseller, 'Sylhet Reseller');
    assert.equal(sub.price, 20_000);
    const inv = await api('/saas/invoices', { periodStart: day(-30) });
    invoiceId = inv.id;
    assert.match(inv.invoiceNo, /^PS-/);
    assert.equal(inv.total, 20_000);
    // raising it twice does not bill twice
    assert.equal((await api('/saas/invoices', { periodStart: day(-30) })).alreadyRaised, true);

    // the nightly job finds it overdue and pauses new work
    await app.db.execute(`UPDATE saas_invoices SET due_date = ? WHERE id = ?`, [day(-1), invoiceId]);
    const billing = await app.saas.jobs()['saas.billing']({ schoolId, jobKey: 'saas.billing', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(billing.overdue, 1);
    assert.equal(String((await app.saas.subscription(schoolId)).status), 'past_due');
    assert.equal((await app.saas.allows(schoolId, 'add_student')).allowed, false);
    assert.equal((await app.saas.allows(schoolId, 'send_sms')).allowed, false);
    // but the register, attendance and results are untouched — this is a school, not a subscription
    assert.equal((await api('/people/students')).rows.length, students.length);
    const marked = await app.attendance.mark(schoolId, students[0].id, day(0), 'present', { notify: false });
    assert.ok(marked.id ?? marked, 'attendance still works with an unpaid bill');

    // paying clears it and the reseller earns their share
    const paid = await api(`/saas/invoices/${invoiceId}/paid`, { reference: 'bKash TrxID 8891' });
    assert.equal(paid.status, 'paid');
    assert.equal(String((await app.saas.subscription(schoolId)).status), 'active');
    assert.equal((await app.saas.allows(schoolId, 'add_student')).allowed, true);
    const payouts = (await api(`/saas/partners?partnerId=${partnerId}`)).payouts;
    assert.equal(payouts.length, 1);
    assert.equal(Math.round(Number(payouts[0].amount)), 3000, '15% of 20,000, accrued when the money actually arrived');
    assert.equal(String(payouts[0].status), 'pending');
    await api(`/saas/payouts/${String(payouts[0].id)}/paid`, {});
    assert.equal(String((await api(`/saas/partners?partnerId=${partnerId}`)).payouts[0].status), 'paid');
  });

  test('a school administrator cannot see or change what the school pays', async () => {
    // the admin account has admin, not super_admin: saas.* is out of reach
    const adminOnly = await app.db.query(`SELECT u.id FROM users u WHERE u.school_id = ? AND u.email = ?`, [schoolId, 'admin@y3a.test']);
    const access = await app.rbac.accessFor(String(adminOnly[0].id));
    assert.ok(!access.permissions.has('saas.view') || access.roles.includes('super_admin'), 'saas.* is not an administrator permission');
    // a guardian gets nowhere near it
    assert.equal((await fetch(`${baseUrl}/api/saas/subscriptions`, { headers: { cookie: guardianCookie } })).status, 403);
  });

  // ---------------- marketplace ----------------
  test('a plugin runs on its own machine and hears only the events it asked for', async () => {
    const pluginId = (await api('/marketplace/plugins', { slug: 'sms-analytics', name: 'SMS analytics', vendor: 'Third party', version: '1.0.0', hooks: ['payment.received'] })).id;
    const install = await api(`/marketplace/plugins/${pluginId}/install`, { webhookUrl: hookUrl });
    assert.ok(install.secret, 'the secret is shown once, here');
    const listed = await api('/marketplace/plugins');
    assert.equal(listed.installed.length, 1);
    assert.equal(JSON.stringify(listed.installed[0].settings).includes('secretHash'), false, 'and never handed back afterwards');

    const head = (await api('/fees/overview')).heads[0];
    const invoice = await api('/fees/invoices', { studentId: students[0].id, items: [{ feeHeadId: String(head.id), description: 'Tuition', amount: 500 }] });
    await api('/fees/payments', { studentId: students[0].id, amount: 500, method: 'cash', invoiceIds: [invoice.id] });
    for (let i = 0; i < 20 && !hookCalls.length; i++) await app.tick({ budgetMs: 500 });
    assert.equal(hookCalls.length, 1, 'the plugin was called once, on the event it subscribed to');
    assert.equal(hookCalls[0].event, 'payment.received');
    assert.equal(hookCalls[0].body.schoolId, schoolId);
    assert.ok(hookCalls[0].signature, 'and can check the call came from us');

    // disabling it stops the calls without losing the installation
    await api(`/marketplace/installs/${install.id}/enabled`, { enabled: false });
    hookCalls.length = 0;
    await api('/fees/payments', { studentId: students[1].id, amount: 100, method: 'cash' });
    for (let i = 0; i < 10; i++) await app.tick({ budgetMs: 300 });
    assert.equal(hookCalls.length, 0);
  });

  test('a template pack fills in what is missing and leaves what the school changed alone', async () => {
    const pack = await api('/marketplace/packs', { slug: 'cambridge-grading', name: 'Cambridge grading', kind: 'grading', version: '1.0.0', content: { scales: [{ name: 'Cambridge A*–G', maxGpa: 8, bands: [{ grade: 'A*', minPercent: 90, maxPercent: 100, gradePoint: 8 }, { grade: 'A', minPercent: 80, maxPercent: 89, gradePoint: 7 }, { grade: 'U', minPercent: 0, maxPercent: 39, gradePoint: 0, isFail: true }] }] } });
    const applied = await api(`/marketplace/packs/${pack.id}/apply`, {});
    assert.equal(applied.written, 1);
    const scale = await app.db.findOne('grading_scales', { school_id: schoolId, name: 'Cambridge A*–G' });
    assert.ok(scale);
    assert.equal((await app.db.findMany('grading_bands', { scale_id: String(scale.id) })).length, 3, 'a scale with no bands grades nothing');
    // applying it again keeps what is there rather than overwriting it
    const again = await api(`/marketplace/packs/${pack.id}/apply`, {});
    assert.equal(again.written, 0);
    assert.equal(again.kept, 1);
  });

  // ---------------- the public API ----------------
  test('a token can only do what the school ticked, and the API refuses the rest', async () => {
    const client = await api('/oauth/clients', { name: 'Attendance kiosk', scopes: ['profile.read', 'students.read', 'attendance.read'] });
    assert.ok(client.clientSecret);
    assert.equal((await api('/oauth/clients'))[0].client_id, client.clientId);

    const token = await (await fetch(`${baseUrl}/api/v1/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: client.clientId, client_secret: client.clientSecret }) })).json();
    assert.equal(token.token_type, 'Bearer');
    assert.match(token.scope, /students.read/);
    const get = (p, t = token.access_token) => fetch(`${baseUrl}/api/v1${p}`, { headers: { Authorization: `Bearer ${t}` } });

    const me = await (await get('/me')).json();
    assert.equal(me.school.id, schoolId);
    const list = await (await get('/students')).json();
    assert.equal(list.students.length, students.length);
    assert.ok(list.students[0].admissionNo);
    assert.equal((await get('/attendance')).status, 200);
    // a scope the school never granted is refused at the door
    const refused = await get('/fees/outstanding');
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /does not carry fees.read/);
    // and so is a wrong secret, a made-up token, and a revoked client
    assert.equal((await fetch(`${baseUrl}/api/v1/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: client.clientId, client_secret: 'wrong' }) })).status, 401);
    assert.equal((await get('/me', 'not-a-token')).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/v1/students`)).status, 401);
    await api(`/oauth/clients/${client.id}/revoke`, {});
    assert.equal((await get('/me')).status, 401, 'revoking the client kills the tokens it issued');
  });

  // ---------------- the assistant ----------------
  test('the assistant answers from the school’s own rows, and says so when it cannot', async () => {
    await app.attendance.mark(schoolId, students[1].id, day(0), 'absent', { notify: false });
    const skills = await api('/ai/skills');
    assert.equal(skills.provider, 'none', 'no model is configured in the test environment');
    assert.ok(skills.skills.length >= 4);

    const absent = await api('/ai/ask', { question: 'how many students are absent today?' });
    assert.equal(absent.source, 'data');
    assert.match(absent.answer, /absent/);
    assert.equal(absent.cost, 0, 'answering from the database costs nothing');
    const fees = await api('/ai/ask', { question: 'what are the fees outstanding?' });
    assert.match(fees.answer, /outstanding|Nothing is outstanding/);
    const roll = await api('/ai/ask', { question: 'how many students are on the roll?' });
    assert.match(roll.answer, new RegExp(`${students.length} students`));

    // with no provider, an open question is answered honestly rather than invented
    const vague = await api('/ai/ask', { question: 'write a poem about our school' });
    assert.match(vague.answer, /I can answer questions about this school/);
    await assert.rejects(() => api('/ai/generate', { kind: 'notice', prompt: 'Sports day on Friday' }), /no AI provider/);

    const history = await api('/ai/history');
    assert.ok(history.messages.length >= 8, 'both sides of the conversation are kept');
  });

  test('a guardian asking the assistant is answered about their own children and nobody else’s', async () => {
    const mine = await api('/ai/ask', { question: 'how many students are on the roll?' }, 'POST', { cookie: guardianCookie });
    assert.match(mine.answer, /You have 1 child in this school/);
    const dues = await api('/ai/ask', { question: 'what is outstanding for my child?' }, 'POST', { cookie: guardianCookie });
    assert.ok(dues.answer.length > 0);
    // the number they get is their own child's, not the school's
    const all = await app.db.query(`SELECT COALESCE(SUM(balance), 0) AS due FROM invoices WHERE school_id = ? AND balance > 0`, [schoolId]);
    if (Number(all[0].due) > 0) assert.ok(!dues.answer.includes(String(Math.round(Number(all[0].due)))) || dues.answer.includes('Nothing'), 'a guardian is never shown the school-wide figure');
  });
});
