// Year 5: the voice line a guardian rings.
// A guardian who cannot read gets nothing out of an SMS, a portal or a report card PDF — they ring
// the school. This drives a whole call through the webhook the IVR gateway posts to: a number the
// school does not know, a guardian with two children choosing one by name, today's attendance and
// this month's dues spoken in Bangla from the real rows, a callback that raises one task however
// often the gateway retries, and a gateway with the wrong secret being refused at the door.
//   node --test tests/ivr.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-ivr');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'ivr-key'.padEnd(64, 'x'), CRON_KEY: 'cron-ivr', UPLOADS_DIR: 'tests/.tmp-ivr/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
delete process.env.IVR_SECRET;   // the per-school secret is the one under test
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-ivr/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

const SECRET = 'ivr-line-secret-2026';
const FATHER = '+8801911000001';   // one number, two children
const AUNT = '+8801911000002';     // another family altogether
const STRANGER = '01911000009';

let app, schoolId, http, baseUrl, cookie, rahim, karim, sumi;
const t0 = Date.now();
const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
// the school's own date, which is what the register is keyed by — not UTC
const dhakaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

describe('year 5: voice-first guardian interactions', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Kanthal High School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01799999998', adminEmail: 'admin@ivr.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    const classes = await app.academic.classes(schoolId);
    const classId = String(classes[4].id);
    const father = { fullName: 'Abdul Karim', phone: FATHER, relation: 'father', isPrimary: true, paysFees: true };
    rahim = await app.people.createStudent(schoolId, { firstName: 'Rahim', nameBn: 'রহিম', gender: 'male', dateOfBirth: '2012-02-02', classId, admissionDate: '2021-01-05', guardians: [father] });
    karim = await app.people.createStudent(schoolId, { firstName: 'Karim', nameBn: 'করিম', gender: 'male', dateOfBirth: '2014-03-03', classId, admissionDate: '2021-01-05', guardians: [father] });
    sumi = await app.people.createStudent(schoolId, { firstName: 'Sumi', nameBn: 'সুমি', gender: 'female', dateOfBirth: '2013-04-04', classId, admissionDate: '2021-01-05', guardians: [{ fullName: 'Rehana Begum', phone: AUNT, relation: 'mother', isPrimary: true, paysFees: true }] });

    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@ivr.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`ivr finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET') => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  /** One step of a call, exactly as the gateway would post it. */
  const call = async (from, keys, opts = {}) => {
    const r = await fetch(`${baseUrl}/api/ivr/${opts.school ?? schoolId}/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IVR-Secret': opts.secret ?? SECRET },
      body: JSON.stringify({ callId: opts.callId ?? `CALL-${from}-${keys || 'start'}`, from, digits: keys ?? '' }),
    });
    return { status: r.status, body: await r.json() };
  };

  // ---------------- the door ----------------
  test('the webhook is the school’s own, and a gateway without its secret gets nowhere', async () => {
    // before a secret is configured the line is closed, not open
    assert.equal((await call(FATHER, '')).status, 403);
    const set = await api('/ivr/secret', { secret: SECRET });
    assert.equal(set.configured, true);
    assert.match(set.webhookUrl, /\/api\/ivr\/.+\/step$/);
    // and the secret itself never comes back out of settings
    assert.equal(JSON.stringify((await api('/settings'))['ivr.webhook_secret']).includes(SECRET), false);

    assert.equal((await call(FATHER, '', { secret: 'wrong-secret-entirely' })).status, 403);
    assert.equal((await call(FATHER, '', { secret: '' })).status, 403);
    // an unknown school answers exactly as a wrong secret does: 404 here would tell anyone who
    // asked which schools this host serves, before anything had been authenticated
    assert.equal((await call(FATHER, '', { school: 'no-such-school' })).status, 403);
    assert.equal((await call(FATHER, '')).status, 200);
  });

  test('a number the school does not know is answered politely and told nothing', async () => {
    const { body } = await call(STRANGER, '');
    assert.equal(body.end, true, 'there is nothing to keep an unknown caller on the line for');
    assert.match(body.say, /অফিসে যোগাযোগ/, 'told to contact the office');
    assert.equal(body.accept, '');
    for (const name of ['রহিম', 'করিম', 'সুমি', 'Rahim', 'Karim', 'Sumi']) assert.equal(body.say.includes(name), false, 'and never a child’s name');
    assert.equal(/password|পাসওয়ার্ড|জন্ম|admission/i.test(body.say), false, 'a caller who could be anybody is never asked for a secret');
    // it is still in the register: a school should see which numbers rang and got nowhere
    const logged = (await api('/ivr/calls')).find(c => String(c.phone) === '+8801911000009');
    assert.ok(logged, 'the unknown call is logged');
    assert.match(String(logged.purpose), /not on file/);
  });

  // ---------------- the call ----------------
  test('a guardian with two children is asked which child, by name', async () => {
    const { body } = await call(FATHER, '');
    assert.match(body.say, /স্বাগতম/, 'greeted once, at the start');
    assert.match(body.say, /রহিম/); assert.match(body.say, /করিম/);
    assert.equal(body.say.includes('সুমি'), false, 'and never a child from another family');
    assert.equal(body.accept, '12', 'two children, two keys');
    assert.equal(body.end, false);
    assert.match(body.next, /keys=$/, 'the gateway is told where to send the next key');
  });

  test('choosing a child reaches a menu short enough to remember', async () => {
    const { body } = await call(FATHER, '1');
    assert.equal(body.accept, '12349');
    assert.equal(body.say.includes('স্বাগতম'), false, 'the welcome is not read out a second time');
    for (const d of ['১', '২', '৩', '৪', '৯']) assert.ok(body.say.includes(d), `the menu offers ${d}`);
    assert.ok(body.say.length < 400, 'a menu longer than this loses the caller');
    assert.match(body.next, /keys=1$/);
  });

  test('attendance is the mark on today’s register, spoken plainly', async () => {
    const today = dhakaToday();
    await app.attendance.mark(schoolId, rahim.id, today, 'absent', { notify: false });
    await app.attendance.mark(schoolId, karim.id, today, 'present', { notify: false });

    const absent = (await call(FATHER, '11')).body;
    assert.match(absent.say, /রহিম/); assert.match(absent.say, /অনুপস্থিত/);
    assert.equal(absent.end, false);
    assert.equal(absent.accept, '012349', 'and the caller can ask something else without ringing again');

    const present = (await call(FATHER, '21')).body;
    assert.match(present.say, /করিম/); assert.match(present.say, /উপস্থিত/);
    // pressing 0 goes back to the menu rather than repeating the answer
    assert.match((await call(FATHER, '210')).body.say, /চাপুন/);
  });

  test('dues are the real balance, in whole taka, for that child only', async () => {
    await app.fees.createInvoice(schoolId, { studentId: rahim.id, items: [{ description: 'Tuition', amount: 1500 }] });
    const rahimDues = (await call(FATHER, '12')).body;
    assert.match(rahimDues.say, /১৫০০/, 'Bangla numerals, so a Bangla voice reads the figure');
    assert.match(rahimDues.say, /টাকা/);
    assert.equal(rahimDues.say.includes('.'), false, 'paisa on the telephone helps nobody');
    // the brother owes nothing, and hearing about one child never leaks the other's bill
    const karimDues = (await call(FATHER, '22')).body;
    assert.match(karimDues.say, /করিম/);
    assert.equal(karimDues.say.includes('১৫০০'), false);
  });

  test('the next exam and the last result come from the school’s own rows', async () => {
    const noResult = (await call(FATHER, '14')).body;
    assert.match(noResult.say, /প্রকাশ হয়নি/, 'nothing published is said as nothing published, not invented');
    const noExam = (await call(FATHER, '13')).body;
    assert.match(noExam.say, /পরীক্ষার তারিখ দেওয়া হয়নি/);

    // a draft schedule has been sent to nobody, so the line does not read it out either
    const examId = (await app.assessment.createExam(schoolId, { name: 'অর্ধবার্ষিক', startDate: day(20), endDate: day(24) })).id;
    const draft = (await call(FATHER, '13')).body;
    assert.match(draft.say, /পরীক্ষার তারিখ দেওয়া হয়নি/, 'an exam still in draft is not announced');
    await app.db.update('exams', { status: 'scheduled' }, { id: examId });
    const exam = (await call(FATHER, '13')).body;
    assert.match(exam.say, /অর্ধবার্ষিক/);
    const d = day(20).split('-').map(Number);
    assert.ok(exam.say.includes(String(d[2]).replace(/\d/g, x => '০১২৩৪৫৬৭৮৯'[Number(x)])), 'the date is spoken in Bangla numerals');
  });

  test('a guardian cannot reach a child who is not theirs', async () => {
    // there are two keys on offer; a third is not another family's child, it is a miss
    const miss = (await call(FATHER, '3')).body;
    assert.match(miss.say, /বুঝতে পারিনি/);
    assert.equal(miss.say.includes('সুমি'), false);
    assert.equal(miss.end, false);
    // the other family's number hears about their own child and nobody else's
    const aunt = (await call(AUNT, '')).body;
    assert.match(aunt.say, /সুমি/);
    for (const name of ['রহিম', 'করিম']) assert.equal(aunt.say.includes(name), false);
    assert.equal(aunt.accept, '12349', 'one child needs no chooser — asking “which child?” of a mother with one is just a delay');
  });

  test('a caller the line cannot understand is let go politely rather than kept on hold', async () => {
    const lost = (await call(FATHER, '1555')).body;
    assert.equal(lost.end, true);
    assert.match(lost.say, /আবার ফোন করুন|অফিসে যোগাযোগ/);
    assert.equal(lost.accept, '');
  });

  // ---------------- what a call leaves behind ----------------
  test('asking for a callback raises one task, however often the gateway retries', async () => {
    const before = (await app.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ? AND task_type = 'frontoffice.callback'`, [schoolId]))[0];
    const callId = 'CALL-callback-01';
    const first = (await call(FATHER, '19', { callId })).body;
    assert.equal(first.end, true);
    assert.match(first.say, /ফোন করা হবে/);
    // the gateway times out and posts the same step again, as they all do
    await call(FATHER, '19', { callId });
    await call(FATHER, '19', { callId });
    const after = (await app.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ? AND task_type = 'frontoffice.callback'`, [schoolId]))[0];
    assert.equal(Number(after.n) - Number(before.n), 1, 'the office is asked to ring back once');

    for (let i = 0; i < 10; i++) await app.tick({ budgetMs: 300 });
    const events = await app.db.query(`SELECT event_type FROM outbox_events WHERE school_id = ? AND event_type LIKE 'ivr.%'`, [schoolId]);
    assert.ok(events.some(e => String(e.event_type) === 'ivr.callback_requested'));
    assert.ok(events.some(e => String(e.event_type) === 'ivr.call_received'));
  });

  test('one call is one line in the register, saying what was asked and never what was answered', async () => {
    const callId = 'CALL-register-01';
    await call(FATHER, '', { callId });
    await call(FATHER, '1', { callId });
    await call(FATHER, '11', { callId });
    await call(FATHER, '112', { callId });
    const rows = await api('/ivr/calls');
    const mine = rows.filter(c => String(c.purpose ?? '').includes('attendance') && String(c.purpose).includes('fees due'));
    assert.equal(mine.length >= 1, true, 'the line says what the caller asked for');
    const row = mine[0];
    assert.equal(String(row.direction), 'inbound');
    assert.equal(String(row.phone), FATHER);
    assert.match(String(row.caller_name), /Abdul Karim/);
    // the register is read with frontoffice.view; a clerk refused the fees page must not read a
    // child's balance out of a call note, so the note says what was asked and not what was said
    const notes = String(row.notes ?? '');
    assert.match(notes, /fees due/, 'the note says which key was pressed');
    assert.equal(notes.includes('১৫০০'), false, 'and never the figure the caller was told');
    assert.equal(notes.includes('রহিম'), false, 'nor the answer it was said in');
    assert.match(String(row.notes), /\[1\]/);
    assert.match(String(row.notes), /\[2\]/);
    // four requests, one row
    const same = (await app.db.query(`SELECT COUNT(*) AS n FROM call_logs WHERE school_id = ? AND id = ?`, [schoolId, String(row.id)]))[0];
    assert.equal(Number(same.n), 1);
  });

  test('the school can read out its own menu before it goes live', async () => {
    const menu = await api('/ivr/menu');
    assert.equal(menu.locale, 'bn');
    assert.match(menu.welcome, /Kanthal|স্বাগতম/);
    assert.equal(menu.choices.length, 5);
    assert.deepEqual(menu.choices.map(c => c.key), ['1', '2', '3', '4', '9']);
  });

  test('an English school hears English, from the same rows', async () => {
    await app.db.execute(`UPDATE schools SET locale = 'en' WHERE id = ?`, [schoolId]);
    const chooser = (await call(FATHER, '')).body;
    assert.equal(chooser.locale, 'en');
    assert.match(chooser.say, /Which child\?/);
    assert.match(chooser.say, /Press 1 for Rahim/);
    const dues = (await call(FATHER, '12')).body;
    assert.match(dues.say, /1500 taka on 1 bill\./, 'the same figure, in the language the school chose');
    await app.db.execute(`UPDATE schools SET locale = 'bn' WHERE id = ?`, [schoolId]);
  });

  test('one number cannot hold the line open for everybody else', async () => {
    const flooder = '01911000077';
    let busy = null;
    for (let i = 0; i < 60 && !busy; i++) {
      const b = (await call(flooder, '', { callId: 'CALL-flood-01' })).body;
      if (/ব্যস্ত/.test(b.say)) busy = b;
    }
    assert.ok(busy, 'a number that keeps ringing is asked to try again later');
    assert.equal(busy.end, true);
    // and everybody else is unaffected
    assert.equal((await call(AUNT, '')).body.end, false);
  });
});
