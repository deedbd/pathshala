// Phase 1 exit criteria: 1,500 students imported in < 2 min; 40-section timetable with zero clashes;
// school website live with a working admission form; guardian portal shows the child's card and timetable.
//   node --test tests/phase1.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-p1');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'p1-key-'.padEnd(64, 'x'), CRON_KEY: 'cron-p1', UPLOADS_DIR: 'tests/.tmp-p1/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-p1/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');
const XLSX = createRequire(path.join(root, 'packages/core/package.json'))('xlsx');

let app, schoolId, adminId, yearId, http, baseUrl, cookie, classes, sections, versionId, guardianCookie, childId;
const t0 = Date.now();

describe('phase 1', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Phase One School', schoolNameBn: 'ফেজ ওয়ান স্কুল', schoolCode: 'P1', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01711111111', adminEmail: 'admin@p1.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId; adminId = r.userId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@p1.test', password: 'secret-pass-1' }) });
    cookie = login.headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`phase 1 finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 200)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };

  test('installer preset: current year, classes, subjects, sections, periods, rooms, website', async () => {
    const ov = await api('/academic/overview');
    assert.ok(ov.year && Number(ov.year.is_current), 'current year created');
    yearId = String(ov.year.id);
    assert.ok(ov.structure.classes >= 10 && ov.structure.subjects >= 6 && ov.structure.sections >= 10 && ov.structure.classSubjects >= 60, JSON.stringify(ov.structure));
    assert.ok((await app.academic.periods(schoolId)).length >= 9, 'default periods');
    assert.ok(ov.rooms.length >= 6);
    assert.deepEqual(ov.weeklyOffs, [5, 6], 'Fri/Sat weekend');
    assert.ok(await app.cms.home(schoolId), 'home page published');
    classes = await app.academic.classes(schoolId);
  });

  test('academic: sections to 40, teachers, class-subject matrix, holiday event', async () => {
    // 13 preset classes × 3 sections ≈ 39 + 1 extra = 40 sections
    let n = 0;
    const have = (await app.academic.sections(schoolId, yearId)).length;
    outer: for (const name of ['B', 'C', 'D']) for (const c of classes) { if (have + n >= 40) break outer; await app.academic.createSection(schoolId, { academicYearId: yearId, classId: String(c.id), name }); n++; }
    sections = await app.academic.sections(schoolId, yearId);
    assert.equal(sections.length, 40, `sections: ${sections.length}`);
    // every section has its own room (a shared room is a real clash the generator must respect)
    const campus = await app.academic.mainCampus(schoolId);
    let rooms = await app.academic.rooms(schoolId);
    for (let i = rooms.length; i < 40; i++) await app.academic.createRoom(schoolId, { campusId: String(campus.id), name: `Room ${200 + i}`, capacity: 45 });
    rooms = await app.academic.rooms(schoolId);
    for (let i = 0; i < sections.length; i++) await app.academic.updateSection(schoolId, String(sections[i].id), { roomId: String(rooms[i].id) });
    sections = await app.academic.sections(schoolId, yearId);
    const subjects = await app.academic.subjects(schoolId);
    // 40 sections × ~30 periods = 1,200 teacher-periods a week; a teacher has 40 slots, so 44 teachers leave slack
    for (let i = 0; i < 44; i++) await app.people.createStaff(schoolId, { firstName: `Teacher${i + 1}`, lastName: 'Ms', phone: `0172${String(1000000 + i).slice(1)}`, staffCategory: 'teaching', subjectIds: [String(subjects[i % subjects.length].id), String(subjects[(i + 1) % subjects.length].id)], createAccount: true });
    assert.equal((await app.people.staff(schoolId, { teachingOnly: true })).length, 44);
    const holiday = await api('/academic/calendar', { title: 'Victory Day', eventType: 'holiday', startDate: '2026-12-16', endDate: '2026-12-16' });
    assert.ok(holiday.id);
    await app.relay.run();
    assert.equal(await app.academic.isHoliday(schoolId, '2026-12-16'), true);
    assert.equal(await app.academic.isHoliday(schoolId, '2026-12-18'), true, 'Friday is a weekly off');
    assert.equal(await app.academic.isHoliday(schoolId, '2026-12-20'), false);
  });

  test('people: admit a student with guardians (sibling link by phone), numbering, auto section, portal account', async () => {
    const cls = classes[5];
    const a = await api('/people/students', { firstName: 'Ayesha', lastName: 'Rahman', nameBn: 'আয়েশা', gender: 'female', dateOfBirth: '2014-03-02', classId: String(cls.id), guardians: [{ fullName: 'Abdur Rahman', phone: '01712345678', relation: 'father', isPrimary: true }] });
    assert.match(a.admissionNo, /^\d{4}-\d{5}$/, a.admissionNo);
    const b = await api('/people/students', { firstName: 'Bilal', lastName: 'Rahman', gender: 'male', dateOfBirth: '2016-07-09', classId: String(classes[3].id), guardians: [{ fullName: 'Abdur Rahman', phone: '+8801712345678', relation: 'father', isPrimary: true }] });
    assert.equal(a.guardianIds[0], b.guardianIds[0], 'same guardian row for both children');
    const prof = await api(`/people/students/${a.id}`);
    assert.equal(prof.siblings.length, 1); assert.equal(prof.enrollments[0].roll_no, '1');
    assert.ok(prof.current_section_id, 'auto-assigned section');
    childId = a.id;
    const acc = await api(`/people/guardians/${a.guardianIds[0]}/account`, {});
    assert.ok(acc.userId);
    await assert.rejects(() => api('/people/students', { firstName: 'X', gender: 'male', dateOfBirth: '2010-01-01', classId: String(cls.id), admissionNo: a.admissionNo }), /already exists/);
  });

  test('import: 1,500 students from Excel in under 2 minutes, error file for bad rows', async () => {
    const rows = [['admission_no', 'first_name', 'last_name', 'gender', 'date_of_birth', 'class', 'section', 'guardian_name', 'guardian_phone', 'guardian_relation']];
    const secByClass = new Map(); for (const s of sections) secByClass.set(String(s.class_id), [...(secByClass.get(String(s.class_id)) ?? []), s]);
    for (let i = 0; i < 1500; i++) {
      const cls = classes[i % classes.length]; const secs = secByClass.get(String(cls.id));
      rows.push([`IMP${String(i + 1).padStart(5, '0')}`, `Student${i + 1}`, 'Test', i % 2 ? 'female' : 'male', `20${String(10 + (i % 8)).padStart(2, '0')}-0${1 + (i % 9)}-15`, cls.name, secs[i % secs.length].name, `Guardian ${Math.floor(i / 2) + 1}`, `018${String(10000000 + Math.floor(i / 2)).slice(0, 8)}`, 'father']);
    }
    rows.push(['BAD001', '', 'NoFirstName', 'male', '2012-01-01', classes[0].name, 'A', 'G', '01800000001', 'father']);
    rows.push(['BAD002', 'Wrong', 'Class', 'male', '2012-01-01', 'Class 99', 'A', 'G', '01800000002', 'father']);
    rows.push(['BAD003', 'Bad', 'Phone', 'female', '31/13/2012', classes[0].name, 'A', 'G', '12345', 'father']);
    const ws = XLSX.utils.aoa_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Students');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const started = Date.now();
    const r = await api('/import/students', { fileName: 'students.xlsx', base64: Buffer.from(buf).toString('base64') });
    assert.equal(r.valid, 1500); assert.equal(r.invalid, 3, JSON.stringify(r.errors));
    let st; let guard = 0;
    do { await app.adapters.queue.drain(5); st = await api(`/import/jobs/${r.id}`); } while (st.status !== 'success' && ++guard < 200);
    const ms = Date.now() - started;
    assert.equal(st.status, 'success', JSON.stringify(st));
    assert.equal(st.success_rows, 1500); assert.equal(st.error_rows, 3);
    assert.ok(st.errors_file_id, 'error workbook stored');
    assert.ok(ms < 120_000, `import took ${ms} ms`);
    console.log(`import of 1,500 rows: ${ms} ms on ${app.db.engine}`);
    const count = await app.db.count('students', { school_id: schoolId, status: 'active' });
    assert.equal(count, 1502);
    assert.equal(await app.db.count('guardians', { school_id: schoolId }), 750 + 1, 'guardians shared between siblings');
    const errUrl = await api(`/files/${st.errors_file_id}/url`);
    const signed = new URL(errUrl.url); const dl = await fetch(`${baseUrl}${signed.pathname}${signed.search}`); assert.equal(dl.status, 200);
    const errWb = XLSX.read(Buffer.from(await dl.arrayBuffer()), { type: 'buffer' });
    const errRows = XLSX.utils.sheet_to_json(errWb.Sheets[errWb.SheetNames[0]]);
    assert.equal(errRows.length, 3); assert.ok(errRows.every(x => x.Problems));
  });

  test('timetable: auto-assign teachers, generate for 40 sections with zero clashes, publish, substitutions', async () => {
    const aa = await api('/timetable/auto-assign', {});
    assert.equal(aa.unassigned, 0, JSON.stringify(aa));
    const g = await api('/timetable/generate', { seed: 7 });
    assert.equal(g.sections, 40); assert.equal(g.clashes, 0, JSON.stringify(g));
    assert.ok(g.placed >= 0.95 * (g.placed + g.unplaced), `placed ${g.placed}, unplaced ${g.unplaced}`);
    console.log(`timetable: ${g.placed} periods placed, ${g.unplaced} unplaced, score ${g.score}`);
    versionId = g.versionId;
    const grid = await api(`/timetable/versions/${versionId}/grid?sectionId=${sections[0].id}`);
    assert.equal(grid.clashes.length, 0);
    assert.ok(grid.slots.length >= 25, `section slots ${grid.slots.length}`);
    // manual edit: putting the same teacher twice in one period is refused
    const s = grid.slots[0]; const other = sections.find(x => x.id !== sections[0].id);
    await assert.rejects(() => api(`/timetable/versions/${versionId}/slots`, { sectionId: String(other.id), dayOfWeek: Number(s.day_of_week), periodId: s.period_id, classSubjectId: s.class_subject_id, teacherId: s.teacher_id }, 'PUT'), /409|busy/);
    await api(`/timetable/versions/${versionId}/publish`, {});
    await app.relay.run();
    assert.equal((await app.timetable.publishedVersion(schoolId, yearId)).id, versionId);
    // a teacher is absent next Monday → substitutes suggested for each of their periods
    const d = new Date(); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); const monday = d.toISOString().slice(0, 10);
    const subs = await api('/timetable/substitutions/suggest', { teacherId: s.teacher_id, onDate: monday });
    const mine = (await app.timetable.teacherGrid(schoolId, versionId, s.teacher_id)).filter(x => Number(x.day_of_week) === 1);
    assert.equal(subs.length, mine.length, 'one suggestion per period the teacher has that day');
    assert.ok(subs.every(x => x.substituteTeacherId), 'every period got a free substitute');
    await api(`/timetable/substitutions/${subs[0].substitutionId}`, { status: 'approved' });
    assert.equal((await app.timetable.substitutions(schoolId, monday)).find(x => x.id === subs[0].substitutionId).status, 'approved');
  });

  test('curriculum: syllabus units, lesson plans, progress, behind-schedule alert', async () => {
    const cs = (await app.academic.classSubjects(schoolId, yearId, String(classes[5].id)))[0];
    const sid = await api('/curriculum/syllabi', { classSubjectId: cs.id, title: 'Annual', units: [{ title: 'Unit 1', plannedEndDate: '2020-01-01' }, { title: 'Unit 2', plannedEndDate: '2020-02-01' }, { title: 'Unit 3' }] });
    const units = await api(`/curriculum/syllabi/${sid.id}/units`);
    assert.equal(units.length, 3);
    const teacher = (await app.people.staff(schoolId, { teachingOnly: true }))[0];
    const sec = sections.find(x => x.class_id === classes[5].id);
    const lp = await api('/curriculum/lessons', { teacherId: String(teacher.id), sectionId: String(sec.id), classSubjectId: cs.id, unitId: units[0].id, planDate: '2026-09-01', topic: 'Intro' });
    await api(`/curriculum/lessons/${lp.id}/taught`, { status: 'taught' });
    const prog = (await api('/curriculum/progress')).find(p => p.syllabus_id === sid.id && p.section_id === sec.id);
    assert.equal(Number(prog.taught_units), 1); assert.equal(Number(prog.pct), 33.33);
    const lag = await app.curriculum.syllabusLagCheck(schoolId);
    assert.ok(lag.overdueUnits >= 1 && lag.alerts >= 1, JSON.stringify(lag));
    await app.relay.run();
  });

  test('website: public home + admission enquiry → rule A1 runs; contact message', async () => {
    const site = await (await fetch(`${baseUrl}/api/public/site`)).json();
    assert.equal(site.school.name, 'Phase One School'); assert.ok(site.page.blocks.some(b => b.type === 'admission_cta'));
    await api('/cms/notices', { title: 'Winter break', body: 'School closed 20–25 Dec', noticeType: 'holiday', isPinned: true });
    const site2 = await (await fetch(`${baseUrl}/api/public/site`)).json();
    assert.equal(site2.notices[0].title, 'Winter break');
    const enq = await fetch(`${baseUrl}/api/public/site/enquiry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentName: 'Rafi', guardianName: 'Karim', phone: '01911111111', classId: String(classes[2].id) }) });
    assert.equal(enq.status, 200, await enq.text());
    await app.relay.run(); await app.adapters.queue.drain(10);
    const runs = await app.db.query(`SELECT r.status FROM automation_runs r JOIN automation_rules a ON a.id = r.rule_id WHERE a.code = 'A1' AND a.school_id = ?`, [schoolId]);
    assert.equal(runs.length, 1, 'rule A1 (enquiry.created) ran'); assert.equal(runs[0].status, 'success');
    assert.ok((await app.db.count('notifications', { school_id: schoolId, event_key: 'rule.a1' })) >= 1, 'A1 notified the admissions desk');
    assert.equal((await app.cms.enquiries(schoolId))[0].student_name, 'Rafi');
    const bad = await fetch(`${baseUrl}/api/public/site/enquiry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentName: 'R', guardianName: 'K', phone: '12345' }) });
    assert.equal(bad.status, 400);
    const contact = await fetch(`${baseUrl}/api/public/site/contact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Visitor', message: 'When does admission open?' }) });
    assert.equal(contact.status, 200);
    const page = await fetch(`${baseUrl}/api/public/site/pages/admission`); assert.equal(page.status, 200);
  });

  test('guardian portal: OTP login by phone, children, child card with timetable', async () => {
    const req = await fetch(`${baseUrl}/api/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: '01712345678', channel: 'sms' }) });
    const otp = await req.json(); assert.ok(otp.code, JSON.stringify(otp));
    const ver = await fetch(`${baseUrl}/api/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: '01712345678', code: otp.code }) });
    assert.equal(ver.status, 200, await ver.text());
    guardianCookie = ver.headers.get('set-cookie').split(';')[0];
    const me = await api('/portal/me', undefined, 'GET', { cookie: guardianCookie });
    assert.equal(me.children.length, 2, 'both siblings');
    const child = await api(`/portal/children/${childId}`, undefined, 'GET', { cookie: guardianCookie });
    assert.equal(child.child.id, childId);
    assert.ok(child.timetable.length >= 25, 'published timetable visible to the guardian');
    assert.ok(child.notices.length >= 1);
    const forbidden = await fetch(`${baseUrl}/api/people/students`, { headers: { cookie: guardianCookie } });
    assert.equal(forbidden.status, 403, 'guardian cannot list students');
    const other = await fetch(`${baseUrl}/api/portal/children/${(await app.db.findMany('students', { school_id: schoolId }, { limit: 1, orderBy: 'admission_no DESC' }))[0].id}`, { headers: { cookie: guardianCookie } });
    assert.equal(other.status, 403, 'not their child');
  });

  test('ssr pages render: /site, /portal (guardian), console pages (admin)', async () => {
    for (const [p, ck, needle] of [['/site', '', 'Phase One School'], ['/site/admission', '', 'admission'], ['/portal', guardianCookie, 'Ayesha'], [`/portal/child/${childId}`, guardianCookie, 'Ayesha'], ['/academic', cookie, 'Class'], ['/students?q=Ayesha', cookie, 'Ayesha'], ['/timetable', cookie, 'Auto'], ['/staff', cookie, 'Teacher1'], ['/import', cookie, 'template'], ['/syllabus', cookie, 'Annual'], ['/calendar', cookie, 'Victory'], ['/website', cookie, 'Winter']]) {
      const r = await fetch(`${baseUrl}${p}`, { headers: ck ? { cookie: ck } : {} });
      const html = await r.text();
      assert.equal(r.status, 200, `${p} → ${r.status}`);
      assert.ok(html.toLowerCase().includes(String(needle).toLowerCase()), `${p} should mention ${needle}`);
    }
  });
});
