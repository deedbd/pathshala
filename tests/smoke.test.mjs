// Phase 0 exit-criterion smoke test: fresh database → installer → school + admin → rule → SMS + PDF
// end-to-end → scheduler → HTTP API. Runs on SQLite by default; set TEST_DB_URL (mysql:// or postgres://)
// to run the same test against the other engines (CI does all three).
//   pnpm smoke
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

process.env.APP_ENV = 'test';
process.env.APP_ROOT = root;
process.env.APP_URL = 'http://127.0.0.1:0';
process.env.APP_KEY = 'test-key-'.padEnd(64, 'x');
process.env.CRON_KEY = 'cron-test';
process.env.UPLOADS_DIR = 'tests/.tmp/uploads';
process.env.ADAPTERS = 'db,heartbeat,local,pdfmake,sse';
process.env.CRON_MODE = 'heartbeat';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
process.env.FONTS_DIR = 'packages/adapters/fonts';
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; }
else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const adapters = await import('../packages/adapters/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app; let schoolId; let adminId; let http; let baseUrl; let cookie;
const t0 = Date.now();

describe('phase 0 smoke', () => {
before(async () => {
  app = core.createApp({ rootDir: root });
  if (process.env.TEST_DB_URL) { // drop everything so the run is reproducible
    if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
  }
  await app.start();
});
after(async () => { http?.close(); await app?.stop(); console.log(`smoke finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

test('installer: schema + seeds (step 7)', async () => {
  assert.equal(await app.installer.isInstalled(), false);
  await app.installer.runPrepare();
  const st = await app.installer.status();
  assert.equal(st.steps.find(s => s.step === 'schema').status, 'done', JSON.stringify(st.steps));
  assert.equal(st.steps.find(s => s.step === 'seeds').status, 'done');
  const perms = await app.db.count('permissions');
  assert.ok(perms > 150, `permissions seeded: ${perms}`);
  // idempotent: running again changes nothing
  const before = await app.db.count('schema_migrations');
  await app.installer.runPrepare();
  assert.equal(await app.db.count('schema_migrations'), before);
});

test('installer: school + admin (step 8) with tenant seeds', async () => {
  const r = await app.installer.createSchool({ schoolName: 'Demo High School', schoolNameBn: 'ডেমো উচ্চ বিদ্যালয়', schoolCode: 'DEMO', institutionType: 'school', locale: 'bn', adminName: 'Abu Sayed', adminPhone: '01712345678', adminEmail: 'admin@example.com', adminPassword: 'secret-pass-1' });
  schoolId = r.schoolId; adminId = r.userId;
  assert.ok(schoolId && adminId);
  assert.equal(await app.db.count('roles', { school_id: schoolId }), 10);
  assert.equal(await app.db.count('scheduled_jobs', { school_id: schoolId }), 28);
  assert.ok((await app.db.count('automation_rules', { school_id: schoolId })) >= 30);
  assert.ok((await app.db.count('gl_accounts', { school_id: schoolId })) > 40);
  assert.ok((await app.db.count('notification_templates', { school_id: schoolId })) >= 18);
  const access = await app.rbac.accessFor(adminId);
  assert.ok(access.roles.includes('super_admin'));
  assert.ok(app.rbac.can('fees.approve', access));
});

test('auth: password login, session epoch, lockout, OTP, TOTP, JWT', async () => {
  const r = await app.auth.login({ identifier: '01712345678', password: 'secret-pass-1', platform: 'web' });
  assert.ok(r.token);
  const s = await app.auth.resolveSession(r.token);
  assert.equal(s.user.id, adminId);
  const jwt = app.auth.accessToken(s.user, r.sessionId);
  assert.equal(app.auth.verifyAccessToken(jwt).sub, adminId);
  await assert.rejects(() => app.auth.login({ identifier: 'admin@example.com', password: 'wrong' }), /wrong/);
  // logout everywhere bumps the epoch → old session dies
  await app.auth.logoutEverywhere(adminId);
  assert.equal(await app.auth.resolveSession(r.token), null);
  // OTP (test env echoes the code)
  const otp = await app.auth.issueOtp({ schoolId, target: '01712345678', channel: 'sms', purpose: 'login', userId: adminId });
  assert.match(otp.code, /^\d{6}$/);
  assert.equal(app.adapters.sms.sent.at(-1).to, '+8801712345678');
  assert.ok(app.adapters.sms.sent.at(-1).text.includes(otp.code), 'bn template rendered with code');
  const v = await app.auth.loginWithOtp({ schoolId, target: '01712345678', code: otp.code });
  assert.ok(v.token);
  // TOTP
  const totp = await app.auth.beginTotp(adminId, 'admin');
  await app.auth.confirmTotp(adminId, core.totpNow(totp.secret));
  const need = await app.auth.login({ identifier: '01712345678', password: 'secret-pass-1' });
  assert.equal(need.totpRequired, true);
  const ok = await app.auth.login({ identifier: '01712345678', password: 'secret-pass-1', totp: core.totpNow(totp.secret) });
  assert.ok(ok.token);
  await app.auth.disableTotp(adminId);
});

test('automation: rule → SMS + PDF end-to-end through outbox → relay → rule engine → queue', async () => {
  const { ulid } = await import('../packages/db/dist/index.js');
  await app.db.insert('automation_rules', { id: ulid(), school_id: schoolId, code: 'T1', name: 'Ping → SMS admins + PDF', module: 'platform', trigger_kind: 'event', event_type: 'test.ping', conditions: { '==': [{ var: 'payload.note' }, 'go'] }, actions: [{ type: 'notify', channel: 'sms', to: 'admins', body: 'Ping from {{school.name}}: {{payload.note}}' }, { type: 'job', name: 'pdf.render', queue: 'pdf', payload: { text: 'রিপোর্ট · report' } }, { type: 'task', title: 'Follow up {{payload.note}}', assignedRole: 'admin', dueInHours: 48 }], is_system: false, is_active: true, priority: 10, cooldown_minutes: 0, run_count: 0 });
  const smsBefore = app.adapters.sms.sent.length;
  await app.settings.set(schoolId, 'notifications.channels', { push: true, sms: true, email: true, in_app: true }); // the school turned SMS on
  await app.settings.set(schoolId, 'notifications.quiet_hours', null); // otherwise a night-time test run defers delivery to 07:00 Dhaka (by design)
  // condition false → skipped silently (no run row)
  await app.outbox.emitNow({ type: 'test.ping', schoolId, aggregateType: 'platform.selftest', aggregateId: 'A', payload: { at: 'x', note: 'stop' } });
  // condition true → run
  const ev = await app.outbox.emitNow({ type: 'test.ping', schoolId, aggregateType: 'platform.selftest', aggregateId: 'B', payload: { at: 'x', note: 'go' } });
  const rel = await app.relay.run();
  assert.ok(rel.published >= 2, JSON.stringify(rel));
  const runs = await app.db.query(`SELECT r.status, r.error FROM automation_runs r JOIN automation_rules a ON a.id = r.rule_id WHERE a.code = 'T1'`);
  assert.equal(runs.length, 1, JSON.stringify(runs));
  assert.equal(runs[0].status, 'success', runs[0].error);
  assert.equal(await app.db.count('event_consumptions', { event_uid: ev.uid, consumer: 'rules' }), 1);
  // notification queued for the admin → delivered by the queue
  const drained = await app.adapters.queue.drain(10);
  assert.ok(drained.ran >= 2, JSON.stringify(drained));
  assert.ok(app.adapters.sms.sent.length > smsBefore, 'sms delivered');
  assert.match(app.adapters.sms.sent.at(-1).text, /Ping from Demo High School: go/);
  const pdfJob = (await app.db.findMany('background_jobs', { school_id: schoolId, job_name: 'pdf.render' }))[0];
  assert.equal(pdfJob.status, 'success', pdfJob.error);
  const result = JSON.parse(typeof pdfJob.result === 'string' ? pdfJob.result : JSON.stringify(pdfJob.result));
  const pdfPath = path.join(root, 'tests/.tmp/uploads', result.path);
  assert.ok(fs.existsSync(pdfPath), 'pdf written to uploads');
  assert.equal(fs.readFileSync(pdfPath).subarray(0, 4).toString(), '%PDF');
  assert.equal(await app.db.count('tasks', { school_id: schoolId, status: 'open' }), 1);
  // cooldown + preview
  await app.db.update('automation_rules', { cooldown_minutes: 60 }, { code: 'T1' });
  await app.outbox.emitNow({ type: 'test.ping', schoolId, aggregateType: 'platform.selftest', aggregateId: 'B', payload: { at: 'y', note: 'go' } });
  await app.relay.run();
  const skipped = await app.db.query(`SELECT r.status FROM automation_runs r JOIN automation_rules a ON a.id = r.rule_id WHERE a.code = 'T1' AND r.status = 'skipped'`);
  assert.equal(skipped.length, 1, 'cooldown skip recorded');
});

test('queue: chunked job resumes across drains; failure alerts admins', async () => {
  const id = await app.adapters.queue.push({ name: 'batch.noop', queue: 'batch', schoolId, payload: { items: 1000, chunk: 100 } });
  const q = app.adapters.queue; const budget = q.opts.jobBudgetMs; q.opts.jobBudgetMs = -1; // force a yield after every chunk
  let guard = 0; let job;
  do { await q.drain(1); job = await app.db.findOne('background_jobs', { id }); } while (job.status !== 'success' && ++guard < 20);
  q.opts.jobBudgetMs = budget;
  assert.equal(job.status, 'success', job.error);
  assert.equal(Number(job.progress_pct), 100);
  const bad = await app.adapters.queue.push({ name: 'does.not.exist', schoolId, maxAttempts: 1 });
  await q.drain(5);
  assert.equal((await app.db.findOne('background_jobs', { id: bad })).status, 'failed');
});

test('scheduler: cron parsing, next_run_at assignment, due job runs under DB lock', async () => {
  const next = adapters.nextRun('30 10 * * 0-4', 'Asia/Dhaka', new Date('2026-09-04T12:00:00Z')); // Friday noon UTC → Sunday 10:30 Dhaka
  assert.equal(next.toISOString(), '2026-09-06T04:30:00.000Z');
  assert.equal(adapters.nextRun('*/15 * * * *', 'UTC', new Date('2026-01-01T00:07:00Z')).toISOString(), '2026-01-01T00:15:00.000Z');
  const t1 = await app.adapters.scheduler.tick();
  assert.deepEqual(t1.errors, []);
  const unscheduled = await app.db.query(`SELECT COUNT(*) AS n FROM scheduled_jobs WHERE school_id = ? AND next_run_at IS NULL`, [schoolId]);
  assert.equal(Number(unscheduled[0].n), 0, 'every seeded job has next_run_at');
  await app.db.update('scheduled_jobs', { next_run_at: '2000-01-01 00:00:00' }, { school_id: schoolId, job_key: 'platform.kpi_snapshot' });
  const t2 = await app.adapters.scheduler.tick();
  assert.ok(t2.ran.includes('platform.kpi_snapshot'), JSON.stringify(t2));
  assert.equal(await app.db.count('kpi_daily', { school_id: schoolId }), 1);
  const row = await app.db.findOne('scheduled_jobs', { school_id: schoolId, job_key: 'platform.kpi_snapshot' });
  assert.equal(row.last_status, 'success');
  assert.ok(row.next_run_at > '2026', 'rescheduled');
});

test('installer: self-test + finish (steps 9–10)', async () => {
  const r = await app.installer.runSelfTest(schoolId);
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  await app.installer.finish(schoolId);
  assert.equal(await app.installer.isInstalled(), true);
  const done = await app.db.findOne('installer_state', { step: 'done' });
  assert.equal(done.status, 'done');
});

test('http: /_health, login cookie, /api/auth/me, automation activity, /cron/tick', async () => {
  const { server } = await serverMod.createServer(app);
  await new Promise(resolve => { http = server.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${http.address().port}`;
  const health = await (await fetch(`${baseUrl}/_health`)).json();
  assert.equal(health.ok, true); assert.equal(health.installed, true);
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@example.com', password: 'secret-pass-1' }) });
  assert.equal(login.status, 200, await login.text());
  cookie = login.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).json();
  assert.equal(me.user.displayName, 'Abu Sayed');
  assert.ok(me.roles.includes('super_admin'));
  const act = await (await fetch(`${baseUrl}/api/automation/activity`, { headers: { cookie } })).json();
  assert.ok(act.runs.length >= 1 && act.scheduled.length === 28);
  assert.equal((await fetch(`${baseUrl}/api/automation/activity`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/cron/tick?key=nope`)).status, 403);
  const tick = await (await fetch(`${baseUrl}/cron/tick?key=cron-test`)).json();
  assert.ok('scheduler' in tick && 'relay' in tick && 'queue' in tick);
  assert.equal((await fetch(`${baseUrl}/api/install/status`)).status, 410, 'installer closed after install');
  const bad = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'x' }) });
  assert.equal(bad.status, 400);
});

test('settings, audit, files, custom fields, approvals', async () => {
  await core.runWithContext(core.systemContext(schoolId, { userId: adminId }), async () => {
    await app.settings.set(schoolId, 'attendance.cutoff_time', '10:45');
    assert.equal(await app.settings.get(schoolId, 'attendance.cutoff_time'), '10:45');
    const f = await app.files.store({ schoolId, data: Buffer.from('hello'), fileName: 'নোট.txt', mimeType: 'text/plain', purpose: 'test' });
    assert.ok(fs.existsSync(path.join(root, 'tests/.tmp/uploads', f.path)));
    assert.match(await app.files.url(f.id, schoolId), /\/files\/.*sig=/);
    await app.customFields.define(schoolId, { entityType: 'student', fieldKey: 'blood_group', label: 'Blood group', fieldType: 'select', options: ['A+', 'O+'] });
    await app.customFields.setValues(schoolId, 'student', 'STU1', { blood_group: 'O+' });
    assert.deepEqual(await app.customFields.getValues(schoolId, 'student', 'STU1'), { blood_group: 'O+' });
    const ap = await app.approvals.request({ schoolId, entityType: 'expense', entityId: 'EXP1', summary: { amount: 500 } });
    assert.equal(ap.status, 'approved', 'no workflow → auto-approved');
  });
  await app.relay.run();
  const audit = await app.audit.recent(schoolId, 100);
  assert.ok(audit.some(a => a.action === 'login') && audit.some(a => a.action === 'create'));
  assert.ok((await app.db.count('outbox_events', { school_id: schoolId, published_at: null })) === 0, 'outbox drained');
});
});
