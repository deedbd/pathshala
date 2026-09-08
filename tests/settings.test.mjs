// Settings — the console screens every other screen depends on.
//
// What this proves: a policy typed into the console is the value the next job actually reads (and
// nothing that already ran is rewritten); a document number cannot be moved below one already
// printed; a role that loses a permission stops the person holding it at the very next request; the
// last super_admin cannot be stripped or switched off, because that is the school's way back in; an
// invited operator can really sign in with what was sent to them; a secret goes out as "configured"
// and never as itself; and every one of those writes leaves an audit_logs row naming who did it.
//   node --test tests/settings.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-settings');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'settings-key'.padEnd(64, 'x'), CRON_KEY: 'cron-settings', UPLOADS_DIR: 'tests/.tmp-settings/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-settings/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, http, baseUrl, sid;
let admin, teacher;                 // { userId, cookie }
let roles = null;
const t0 = Date.now();

describe('settings: the school looking at its own rules', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const created = await app.installer.createSchool({ schoolName: 'Shitolpur High School', institutionType: 'school', locale: 'en', adminName: 'Head Teacher', adminPhone: '01711000001', adminEmail: 'head@shitolpur.test', adminPassword: 'head-pass-1' });
    sid = created.schoolId;
    await app.installer.finish(sid);
    await app.settings.set(sid, 'notifications.quiet_hours', null);   // nothing here waits for the morning

    admin = { userId: created.userId };
    teacher = { userId: await app.auth.createUser({ schoolId: sid, userType: 'staff', displayName: 'Ruma Akter', phone: '01711000002', email: 'ruma@shitolpur.test', password: 'ruma-pass-1', roles: ['teacher'] }) };

    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    admin.cookie = await login('head@shitolpur.test', 'head-pass-1');
    teacher.cookie = await login('ruma@shitolpur.test', 'ruma-pass-1');
    roles = await api('/roles');
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`settings finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const login = async (identifier, password) => {
    const r = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password }) });
    assert.equal(r.status, 200, `login ${identifier} → ${r.status} ${await r.text()}`);
    return r.headers.get('set-cookie').split(';')[0];
  };
  const call = async (p, body, method = body ? 'POST' : 'GET', cookie = admin.cookie) => {
    const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { /* html or empty */ }
    return { status: r.status, body: j, text };
  };
  const api = async (p, body, method = body ? 'POST' : 'GET', cookie = admin.cookie) => {
    const r = await call(p, body, method, cookie);
    assert.ok(r.status < 400, `${method} ${p} → ${r.status} ${r.text.slice(0, 300)}`);
    return r.body;
  };
  /** The audit rows for one entity, newest first, as the console reads them. */
  const trail = async (entityType, entityId) => (await api(`/audit?entityType=${entityType}${entityId ? `&entityId=${encodeURIComponent(entityId)}` : ''}`)).rows;

  // ---------------- policies ----------------
  test('the list says what reads every key — and says plainly when nothing does', async () => {
    const list = await api('/settings');
    const weekend = list['calendar.weekend'];
    assert.ok(weekend, 'the seeded weekend key is there');
    assert.deepEqual(weekend.value, ['fri', 'sat']);
    assert.equal(weekend.module, 'academic');
    assert.match(weekend.readBy, /weeklyOffs/, 'and it names the method that reads it');

    // a key that is seeded and read by nothing says so, instead of implying the number matters
    assert.equal(list['fees.due_day'].readBy, null);
    assert.match(list['fees.due_day'].note, /fee structure|Seeded/i);

    // a key Pathshala ships that this school has never written is still on the list, unset
    assert.ok(list['hr.gratuity'], 'a shipped key with no row of its own');
    assert.equal(list['hr.gratuity'].value, null);
    assert.match(list['hr.gratuity'].readBy, /gratuity/i);
  });

  test('a policy written from the console is what the next job reads', async () => {
    assert.deepEqual(await app.academic.weeklyOffs(sid), [5, 6], 'Friday and Saturday, from the seed');
    const sunday = nextDow(0), friday = nextDow(5);
    assert.equal(await app.academic.isHoliday(sid, friday), true);
    assert.equal(await app.academic.isHoliday(sid, sunday), false);

    const saved = await api('/settings', { key: 'calendar.weekend', value: ['sun'] }, 'PUT');
    assert.equal(saved.saved, true);
    assert.match(saved.effect, /next run/i, 'and the reply says when it bites');
    assert.match(saved.readBy, /weeklyOffs/);

    // the job reads the table live: no restart, no cache to clear by hand
    assert.deepEqual(await app.academic.weeklyOffs(sid), [0]);
    assert.equal(await app.academic.isHoliday(sid, sunday), true, 'Sunday is now closed');
    assert.equal(await app.academic.isHoliday(sid, friday), false, 'and Friday is a working day');

    const t = await trail('settings', 'calendar.weekend');
    assert.equal(t.length, 1);
    assert.equal(t[0].actor_user_id, admin.userId, 'the row names the person who typed it');
    assert.equal(t[0].actor_name, 'Head Teacher');
    assert.deepEqual(t[0].before_data.value, ['fri', 'sat'], 'and what it was before');
    assert.deepEqual(t[0].after_data.value, ['sun']);

    await api('/settings', { key: 'calendar.weekend', value: ['fri', 'sat'] }, 'PUT');   // put the week back
  });

  test('a secret is reported as configured and never as itself', async () => {
    const SECRET = 'ivr-shared-secret-9f2b';
    await api('/ivr/secret', { secret: SECRET });
    const list = await api('/settings');
    const row = list['ivr.webhook_secret'];
    assert.equal(row.secret, true);
    assert.deepEqual(row.value, { enc: true }, 'configured, and nothing more');
    assert.equal(JSON.stringify(list).includes(SECRET), false, 'the secret is nowhere in the whole list');

    // and the settings writer refuses to be the way somebody replaces it with a plaintext
    const refused = await call('/settings', { key: 'ivr.webhook_secret', value: 'plain-text' }, 'PUT');
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /secret/i);
  });

  // ---------------- numbering ----------------
  test('a sequence cannot be moved below what it has already issued', async () => {
    assert.equal(await app.numbering.next(sid, 'test_receipt', { prefix: 'RCPT-', padding: 5 }), 'RCPT-00001');
    assert.equal(await app.numbering.next(sid, 'test_receipt', { prefix: 'RCPT-', padding: 5 }), 'RCPT-00002');

    const seqs = await api('/sequences');
    const seq = seqs.find(s => s.key === 'test_receipt');
    assert.equal(seq.issued, 2);
    assert.equal(seq.nextValue, 3);
    assert.equal(seq.example, 'RCPT-00003', 'the list shows the number it would hand out next');

    for (const bad of [1, 2]) {
      const r = await call(`/sequences/${seq.id}`, { nextValue: bad }, 'PATCH');
      assert.equal(r.status, 400, `next value ${bad} must be refused`);
      assert.match(r.body.error, /already issued up to 2/, 'and the refusal says why');
    }
    // standing still is fine, and so is jumping forward to carry on from an old paper register
    await api(`/sequences/${seq.id}`, { nextValue: 3 }, 'PATCH');
    await api(`/sequences/${seq.id}`, { nextValue: 500, prefix: 'RC-', padding: 6 }, 'PATCH');
    assert.equal(await app.numbering.next(sid, 'test_receipt'), 'RC-000500');

    const t = await trail('number_sequence', seq.id);
    assert.ok(t.length >= 2, 'every change is on the record');
    assert.equal(t[0].actor_user_id, admin.userId);
    assert.equal(t[0].after_data.nextValue, 500);
  });

  // ---------------- roles ----------------
  test('a role losing a permission stops that person at the door on the very next request', async () => {
    assert.equal((await call('/academic/classes', null, 'GET', teacher.cookie)).status, 200, 'a teacher reads the classes today');

    const teacherRole = roles.roles.find(r => r.slug === 'teacher');
    assert.ok(teacherRole.permissions.includes('academic.view'));
    const without = teacherRole.permissions.filter(p => p !== 'academic.view');
    const saved = await api(`/roles/${teacherRole.id}/permissions`, { permissions: without }, 'PUT');
    assert.deepEqual(saved.removed, ['academic.view']);
    assert.match(saved.effect, /next request/i);

    // no sign-out, no restart, no waiting for a cache to expire
    const now = await call('/academic/classes', null, 'GET', teacher.cookie);
    assert.equal(now.status, 403, 'the same request, one moment later');
    assert.match(now.body.error, /academic\.view/);
    // and the rest of their work is untouched
    assert.equal((await call('/attendance/policies', null, 'GET', teacher.cookie)).status, 200);

    const t = await trail('role_permissions', teacherRole.id);
    assert.equal(t[0].actor_user_id, admin.userId);
    assert.ok(t[0].before_data.permissions.includes('academic.view'));
    assert.equal(t[0].after_data.permissions.includes('academic.view'), false);

    await api(`/roles/${teacherRole.id}/permissions`, { permissions: teacherRole.permissions }, 'PUT');
    assert.equal((await call('/academic/classes', null, 'GET', teacher.cookie)).status, 200, 'and giving it back works the same way');
  });

  test('super_admin is not editable, because the door does not read its rows', async () => {
    const sa = roles.roles.find(r => r.slug === 'super_admin');
    assert.equal(sa.locked, true);
    assert.equal(sa.permissions.length, roles.permissions.length, 'it is shown holding everything, which is what can() does');
    const r = await call(`/roles/${sa.id}/permissions`, { permissions: [] }, 'PUT');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /way back in/);
  });

  test('the last super_admin cannot be stripped, or switched off', async () => {
    const holders = await app.rbac.superAdmins(sid);
    assert.deepEqual(holders, [admin.userId], 'one person holds it');

    const stripped = await call(`/users/${admin.userId}/roles`, { roles: ['admin'] }, 'POST');
    assert.equal(stripped.status, 400);
    assert.match(stripped.body.error, /only super_admin/);
    const disabled = await call(`/users/${admin.userId}/disable`, { active: false }, 'POST');
    assert.equal(disabled.status, 400);
    assert.deepEqual(await app.rbac.superAdmins(sid), [admin.userId], 'and nothing moved');

    // with a second holder the same call goes through — the refusal is about the last one, not the role
    const second = await api('/users', { displayName: 'Deputy Head', phone: '01711000009', roles: ['super_admin'] });
    assert.equal((await app.rbac.superAdmins(sid)).length, 2);
    await api(`/users/${second.userId}/roles`, { roles: ['staff'] }, 'POST');
    assert.deepEqual(await app.rbac.superAdmins(sid), [admin.userId]);
    assert.equal((await call(`/users/${admin.userId}/roles`, { roles: ['admin'] }, 'POST')).status, 400, 'and the last one is protected again');

    const t = await trail('user_roles', second.userId);
    assert.equal(t[0].actor_user_id, admin.userId);
    assert.deepEqual(t[0].after_data.roles, ['staff']);
  });

  // ---------------- users ----------------
  test('an invited user can sign in with what was sent to them', async () => {
    const invited = await api('/users', { displayName: 'Nazma Begum', phone: '01711000003', email: 'nazma@shitolpur.test', roles: ['accountant'] });
    assert.equal(invited.passwordGenerated, true);
    assert.ok(invited.password.length >= 12, 'a password nobody would guess');
    assert.ok(invited.invitationsSent >= 1, 'and it was actually sent somewhere');

    // the invitation carries the sign-in details, and the account works with them
    const notes = await app.db.findMany('notifications', { school_id: sid, recipient_user_id: invited.userId });
    assert.ok(notes.length >= 1);
    assert.ok(notes.some(n => String(n.body).includes(invited.password)), 'the message says what to sign in with');

    const cookie = await login('nazma@shitolpur.test', invited.password);
    const me = await api('/auth/me', undefined, 'GET', cookie);
    assert.deepEqual(me.roles, ['accountant']);
    assert.equal((await call('/fees/invoices', null, 'GET', cookie)).status, 200, 'and the role they were given works');
    assert.equal((await call('/settings', null, 'GET', cookie)).status, 403, 'while the one they were not does not');

    const listed = await api('/users');
    const row = listed.find(u => u.id === invited.userId);
    assert.equal(row.displayName, 'Nazma Begum');
    assert.deepEqual(row.roles.map(r => r.slug), ['accountant']);
    assert.equal(row.twoFactor, false);
    assert.equal(Object.keys(row).some(k => /password|secret/i.test(k)), false, 'no hash and no secret leaves the server');

    // a reset ends the old sessions and hands over a new one-time password
    const reset = await api(`/users/${invited.userId}/reset`, {});
    assert.notEqual(reset.password, invited.password);
    assert.equal((await call('/auth/me', null, 'GET', cookie)).status, 401, 'the session they were holding is gone');
    await login('nazma@shitolpur.test', reset.password);

    // disabling stops them at the door, and enabling lets them back
    await api(`/users/${invited.userId}/disable`, { active: false });
    assert.equal((await call('/auth/login', { identifier: 'nazma@shitolpur.test', password: reset.password }, 'POST', null)).status >= 400, true);
    await api(`/users/${invited.userId}/disable`, { active: true });
    await login('nazma@shitolpur.test', reset.password);

    const t = await trail('user', invited.userId);
    assert.ok(t.some(r => r.action === 'invite'), 'the invitation is on the record');
    assert.ok(t.some(r => r.action === 'reset_password'));
    assert.ok(t.some(r => r.action === 'disable'));
    assert.ok(t.some(r => r.action === 'enable'));
    // every administrative act names the head teacher who did it; the person's own sign-ins name them
    const byOffice = t.filter(r => ['invite', 'create', 'reset_password', 'disable', 'enable'].includes(r.action));
    assert.equal(byOffice.every(r => r.actor_user_id === admin.userId && r.actor_name === 'Head Teacher'), true, 'and every one names who did it');
    assert.equal(t.filter(r => r.action === 'login').every(r => r.actor_user_id === invited.userId), true);
    // the password itself is never in the trail
    assert.equal(JSON.stringify(await trail('user', invited.userId)).includes(reset.password), false);
  });

  // ---------------- the school row ----------------
  test('the school can edit its own name plate, its campuses and its shifts', async () => {
    const before = await api('/school');
    assert.equal(before.profile.name, 'Shitolpur High School');
    assert.ok(before.campuses.length >= 1, 'the installer left a main campus');
    assert.ok(before.shifts.length >= 1);

    const saved = await api('/school', { nameBn: 'শীতলপুর উচ্চ বিদ্যালয়', eiin: '108234', mpoCode: 'MPO-77', board: 'Dhaka', phone: '+8802555000', currency: 'BDT', timezone: 'Asia/Dhaka' }, 'PATCH');
    assert.equal(saved.profile.nameBn, 'শীতলপুর উচ্চ বিদ্যালয়');
    assert.equal(saved.profile.eiin, '108234');
    const row = await app.db.findOne('schools', { id: sid });
    assert.equal(String(row.eiin), '108234', 'written to the row every other module reads');

    const campus = await api('/school/campuses', { name: 'Junior Campus', code: 'JNR', address: 'Road 7' });
    const shift = await api('/school/shifts', { name: 'Evening', startTime: '17:00', endTime: '20:00' });
    const after = await api('/school');
    assert.ok(after.campuses.some(c => c.id === campus.id && c.code === 'JNR'));
    assert.ok(after.shifts.some(s => String(s.id) === shift.id && String(s.start_time).startsWith('17:00')));
    assert.equal((await call('/school/campuses', { name: 'Another', code: 'JNR' })).status, 409, 'a code is not reused');

    const t = await trail('school', sid);
    assert.equal(t[0].actor_user_id, admin.userId);
    assert.equal(t[0].after_data.eiin, '108234');
  });

  // ---------------- the audit log itself ----------------
  test('the audit log is readable, filterable and paged', async () => {
    const all = await api('/audit?pageSize=5');
    assert.equal(all.rows.length, 5);
    assert.ok(all.total > 5);
    assert.equal(all.page, 0);
    assert.ok(all.actions.includes('update'), 'the filter offers what is actually in the log');
    assert.ok(all.entityTypes.includes('settings'));

    const second = await api('/audit?pageSize=5&page=1');
    assert.equal(second.page, 1);
    assert.equal(second.rows.some(r => all.rows.some(a => a.id === r.id)), false, 'the second page is a different five');

    const settingsOnly = await api('/audit?entityType=settings');
    assert.equal(settingsOnly.rows.every(r => r.entity_type === 'settings'), true);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok((await api(`/audit?from=${today}&to=${today}`)).total > 0, 'today has entries');
    assert.equal((await api('/audit?from=2000-01-01&to=2000-01-02')).total, 0, 'and the year 2000 has none');
    assert.equal((await api(`/audit?actorUserId=${admin.userId}`)).rows.every(r => r.actor_user_id === admin.userId), true);
  });

  // ---------------- the page ----------------
  test('the console page itself renders, and the sidebar has a way to it', async () => {
    const r = await fetch(`${baseUrl}/settings`, { redirect: 'manual', headers: { cookie: admin.cookie } });
    const html = await r.text();
    assert.equal(r.status, 200, 'the head teacher reaches /settings');
    for (const needle of ['Settings', 'Policies', 'Numbering', 'Audit log', 'calendar.weekend', 'Shitolpur High School']) {
      assert.ok(html.includes(needle), `the rendered page shows ${needle}`);
    }
    assert.equal(html.includes('ivr-shared-secret'), false, 'and no secret is server-rendered into it');
    assert.ok((await (await fetch(`${baseUrl}/dashboard`, { headers: { cookie: admin.cookie } })).text()).includes('/settings'), 'the sidebar links to it');
    // signed out it is the sign-in page, not the settings
    const out = await fetch(`${baseUrl}/settings`, { redirect: 'manual' });
    assert.equal(out.status, 302);
    assert.match(out.headers.get('location'), /^\/login/);
    // and the page asks the same questions the API does: a teacher is refused here too, so no
    // server render hands over an audit log that /api/audit would have withheld
    const notAllowed = await fetch(`${baseUrl}/settings`, { redirect: 'manual', headers: { cookie: teacher.cookie } });
    assert.equal(notAllowed.status, 403);
  });

  // ---------------- the gate ----------------
  test('reading is one permission and changing is another, and a portal account gets neither', async () => {
    // the teacher can see none of it: they hold neither platform.view nor core.audit
    for (const p of ['/settings', '/audit', '/users', '/roles', '/sequences', '/school']) {
      assert.equal((await call(p, null, 'GET', teacher.cookie)).status, 403, `GET ${p} for a teacher`);
    }
    for (const [p, body, method] of [['/settings', { key: 'fees.due_day', value: 5 }, 'PUT'], ['/users', { displayName: 'X', phone: '01711000004', roles: ['staff'] }, 'POST'], ['/school', { name: 'Not this' }, 'PATCH']]) {
      assert.equal((await call(p, body, method, teacher.cookie)).status, 403, `${method} ${p} for a teacher`);
    }
    // and signed out is 401, not a peek
    assert.equal((await call('/settings', null, 'GET', null)).status, 401);

    // a guardian is refused as a matter of account type, whatever role somebody gave them
    const g = await app.auth.createUser({ schoolId: sid, userType: 'guardian', displayName: 'A Parent', phone: '01711000005', password: 'parent-pass-1', roles: ['super_admin'] });
    assert.ok(g);
    const parentCookie = await login('01711000005', 'parent-pass-1');
    const refused = await call('/settings', null, 'GET', parentCookie);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /school-staff endpoint/);
  });
});

/** The next date that falls on `dow` (0 = Sunday), as 'YYYY-MM-DD' in UTC. */
function nextDow(dow) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((dow - d.getUTCDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}
