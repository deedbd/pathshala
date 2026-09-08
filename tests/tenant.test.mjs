// A school reachable at an address of its own.
//
// What this proves: a slug is generated for a school that never had one and does not change on the
// second boot; two schools whose names look alike get different slugs; `/saranjai/...` resolves to
// that school and `/other/...` to the other; a custom domain resolves at the root of its own host;
// a reserved word and a domain another school already holds are both refused; a session for school A
// gets a 404 on school B's API; the vendor's console is a 404 on a tenant's domain and under a slug;
// and the domain watch reports a change once rather than nightly.
//   node --test tests/tenant.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeHttp from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-tenant');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'tenant-key'.padEnd(64, 'x'), CRON_KEY: 'cron-tenant', OWNER_DOOR: 'test-door-4t7v1n', UPLOADS_DIR: 'tests/.tmp-tenant/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
delete process.env.CPANEL_URL; delete process.env.CPANEL_USER; delete process.env.CPANEL_API_TOKEN;
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-tenant/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, listener, port, baseUrl;
let hq, saranjai, shapla;              // { schoolId, userId, cookie }
const t0 = Date.now();

describe('one installation, a school at each address', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    // the vendor's own school: the installation's oldest, which is what makes it the founder
    hq = await app.installer.createSchool({ schoolName: 'Pathshala HQ School', institutionType: 'school', locale: 'en', adminName: 'The Owner', adminPhone: '01700000201', adminEmail: 'owner@vendor.test', adminPassword: 'owner-pass-1' });
    await app.installer.finish(hq.schoolId);
    // a school whose name is written in Bangla, and another whose name looks very much like it
    saranjai = await app.installer.addTenant({ schoolName: 'সরনজাই বালিকা উচ্চ বিদ্যালয়', institutionType: 'school', locale: 'bn', adminName: 'Saranjai Head', adminPhone: '01700000202', adminEmail: 'head@saranjai.test', adminPassword: 'saranjai-pass-1' });
    shapla = await app.installer.addTenant({ schoolName: 'Shapla High School', institutionType: 'school', locale: 'bn', adminName: 'Shapla Head', adminPhone: '01700000203', adminEmail: 'head@shapla.test', adminPassword: 'shapla-pass-1' });
    for (const s of [hq, saranjai, shapla]) await app.settings.set(s.schoolId, 'notifications.quiet_hours', null);

    const { server } = await serverMod.createServer(app);
    await new Promise(res => { listener = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(listener);
    port = listener.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
    for (const [who, email, pass] of [[hq, 'owner@vendor.test', 'owner-pass-1'], [saranjai, 'head@saranjai.test', 'saranjai-pass-1'], [shapla, 'head@shapla.test', 'shapla-pass-1']]) who.cookie = await login(email, pass);
    // this installation is a vendor's, which on a real one happens the first time somebody comes
    // through the owner door; a school-only installation never has an owner at all
    await app.owner.claimOwnership(await app.db.findOne('users', { email: 'owner@vendor.test' }));
  });
  after(async () => { listener?.close(); await app?.stop(); console.log(`tenant finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const login = async (identifier, password) => {
    const r = await call('/api/auth/login', { body: { identifier, password } });
    assert.equal(r.status, 200, `login ${identifier} → ${r.status} ${r.text}`);
    return r.headers['set-cookie'][0].split(';')[0];
  };
  /**
   * A request at a given address. `host` is the header a browser sends for that domain, which is the
   * only thing that makes a request "arrive at saranjai.edu.bd" — so this goes through node:http
   * rather than fetch, which will not let a caller set Host at all.
   */
  const call = (p, { body, method, cookie, host } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = nodeHttp.request({
      host: '127.0.0.1', port, path: p, method: method ?? (data ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { cookie } : {}),
        ...(host ? { Host: host } : {}),
      },
    }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, headers: res.headers, body: j, text }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  const api = async (p, opts = {}) => {
    const r = await call(p, { cookie: hq.cookie, ...opts });
    assert.ok(r.status < 400, `${opts.method ?? (opts.body ? 'POST' : 'GET')} ${p} → ${r.status} ${r.text.slice(0, 300)}`);
    return r.body;
  };
  const slugOf = async schoolId => String((await app.db.findOne('schools', { id: schoolId })).slug ?? '');

  // ---------------------------------------------------------------- the slug
  test('a school that never had a slug is given one, and keeps it on the next boot', async () => {
    const before = await slugOf(saranjai.schoolId);
    assert.ok(before, 'the school came up with a web address without anybody typing one');
    assert.match(before, /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/, 'lowercase ASCII, letters digits and hyphens');
    assert.ok(before.length >= 2 && before.length <= 40, `2–40 characters (${before.length})`);
    assert.ok(!core.RESERVED_SLUGS.has(before), 'and never one of the words the app answers on itself');

    // a school installed before this column existed: blank it and let the boot reconcile find it
    await app.db.update('schools', { slug: null }, { id: shapla.schoolId });
    assert.equal(await slugOf(shapla.schoolId), '');
    const first = await app.installer.ensureAutomationCatalogue();
    assert.equal(first.slugs, 1, 'exactly the one school that was missing one');
    const filled = await slugOf(shapla.schoolId);
    assert.equal(filled, 'shapla-high-school');

    // and a second boot changes nothing: a slug already chosen is never rewritten
    const second = await app.installer.ensureAutomationCatalogue();
    assert.equal(second.slugs, 0);
    assert.equal(await slugOf(shapla.schoolId), filled);
    assert.equal(await slugOf(saranjai.schoolId), before);
  });

  test('a Bangla name becomes something a person can type', async () => {
    assert.equal(core.slugifySchoolName('সরনজাই বালিকা উচ্চ বিদ্যালয়'), 'saranjai-balika-uchcha-bidyalaya');
    assert.equal(await slugOf(saranjai.schoolId), 'saranjai-balika-uchcha-bidyalaya');
    assert.equal(core.transliterateBangla('উচ্চ'), 'uchcha', 'the inherent vowel is not dropped at the end of a word');
    assert.equal(core.slugifySchoolName('ঢাকা কলেজ'), 'dhaka-college');
    // a name with nothing transliterable in it falls back to the school's own code
    assert.equal(core.slugifySchoolName('!!!', 'DHK07'), 'dhk07');
    assert.equal(core.slugifySchoolName('', ''), 'school');
    // long names are cut at a word boundary, not mid-syllable
    const long = core.slugifySchoolName('Government Model Higher Secondary School And College Mymensingh');
    assert.ok(long.length <= 40 && !long.endsWith('-'), `${long} is trimmed to something readable`);
    assert.ok(long.split('-').every(w => w.length > 0));
  });

  test('two schools with similar names get different slugs', async () => {
    const a = await app.installer.addTenant({ schoolName: 'Shapla High School', institutionType: 'school', locale: 'bn', adminName: 'Twin A', adminPhone: '01700000204', adminPassword: 'twin-a-pass-1' });
    const b = await app.installer.addTenant({ schoolName: 'Shapla  High  School', institutionType: 'school', locale: 'bn', adminName: 'Twin B', adminPhone: '01700000205', adminPassword: 'twin-b-pass-1' });
    const [sa, sb, original] = [await slugOf(a.schoolId), await slugOf(b.schoolId), await slugOf(shapla.schoolId)];
    assert.equal(original, 'shapla-high-school');
    assert.equal(sa, 'shapla-high-school-2');
    assert.equal(sb, 'shapla-high-school-3');
    assert.equal(new Set([sa, sb, original]).size, 3, 'three schools, three addresses');
    // the unique key is what actually decides, so no two rows can ever share one
    const rows = await app.db.query('SELECT slug FROM schools WHERE slug IS NOT NULL');
    assert.equal(new Set(rows.map(r => String(r.slug))).size, rows.length);
  });

  // ---------------------------------------------------------------- resolving an address
  test('a slug path resolves to its own school and to no other', async () => {
    const one = await app.tenant.resolve({ host: '127.0.0.1', path: '/saranjai-balika-uchcha-bidyalaya/fees' });
    assert.equal(one.source, 'slug');
    assert.equal(one.school.id, saranjai.schoolId);
    assert.equal(one.prefix, '/saranjai-balika-uchcha-bidyalaya');

    const other = await app.tenant.resolve({ host: '127.0.0.1', path: '/shapla-high-school/dashboard' });
    assert.equal(other.school.id, shapla.schoolId);
    assert.notEqual(other.school.id, one.school.id);

    // the installation's own root belongs to nobody: that is where the vendor lives
    const none = await app.tenant.resolve({ host: '127.0.0.1', path: '/dashboard' });
    assert.equal(none.source, 'none');
    assert.equal(none.school, null);
    assert.equal(none.prefix, '');
    // and so does every path the app answers on itself
    for (const reserved of ['/api/auth/login', '/owner', '/install', '/site', '/portal', '/x/test-door-4t7v1n', '/assets/app.js']) {
      assert.equal((await app.tenant.resolve({ host: '127.0.0.1', path: reserved })).source, 'none', `${reserved} is the app's own`);
    }
    assert.equal((await app.tenant.resolve({ host: '127.0.0.1', path: '/no-such-school/x' })).source, 'none');
  });

  test('a custom domain wins, at the root of its own host', async () => {
    await app.tenant.setWebAddress(saranjai.schoolId, { customDomain: 'saranjai.edu.bd' });
    const r = await app.tenant.resolve({ host: 'saranjai.edu.bd', path: '/dashboard' });
    assert.equal(r.source, 'domain');
    assert.equal(r.school.id, saranjai.schoolId);
    assert.equal(r.prefix, '', 'the school owns the whole host, so nothing is prefixed');
    // www and a port and capitals are the same address
    for (const host of ['www.saranjai.edu.bd', 'SARANJAI.EDU.BD:8443', 'saranjai.edu.bd.']) {
      assert.equal((await app.tenant.resolve({ host, path: '/' })).school?.id, saranjai.schoolId, host);
    }
    // a change takes effect at once, without a restart: the cache is dropped by the write itself
    await app.tenant.setWebAddress(saranjai.schoolId, { customDomain: 'saranjai.school.bd' });
    assert.equal((await app.tenant.resolve({ host: 'saranjai.school.bd', path: '/' })).school?.id, saranjai.schoolId);
    assert.equal((await app.tenant.resolve({ host: 'saranjai.edu.bd', path: '/' })).source, 'none', 'the old name stopped answering');
    // and removing it leaves the slug still working
    await app.tenant.setWebAddress(saranjai.schoolId, { customDomain: null });
    assert.equal((await app.tenant.resolve({ host: 'saranjai.school.bd', path: '/' })).source, 'none');
    assert.equal((await app.tenant.resolve({ host: '127.0.0.1', path: '/saranjai-balika-uchcha-bidyalaya' })).school?.id, saranjai.schoolId);
    await app.tenant.setWebAddress(saranjai.schoolId, { customDomain: 'saranjai.edu.bd' });
  });

  // ---------------------------------------------------------------- what is refused
  test('a reserved word is refused as a slug', async () => {
    for (const word of ['api', 'login', 'owner', 'dashboard', 'portal', 'site', 'x', 'public', 'install', 'assets', 'cron', 'logout']) {
      await assert.rejects(
        () => app.tenant.setWebAddress(shapla.schoolId, { slug: word }),
        e => e instanceof core.HttpError && e.status === 400, `"${word}" must be refused`);
    }
    // shape, too: too short, too long, and anything that is not [a-z0-9-]
    for (const bad of ['a', 'x'.repeat(41), 'shapla school', 'shapla_school', '-shapla', 'shapla-', 'শাপলা']) {
      await assert.rejects(() => app.tenant.setWebAddress(shapla.schoolId, { slug: bad }), e => e instanceof core.HttpError && e.status === 400, `"${bad}"`);
    }
    // case and stray spaces are tidied rather than refused: the vendor typing a name should not be
    // told off for a capital letter
    assert.equal(core.normalizeSlug('  Shapla '), 'shapla');
    assert.equal(await slugOf(shapla.schoolId), 'shapla-high-school', 'and none of them changed anything');
    // a legal one is taken
    await app.tenant.setWebAddress(shapla.schoolId, { slug: 'shapla' });
    assert.equal(await slugOf(shapla.schoolId), 'shapla');
    assert.equal((await app.tenant.resolve({ host: '127.0.0.1', path: '/shapla/fees' })).school?.id, shapla.schoolId);
  });

  test('a slug or a domain another school already holds is refused', async () => {
    await assert.rejects(
      () => app.tenant.setWebAddress(saranjai.schoolId, { slug: 'shapla' }),
      e => e instanceof core.HttpError && e.status === 409, 'two schools cannot share a path');
    await assert.rejects(
      () => app.tenant.setWebAddress(shapla.schoolId, { customDomain: 'saranjai.edu.bd' }),
      e => e instanceof core.HttpError && e.status === 409, 'nor a domain');
    await assert.rejects(
      () => app.tenant.setWebAddress(shapla.schoolId, { customDomain: 'www.saranjai.edu.bd' }),
      e => e instanceof core.HttpError && e.status === 409, 'and www is the same address');
    // nothing moved
    assert.equal(await slugOf(saranjai.schoolId), 'saranjai-balika-uchcha-bidyalaya');
    assert.equal(String((await app.db.findOne('schools', { id: shapla.schoolId })).custom_domain ?? ''), '');
    // a malformed domain is a 400 before it ever reaches the unique key
    for (const bad of ['not a domain', 'localhost', 'bad_underscore.com', '-bad.com', 'no-dot']) {
      await assert.rejects(() => app.tenant.setWebAddress(shapla.schoolId, { customDomain: bad }), e => e instanceof core.HttpError && e.status === 400, bad);
    }
    // a whole URL pasted out of a browser is read for the host it names, not refused
    assert.equal(core.normalizeDomain('https://WWW.Shapla.Edu.BD/admin'), 'shapla.edu.bd');
    // a school may keep its own domain: re-saving the same one is not a collision with itself
    await app.tenant.setWebAddress(saranjai.schoolId, { customDomain: 'saranjai.edu.bd' });
  });

  // ---------------------------------------------------------------- one school's session, one school's data
  test('a session for school A gets a 404 on school B\'s API', async () => {
    // at the installation's own root no school owns the address, so the session decides, as before
    const atRoot = await call('/api/people/students', { cookie: shapla.cookie });
    assert.equal(atRoot.status, 200, 'nothing about the old address changed');

    // Saranjai's own domain: its head teacher is served, Shapla's is not there at all
    assert.equal((await call('/api/people/students', { cookie: saranjai.cookie, host: 'saranjai.edu.bd' })).status, 200);
    const crossed = await call('/api/people/students', { cookie: shapla.cookie, host: 'saranjai.edu.bd' });
    assert.equal(crossed.status, 404, 'a session for Shapla reads nothing of Saranjai\'s');
    assert.equal(crossed.body.code, 'not_found', 'and is told the path does not exist, not that it is forbidden');
    // a write is refused the same way, and wrote nothing
    const before = await app.db.count('students', { school_id: saranjai.schoolId });
    const write = await call('/api/people/students', { cookie: shapla.cookie, host: 'saranjai.edu.bd', body: { firstName: 'Nobody', gender: 'male', dateOfBirth: '2014-01-01', admissionDate: '2025-01-05' } });
    assert.equal(write.status, 404);
    assert.equal(await app.db.count('students', { school_id: saranjai.schoolId }), before);

    // signing in is exempt: a visitor at a school's own address must be able to sign in there
    const signIn = await call('/api/auth/login', { host: 'saranjai.edu.bd', body: { identifier: 'head@saranjai.test', password: 'saranjai-pass-1' } });
    assert.equal(signIn.status, 200);
    assert.equal((await call('/_health', { host: 'saranjai.edu.bd' })).status, 200, 'and so is the health check the domain watch reads');
  });

  // ---------------------------------------------------------------- the vendor's own space
  test('the vendor\'s console is a 404 on a tenant\'s domain and under a slug', async () => {
    // at the installation root it is the owner's, as before
    assert.equal((await call('/api/owner/overview', { cookie: hq.cookie })).status, 200);
    assert.equal((await call('/owner', { cookie: hq.cookie })).status, 200);
    assert.equal((await call('/x/test-door-4t7v1n')).status, 200);

    // on a school's own domain none of it exists, even for the owner's own session
    for (const p of ['/api/owner/overview', '/api/owner/schools', '/owner', '/owner/schools', '/x/test-door-4t7v1n']) {
      assert.equal((await call(p, { cookie: hq.cookie, host: 'saranjai.edu.bd' })).status, 404, `${p} on a tenant domain`);
      assert.equal((await call(p, { host: 'saranjai.edu.bd' })).status, 404, `${p} signed out on a tenant domain`);
    }
    // and under a slug path it is not there either
    for (const p of ['/shapla/owner', '/shapla/x/test-door-4t7v1n', '/shapla/api/owner/overview']) {
      assert.equal((await call(p, { cookie: hq.cookie })).status, 404, p);
    }
    // the door still works where it belongs, so nothing was broken to achieve this
    assert.equal((await call('/x/test-door-4t7v1n')).status, 200);
  });

  // ---------------------------------------------------------------- the owner API
  test('the owner reads a school\'s address and the DNS to dictate down a telephone', async () => {
    const w = await api(`/api/owner/schools/${saranjai.schoolId}/web`);
    assert.equal(w.slug, 'saranjai-balika-uchcha-bidyalaya');
    assert.equal(w.customDomain, 'saranjai.edu.bd');
    assert.equal(w.url, 'https://saranjai.edu.bd');
    assert.ok(w.domain && w.domain.hostname === 'saranjai.edu.bd', 'the domain carries its own state');
    for (const k of ['resolves', 'pointsHere', 'certificate', 'checkedAt', 'note']) assert.ok(k in w.domain, `domain.${k}`);

    assert.equal(w.instructions.length, 2, 'the domain itself, and www');
    for (const i of w.instructions) {
      assert.ok(['A', 'CNAME'].includes(i.type));
      assert.ok(i.name && i.value && i.note, JSON.stringify(i));
    }
    assert.equal(w.instructions[0].name, '@');
    assert.equal(w.instructions[1].name, 'www');
    assert.match(w.instructions[1].note, /www/i, 'and it says plainly that www is covered');
    assert.equal(w.instructions[0].value, w.instructions[1].value, 'both point at the same place');

    // a school with no domain of its own opens under the slug, and has no domain state to report
    const plain = await api(`/api/owner/schools/${shapla.schoolId}/web`);
    assert.equal(plain.customDomain, null);
    assert.equal(plain.domain, null);
    assert.match(plain.url, /\/shapla$/);
    assert.ok(plain.instructions.length === 2, 'the records are still there to read out before the domain is bought');
  });

  test('the owner names a school, and is told what cPanel needs when it cannot do it itself', async () => {
    const r = await api(`/api/owner/schools/${shapla.schoolId}/web`, { body: { slug: 'shapla-high', customDomain: 'shapla.edu.bd' } });
    assert.equal(r.slug, 'shapla-high');
    assert.equal(r.customDomain, 'shapla.edu.bd');
    assert.equal(r.url, 'https://shapla.edu.bd');
    // no token configured in this test, so the alias could not be made — and the reply says so
    assert.equal(r.alias.configured, false);
    assert.equal(r.alias.created, false);
    assert.match(r.alias.manual, /cPanel/);
    assert.match(r.alias.manual, /shapla\.edu\.bd/);

    // the new address works immediately, at both forms
    assert.equal((await app.tenant.resolve({ host: 'shapla.edu.bd', path: '/' })).school?.id, shapla.schoolId);
    assert.equal((await app.tenant.resolve({ host: '127.0.0.1', path: '/shapla-high/fees' })).school?.id, shapla.schoolId);
    assert.equal((await app.tenant.resolve({ host: '127.0.0.1', path: '/shapla/fees' })).source, 'none', 'the old slug is free again');

    // removing the domain leaves the slug
    const removed = await api(`/api/owner/schools/${shapla.schoolId}/web`, { body: { customDomain: null } });
    assert.equal(removed.customDomain, null);
    assert.equal(removed.slug, 'shapla-high');
    assert.match(removed.url, /\/shapla-high$/);

    // refusals come through the API as they do through the service
    assert.equal((await call(`/api/owner/schools/${shapla.schoolId}/web`, { cookie: hq.cookie, body: { slug: 'owner' } })).status, 400);
    assert.equal((await call(`/api/owner/schools/${shapla.schoolId}/web`, { cookie: hq.cookie, body: { slug: 'saranjai-balika-uchcha-bidyalaya' } })).status, 409);
    assert.equal((await call('/api/owner/schools/nope/web', { cookie: hq.cookie })).status, 404);

    // …and only for the vendor: a school's own super admin is not there at all
    assert.equal((await call(`/api/owner/schools/${shapla.schoolId}/web`, { cookie: shapla.cookie })).status, 404);
    assert.equal((await call(`/api/owner/schools/${shapla.schoolId}/web`, { cookie: shapla.cookie, body: { slug: 'anything' } })).status, 404);
    assert.equal(await slugOf(shapla.schoolId), 'shapla-high', 'and nothing they tried moved it');

    // both writes left a trail, in the vendor's books and in the school's own
    const mine = await app.db.query(`SELECT action FROM audit_logs WHERE school_id = ? AND entity_type = 'owner.school' AND action = 'web_address'`, [hq.schoolId]);
    const theirs = await app.db.query(`SELECT action FROM audit_logs WHERE school_id = ? AND entity_type = 'owner.school' AND action = 'web_address'`, [shapla.schoolId]);
    assert.ok(mine.length >= 2 && theirs.length >= 2, 'a school can see that its address was changed');
  });

  // ---------------------------------------------------------------- the nightly watch
  test('the domain watch reports a change once, not nightly', async () => {
    const KEY = core.DOMAIN_WATCH_KEY;
    const domain = 'saranjai.edu.bd';
    const countTold = async () => (await app.db.query(
      `SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND event_key = 'tenant.domain_lost' AND entity_id = ?`,
      [hq.schoolId, saranjai.schoolId]))[0];

    // the real check cannot reach a domain that does not exist, so the answer it would give is
    // supplied directly: this test is about what the watch *does* with a change, not about DNS
    const check = (pointsHere, certificate = true) => ({ hostname: domain, resolves: true, pointsHere, certificate, checkedAt: new Date().toISOString().slice(0, 19).replace('T', ' '), note: 'set by the test' });
    const stub = state => { app.tenant.checkDomain = async () => check(state.pointsHere, state.certificate); };

    // 1. it was working yesterday
    await app.settings.set(saranjai.schoolId, KEY, check(true));
    // 2. today it does not point here any more: the vendor is told, once
    stub({ pointsHere: false, certificate: true });
    const lost = await app.tenant.watchDomain(saranjai.schoolId);
    assert.equal(lost.checked, true);
    assert.equal(lost.pointsHere, false);
    assert.deepEqual(lost.told, ['domain_lost']);
    const afterFirst = Number((await countTold()).n);
    assert.ok(afterFirst >= 1, 'somebody was actually told');

    // 3. and again tonight, and the night after: the same broken domain is not news twice
    for (let night = 0; night < 3; night++) {
      const again = await app.tenant.watchDomain(saranjai.schoolId);
      assert.equal(again.changed, false, `night ${night + 2} says nothing`);
      assert.deepEqual(again.told, []);
    }
    assert.equal(Number((await countTold()).n), afterFirst, 'and no second message was written');

    // 4. a school whose domain was never pointed here is not reported at all
    await app.settings.set(shapla.schoolId, KEY, null);
    await app.tenant.setWebAddress(shapla.schoolId, { customDomain: 'never-pointed.edu.bd' });
    stub({ pointsHere: false, certificate: null });
    const never = await app.tenant.watchDomain(shapla.schoolId);
    assert.equal(never.checked, true);
    assert.deepEqual(never.told, [], 'a domain nobody has pointed yet is not a fault');

    // 5. a school with no domain of its own is not checked at all
    await app.tenant.setWebAddress(shapla.schoolId, { customDomain: null });
    const skipped = await app.tenant.watchDomain(shapla.schoolId);
    assert.equal(skipped.checked, false);

    // 6. and when it starts working again, that is a change too, and is said once
    stub({ pointsHere: true, certificate: true });
    const back = await app.tenant.watchDomain(saranjai.schoolId);
    assert.deepEqual(back.told, ['domain_live']);
    const quiet = await app.tenant.watchDomain(saranjai.schoolId);
    assert.deepEqual(quiet.told, [], 'and then it goes quiet again');
  });

  test('the job is in the catalogue every school gets', async () => {
    const rows = await app.db.query(`SELECT school_id, cron_expr FROM scheduled_jobs WHERE job_key = 'platform.domain_watch'`);
    const schools = await app.db.query(`SELECT id FROM schools WHERE status <> 'closed'`);
    assert.equal(rows.length, schools.length, 'one row per school, added by the boot reconcile');
    assert.ok(rows.every(r => String(r.cron_expr) === '0 6 * * *'), 'daily');
  });
});
