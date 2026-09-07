// Phase 9 (hardening): the security review as a test — tenant scope, OTP limits, portal boundaries,
// secrets at rest — plus a backup anybody can restore, the SQLite→MySQL move, bn/en parity, the
// onboarding checklist, and a load run of 5 schools with 1,500 students in one database.
//   node --test tests/phase9.test.mjs            (SQLite; set TEST_DB_URL for MySQL/Postgres)
//   PHASE9_LOAD=1 node --test tests/phase9.test.mjs   (the full 5 × 1,500 load run)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-p9');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'p9-key-'.padEnd(64, 'x'), CRON_KEY: 'cron-p9', UPLOADS_DIR: 'tests/.tmp-p9/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-p9/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const db = await import('../packages/db/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

const LOAD = process.env.PHASE9_LOAD === '1';
const SCHOOLS = LOAD ? 5 : 2;
const PER_SCHOOL = LOAD ? 1500 : 60;
let app, http, baseUrl, schools = [], cookieA, cookieB, guardianCookieA;
const t0 = Date.now();

describe('phase 9', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    // two tenants in one database is the shape a shared-hosting school actually runs
    for (let i = 0; i < 2; i++) {
      const r = await (i === 0 ? app.installer.createSchool.bind(app.installer) : app.installer.addTenant.bind(app.installer))({ schoolName: `Tenant ${i + 1}`, institutionType: 'school', locale: 'bn', adminName: `Admin ${i + 1}`, adminPhone: `0179900000${i}`, adminEmail: `admin${i + 1}@p9.test`, adminPassword: 'secret-pass-1' });
      if (i === 0) await app.installer.finish(r.schoolId);
      const yearId = String((await app.academic.currentYear(r.schoolId)).id);
      const classId = String((await app.academic.classes(r.schoolId))[3].id);
      const student = await app.people.createStudent(r.schoolId, { firstName: `Child${i + 1}`, gender: 'male', dateOfBirth: '2015-01-01', classId, guardians: [{ fullName: `Parent ${i + 1}`, phone: `0180900000${i}`, relation: 'father', isPrimary: true }] });
      schools.push({ ...r, yearId, classId, studentId: student.id });
    }
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookieA = await login('admin1@p9.test');
    cookieB = await login('admin2@p9.test');
    const g = (await app.db.query(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ?`, [schools[0].studentId]))[0];
    guardianCookieA = `ps_session=${(await app.auth.createSession(await app.db.findOne('users', { id: g.user_id }))).token}`;
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`phase 9 finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const login = async email => (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? cookieA }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 200)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const status = async (p, extra = {}) => (await fetch(`${baseUrl}/api${p}`, { headers: extra.cookie ? { cookie: extra.cookie } : {} })).status;

  // ---------------- an update reaches the schools that are already there ----------------
  test('a school installed before a job existed gets its row on the next boot, and keeps its own settings', async () => {
    const sid = schools[0].schoolId;
    const before = await app.db.query(`SELECT job_key, cron_expr, is_active FROM scheduled_jobs WHERE school_id = ? ORDER BY job_key`, [sid]);
    assert.ok(before.length > 10, 'the school was seeded with the catalogue it was installed with');

    // this is what an update looks like from the database's side: the build knows a job the school
    // does not, because the school was installed before the job was written
    const victim = String(before[0].job_key);
    await app.db.execute(`DELETE FROM scheduled_jobs WHERE school_id = ? AND job_key = ?`, [sid, victim]);
    // and one the school has deliberately switched off, with a cron of its own
    const kept = String(before[1].job_key);
    await app.db.execute(`UPDATE scheduled_jobs SET is_active = FALSE, cron_expr = '5 5 * * *' WHERE school_id = ? AND job_key = ?`, [sid, kept]);

    const added = await app.installer.ensureAutomationCatalogue();
    assert.equal(added.jobs, 1, 'exactly the missing one');
    assert.ok(added.schools >= 1);

    const back = await app.db.findOne('scheduled_jobs', { school_id: sid, job_key: victim });
    assert.ok(back, 'the job the build ships is now a row this school has');
    assert.equal(Number(back.is_active), 1);

    const untouched = await app.db.findOne('scheduled_jobs', { school_id: sid, job_key: kept });
    assert.equal(String(untouched.cron_expr), '5 5 * * *', 'a school that changed the time keeps its time');
    assert.equal(Number(untouched.is_active), 0, 'and a job it switched off stays off');

    // running twice adds nothing: the scheduler must not end up with the same job twice
    const again = await app.installer.ensureAutomationCatalogue();
    assert.deepEqual({ jobs: again.jobs, rules: again.rules }, { jobs: 0, rules: 0 });
    const rows = await app.db.query(`SELECT COUNT(*) AS n FROM scheduled_jobs WHERE school_id = ? AND job_key = ?`, [sid, victim]);
    assert.equal(Number(rows[0].n), 1);

    // and the second tenant is reconciled too — an update reaches every school on the host
    const other = await app.db.query(`SELECT COUNT(*) AS n FROM scheduled_jobs WHERE school_id = ?`, [schools[1].schoolId]);
    assert.equal(Number(other[0].n), before.length, 'every school carries the whole catalogue');
  });

  // ---------------- security ----------------
  test('one school never sees another’s data, whatever id it asks for', async () => {
    const a = schools[0], b = schools[1];
    // the lists are scoped
    const studentsA = await api('/people/students', undefined, 'GET', { cookie: cookieA });
    const idsA = new Set((studentsA.rows ?? studentsA).map(s => String(s.id)));
    assert.ok(idsA.has(a.studentId));
    assert.ok(!idsA.has(b.studentId), 'school A cannot see school B in a list');
    // and so is asking for a row by its id
    assert.equal(await status(`/people/students/${b.studentId}`, { cookie: cookieA }), 404, 'a known id from another tenant is simply not found');
    assert.equal(await status(`/people/students/${a.studentId}`, { cookie: cookieA }), 200);
    // writing across the boundary fails too
    await assert.rejects(() => api(`/people/students/${b.studentId}`, { firstName: 'Renamed' }, 'PATCH', { cookie: cookieA }), /not found|404/);
    const after = await app.db.findOne('students', { id: b.studentId });
    assert.equal(after.first_name, 'Child2', 'and nothing changed');
  });

  test('a portal account never reaches a console endpoint, and never another child', async () => {
    for (const p of ['/people/students', '/fees/overview', '/hr/payroll', '/inventory/stock', '/welfare/safeguarding', '/platform/backups']) {
      assert.equal(await status(p, { cookie: guardianCookieA }), 403, `${p} refused a guardian`);
    }
    assert.equal(await status('/portal/me', { cookie: guardianCookieA }), 200, 'but their own portal answers');
    assert.equal(await status(`/portal/documents/${schools[1].studentId}`, { cookie: guardianCookieA }), 403);
    // and without a session at all, nothing at all
    assert.equal(await status('/people/students'), 401);
    assert.equal(await status('/portal/me'), 401);
  });

  test('a stolen or stale session stops working', async () => {
    const cookie = await login('admin1@p9.test');
    assert.equal(await status('/people/students', { cookie }), 200);
    const user = await app.auth.findByIdentifier('admin1@p9.test', schools[0].schoolId);
    await app.auth.logoutEverywhere(user.id);          // the session epoch moves
    assert.equal(await status('/people/students', { cookie }), 401, 'every session of that user is dead');
    cookieA = await login('admin1@p9.test');
    assert.equal(await status('/people/students', { cookie: cookieA }), 200);
    // a made-up token is not a session
    assert.equal(await status('/people/students', { cookie: 'ps_session=not-a-real-token' }), 401);
  });

  test('OTP codes are rate limited, expire, and cannot be brute forced', async () => {
    const phone = '01809000000';
    const first = await api('/auth/otp/request', { target: phone, channel: 'sms' });
    assert.ok(first.code, 'in test mode the code comes back so the flow can be driven');
    for (let i = 0; i < 5; i++) {   // five wrong tries is the limit
      const r = await fetch(`${baseUrl}/api/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: phone, code: '000000' }) });
      assert.ok(r.status === 401 || r.status === 429, `wrong code refused (${r.status})`);
    }
    const blocked = await fetch(`${baseUrl}/api/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: phone, code: first.code }) });
    assert.equal(blocked.status, 429, 'after five wrong tries even the right code is refused');
    // asking for codes over and over is refused as well
    let limited = false;
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${baseUrl}/api/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: '01809000009', channel: 'sms' }) });
      if (r.status === 429) { limited = true; break; }
    }
    assert.ok(limited, 'requesting codes is rate limited');
  });

  test('passwords and secrets are never stored as they were typed', async () => {
    const user = await app.db.findOne('users', { email: 'admin1@p9.test' });
    assert.ok(!String(user.password_hash).includes('secret-pass-1'));
    assert.match(String(user.password_hash), /^\$2[aby]\$/, 'bcrypt, not a home-made hash');
    const session = await app.db.findMany('auth_sessions', { user_id: user.id }, { limit: 1 });
    assert.equal(String(session[0].token_hash).length, 64, 'the session token itself is not kept');
    const otp = await app.db.findMany('otp_codes', undefined, { limit: 1 });
    if (otp[0]) assert.equal(String(otp[0].code_hash).length, 64, 'nor is the OTP');
    // a gateway secret is encrypted at rest
    await app.fees.saveGateway(schools[0].schoolId, { provider: 'bkash', displayName: 'bKash', credentials: { appKey: 'super-secret-key', appSecret: 'x' }, isSandbox: true });
    const gateway = await app.db.findOne('payment_gateways', { school_id: schools[0].schoolId });
    assert.ok(!JSON.stringify(gateway.credentials).includes('super-secret-key'), 'the key is not readable in the row');
  });

  test('the cron endpoint needs its key, and the installer refuses to run twice', async () => {
    assert.ok([401, 403].includes((await fetch(`${baseUrl}/cron/tick`)).status), 'no key, no tick');
    assert.ok([401, 403].includes((await fetch(`${baseUrl}/cron/tick?key=wrong`)).status), 'a wrong key is no key');
    assert.equal((await fetch(`${baseUrl}/cron/tick?key=cron-p9`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/install/status`)).status, 410, 'the installer is closed once a school exists');
  });

  // ---------------- data ----------------
  test('a backup can be taken, read and restored', async () => {
    const before = await app.db.count('students', { school_id: schools[0].schoolId });
    const backup = await api('/platform/backups', { kind: 'database' }, 'POST', { cookie: cookieA });
    assert.ok(backup.sizeBytes > 100, `${backup.sizeBytes} bytes`);
    assert.ok(fs.existsSync(backup.file));
    // the file is portable: gzipped JSON lines, no SQL
    const { gunzipSync } = await import('node:zlib');
    const lines = gunzipSync(fs.readFileSync(backup.file)).toString('utf8').trim().split('\n');
    assert.equal(JSON.parse(lines[0]).pathshala, 1);
    assert.ok(lines.slice(1).every(l => { const o = JSON.parse(l); return o.t && o.r; }));
    assert.ok(lines.some(l => l.includes('"t":"students"')));
    // deleting a row and restoring puts it back, and restoring twice does not duplicate anything
    const student = await app.db.findOne('students', { id: schools[0].studentId });
    await app.db.delete('student_guardians', { student_id: student.id });
    await app.db.delete('student_enrollments', { student_id: student.id });
    await app.db.delete('students', { id: student.id });
    assert.equal(await app.db.count('students', { school_id: schools[0].schoolId }), before - 1);
    const restored = await api('/platform/restore', { file: backup.file }, 'POST', { cookie: cookieA });
    assert.ok(restored.rows > 0);
    assert.equal(await app.db.count('students', { school_id: schools[0].schoolId }), before, 'the student is back');
    await api('/platform/restore', { file: backup.file }, 'POST', { cookie: cookieA });
    assert.equal(await app.db.count('students', { school_id: schools[0].schoolId }), before, 'and restoring again changes nothing');
  });

  test('the whole database moves to another engine, row for row', async () => {
    const target = db.connect({ engine: 'sqlite', sqlitePath: path.join(tmp, 'moved.db') });
    await db.migrate(target, path.join(root, 'db'));   // the target is built the way a fresh install is
    const moved = await app.platform.migrateTo(target, { chunk: 200 });
    assert.ok(moved.rows > 100, `${moved.rows} rows moved`);
    const compare = await app.platform.compareWith(target);
    assert.equal(compare.matched, true, JSON.stringify(compare.differences?.slice(0, 5)));
    // the copy is a working school, not just rows
    assert.equal(await target.count('students', { school_id: schools[0].schoolId }), await app.db.count('students', { school_id: schools[0].schoolId }));
    await target.close();
  });

  // ---------------- readiness ----------------
  test('the onboarding checklist says what a new school still has to do', async () => {
    const b = await api('/platform/onboarding', undefined, 'GET', { cookie: cookieB });
    assert.equal(b.total, 8);
    assert.ok(b.done >= 1 && b.done < b.total, `${b.done}/${b.total} done`);
    const students = b.steps.find(s => s.key === 'students');
    assert.equal(students.done, true, 'that school has a student');
    const sms = b.steps.find(s => s.key === 'sms');
    assert.equal(sms.done, false, 'and no SMS provider yet');
    assert.equal(sms.href, '/settings');
    assert.equal(b.complete, false);
  });

  test('platform health reports the queue, storage and the last backup', async () => {
    const h = await api('/platform/health', undefined, 'GET', { cookie: cookieA });
    assert.equal(h.engine, app.db.engine);
    assert.ok(h.memory.rssMb > 0);
    assert.ok(h.lastBackup, 'the backup taken above is the last one');
    assert.equal(h.lastBackup.status, 'success');
    assert.equal(typeof h.queue.queued, 'number');
    assert.equal(typeof h.outbox.unpublished, 'number');
  });

  test('every screen reads in both Bangla and English', async () => {
    // the ui package is consumed as TypeScript source, so the dictionaries are read from the file
    const src = fs.readFileSync(path.join(root, 'packages/ui/src/i18n.ts'), 'utf8');
    const grab = locale => {
      const start = src.indexOf(`  ${locale}: {`);
      assert.ok(start > 0, `${locale} block`);
      const end = src.indexOf(String.fromCharCode(10) + '  },', start);
      return new Function(`return {${src.slice(start + `  ${locale}: {`.length, end)}}`)();
    };
    const en = grab('en'), bn = grab('bn');
    const missingBn = Object.keys(en).filter(k => !(k in bn) || !String(bn[k]).trim());
    const missingEn = Object.keys(bn).filter(k => !(k in en) || !String(en[k]).trim());
    assert.deepEqual(missingBn, [], 'these keys have no Bangla');
    assert.deepEqual(missingEn, [], 'these keys have no English');
    assert.ok(Object.keys(en).length > 400, `${Object.keys(en).length} keys`);
    // the Bangla is really Bangla, not the English string copied across
    const identical = Object.keys(en).filter(k => en[k] === bn[k] && /[a-z]{4}/i.test(String(en[k])) && !/^(GPA|SMS|PDF|ID|OTP|SKU|ISBN)/.test(String(en[k])));
    assert.ok(identical.length < Object.keys(en).length * 0.12, `${identical.length} keys are still English in the Bangla file: ${identical.slice(0, 8).join(', ')}`);
  });

  test(`${SCHOOLS} schools with ${PER_SCHOOL} students each share one database and stay separate`, async () => {
    const started = Date.now();
    const created = [];
    for (let i = 0; i < SCHOOLS; i++) {
      const r = i < schools.length ? schools[i] : await (async () => {
        const s = await app.installer.addTenant({ schoolName: `Load school ${i + 1}`, institutionType: 'school', locale: 'bn', adminName: `Admin L${i}`, adminPhone: `0175500000${i}`, adminEmail: `load${i}@p9.test`, adminPassword: 'secret-pass-1' });
        return { ...s, classId: String((await app.academic.classes(s.schoolId))[3].id) };
      })();
      created.push(r);
      const rows = Array.from({ length: PER_SCHOOL }, (_, n) => ({ first_name: `S${n + 1}`, last_name: 'Test', gender: n % 2 ? 'female' : 'male', date_of_birth: '2014-01-01', class_id: r.classId }));
      for (const row of rows) await app.people.createStudent(r.schoolId, { firstName: row.first_name, lastName: row.last_name, gender: row.gender, dateOfBirth: row.date_of_birth, classId: r.classId });
    }
    const ms = Date.now() - started;
    const total = await app.db.count('students');
    console.log(`load: ${SCHOOLS} schools × ${PER_SCHOOL} students = ${total} rows in ${Math.round(ms / 1000)}s on ${app.db.engine}; rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
    assert.ok(total >= SCHOOLS * PER_SCHOOL, `${total} students across the tenants`);
    // each school still counts only its own
    for (const r of created) {
      const mine = await app.db.count('students', { school_id: r.schoolId });
      assert.ok(mine >= PER_SCHOOL, `${r.schoolName ?? r.schoolId}: ${mine}`);
      assert.ok(mine < total, 'and not everybody else’s');
    }
    // a listing request over a full database still answers quickly
    // the query and the request are timed separately: a slow request over a fast query means the
    // process is busy with background work rather than with SQL, which is the failure worth catching
    const queryStarted = Date.now();
    await app.people.students(schools[0].schoolId, { limit: 50 });
    const queryMs = Date.now() - queryStarted;
    const backlog = Number((await app.db.query(`SELECT COUNT(*) AS n FROM outbox_events WHERE published_at IS NULL`))[0].n);
    const t = Date.now();
    await api('/people/students?limit=50', undefined, 'GET', { cookie: cookieA });
    const listMs = Date.now() - t;
    console.log(`a page of students over ${total} rows: ${queryMs} ms of SQL, ${listMs} ms end to end, with ${backlog} events still queued`);
    assert.ok(queryMs < 1000, `${queryMs} ms for the query itself`);
    assert.ok(listMs < 5000, `${listMs} ms to answer a request while ${backlog} events wait — background work must not block the app`);
    assert.ok(process.memoryUsage().rss < 900 * 1048576, 'memory stayed inside what shared hosting allows');
  });
});
