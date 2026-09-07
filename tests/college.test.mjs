// Year 3: college and coaching modes.
// A programme measured in credits rather than years; a semester register a student cannot overfill;
// a GPA weighted by credit, where a retake replaces the failure it repeats; a certificate that waits
// for the credits to be earned; and a coaching batch sold on instalments whose seat is handed over by
// the payment, never by the plan.
//   node --test tests/college.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-college');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'college-key'.padEnd(64, 'x'), CRON_KEY: 'cron-college', UPLOADS_DIR: 'tests/.tmp-college/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-college/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, schoolId, http, baseUrl, cookie, yearId, programId, scienceId, student, coachStudent;
let sem1, sem2, sem3, courseId, planId, deptId, hodId, outsiderId;
const cs = {};   // subject code → class_subject id, for XI Science
const reg = {};  // "term:subject" → registration id
const t0 = Date.now();
const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('year 3: college and coaching modes', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Shahjalal College', institutionType: 'college', locale: 'bn', adminName: 'Principal', adminPhone: '01755555555', adminEmail: 'admin@college.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    yearId = String((await app.academic.currentYear(schoolId)).id);

    // three semesters: the third is where the failed paper ends up being retaken
    sem1 = await app.academic.addTerm(schoolId, yearId, { name: 'Semester 1', sequence: 1, startDate: day(-120), endDate: day(10), kind: 'semester' });
    sem2 = await app.academic.addTerm(schoolId, yearId, { name: 'Semester 2', sequence: 2, startDate: day(-59), endDate: day(30), kind: 'semester' });
    sem3 = await app.academic.addTerm(schoolId, yearId, { name: 'Semester 3', sequence: 3, startDate: day(-7), endDate: day(60), kind: 'semester' });

    const classes = await app.academic.classes(schoolId);
    scienceId = String(classes.find(c => c.name === 'XI Science').id);
    student = await app.people.createStudent(schoolId, { firstName: 'Nabila', lastName: 'Rahman', gender: 'female', dateOfBirth: '2007-03-11', classId: scienceId, admissionDate: day(-150), guardians: [{ fullName: 'Rahman Sahib', phone: '01911111111', relation: 'father', isPrimary: true, paysFees: true }] });
    coachStudent = await app.people.createStudent(schoolId, { firstName: 'Tanvir', lastName: 'Hasan', gender: 'male', dateOfBirth: '2008-06-01', classId: scienceId, admissionDate: day(-40), guardians: [{ fullName: 'Hasan Sahib', phone: '01922222222', relation: 'father', isPrimary: true, paysFees: true }] });

    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@college.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`college finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET') => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 160)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const register = (studentId, termId, codes) => api('/college/registrations', { studentId, termId, classSubjectIds: codes.map(c => cs[c]) });
  const rows = (termId, studentId = student.id) => api(`/college/registrations?termId=${termId}&studentId=${studentId}`);

  // ---------------- the programme ----------------
  test('a programme is measured in credits, and every subject says what it is worth', async () => {
    deptId = (await api('/college/departments', { name: 'Science', kind: 'academic' })).id;
    const made = await api('/college/programs', { name: 'HSC Science', code: 'HSC-SCI', level: 'higher_secondary', durationTerms: 2, totalCredits: 12, departmentId: deptId, classIds: [scienceId] });
    programId = made.id;
    assert.equal(made.ceiling, 6, '12 credits over 2 semesters is 6 a semester');

    // the class-subject matrix the preset built carries credit 1 until somebody says otherwise
    const matrix = await app.academic.classSubjects(schoolId, yearId, scienceId);
    for (const row of matrix) cs[String(row.subject_code)] = String(row.id);
    const weights = { BAN: 4, ENG: 2, PHY: 4, CHE: 4, ICT: 2, BIO: 3 };
    for (const [code, credit] of Object.entries(weights)) {
      const row = matrix.find(m => String(m.subject_code) === code);
      await api('/college/credits', { academicYearId: yearId, classId: scienceId, subjectId: String(row.subject_id), credit });
    }

    const view = await api(`/college/programs/${programId}`);
    assert.equal(view.creditsRequired, 12);
    assert.equal(view.ceiling, 6);
    assert.equal(view.creditsOffered, 19, 'the programme offers more than it demands — that is what an elective is');
    assert.equal(view.classes.length, 1);
    assert.equal(Number((await api('/college/programs')).find(p => String(p.id) === programId).students), 2);
  });

  // ---------------- registration ----------------
  test('a student cannot register for more credits than the programme allows in a term', async () => {
    await assert.rejects(() => register(student.id, sem1, ['BAN', 'PHY']), /allows 6 credits a term/);
    assert.equal((await rows(sem1)).length, 0, 'and nothing at all was written: a half-registration is worse than none');

    const done = await register(student.id, sem1, ['BAN', 'ENG']);
    assert.equal(done.credits, 6);
    assert.equal(done.ceiling, 6);
    assert.equal(done.registered.length, 2);
    await assert.rejects(() => register(student.id, sem1, ['ICT']), /would make 8/);

    const load = await api(`/college/registrations/load?studentId=${student.id}&termId=${sem1}`);
    assert.equal(load.credits, 6);
    assert.equal(load.room, 0);
  });

  test('a subject another class studies, and a student who is not on the roll, are both refused', async () => {
    const humanities = String((await app.academic.classes(schoolId)).find(c => c.name === 'XI Humanities').id);
    const other = (await app.academic.classSubjects(schoolId, yearId, humanities))[0];
    await assert.rejects(() => api('/college/registrations', { studentId: student.id, termId: sem1, classSubjectIds: [String(other.id)] }), /belongs to another class/);
    await assert.rejects(() => api('/college/registrations', { studentId: 'NOBODY00000000000000000000', termId: sem1, classSubjectIds: [cs.ICT] }), /not on the roll/);
  });

  test('dropping frees the credit it was holding, and the seat can be taken again', async () => {
    const english = (await rows(sem1)).find(r => String(r.subject_code) === 'ENG');
    const dropped = await api(`/college/registrations/${String(english.id)}/drop`, { reason: 'changed her mind' });
    assert.equal(dropped.freedCredits, 2);
    assert.equal((await api(`/college/registrations/load?studentId=${student.id}&termId=${sem1}`)).room, 2);
    // re-registering the same paper reuses the row rather than colliding with it
    const again = await register(student.id, sem1, ['ENG']);
    assert.equal(again.credits, 6);
    assert.equal((await rows(sem1)).filter(r => String(r.subject_code) === 'ENG').length, 1);
  });

  // ---------------- results and the GPA ----------------
  test('the GPA is weighted by credit, not by how many subjects are on the sheet', async () => {
    for (const r of await rows(sem1)) reg[`1:${r.subject_code}`] = String(r.id);
    const pass = await api(`/college/registrations/${reg['1:BAN']}/result`, { percent: 85 });
    assert.equal(pass.grade, 'A+');
    assert.equal(pass.gradePoint, 5);
    assert.equal(pass.creditEarned, 4);
    const fail = await api(`/college/registrations/${reg['1:ENG']}/result`, { percent: 30 });
    assert.equal(fail.status, 'failed');
    assert.equal(fail.creditEarned, 0, 'a failed paper earns none of its credit');

    const t = await api(`/college/transcript/${student.id}?programId=${programId}`);
    const term1 = t.terms.find(x => x.termId === sem1);
    assert.equal(term1.creditsAttempted, 6);
    assert.equal(term1.creditsEarned, 4, 'the failure still counts as attempted — that is what makes a transcript honest');
    // (5.0 × 4) + (0 × 2) over 6 credits = 3.33; averaging the two grade points alone would say 2.50
    assert.equal(term1.gpa, 3.33);
    assert.notEqual(term1.gpa, 2.5);
    assert.equal(t.creditsEarned, 4);
  });

  test('a retake replaces the failure it repeats instead of being counted alongside it', async () => {
    await register(student.id, sem2, ['ENG', 'PHY']);
    for (const r of await rows(sem2)) reg[`2:${r.subject_code}`] = String(r.id);
    await api(`/college/registrations/${reg['2:ENG']}/result`, { percent: 75 });
    await api(`/college/registrations/${reg['2:PHY']}/result`, { percent: 90 });

    const t = await api(`/college/transcript/${student.id}?programId=${programId}`);
    const term2 = t.terms.find(x => x.termId === sem2);
    assert.equal(term2.gpa, 4.67, '(4.0 × 2 + 5.0 × 4) ÷ 6');
    assert.equal(t.creditsEarned, 10, 'the two English credits are earned once, not twice');
    // best attempt per course: 5.0×4 + 4.0×2 + 5.0×4 over 10 credits = 4.80.
    // counting the failed attempt too would give 4.00 and quietly punish her twice for one paper.
    assert.equal(t.cgpa, 4.8);
    assert.equal(t.terms.length, 2);
  });

  // ---------------- the certificate ----------------
  test('a certificate waits for the credits to be earned, and is only ever issued once', async () => {
    await assert.rejects(() => api('/college/certificates/program', { studentId: student.id, programId }), /10 of 12 credits are earned; 2 still to go/);

    // the failed paper cost her a semester: a two-term programme now needs a third
    await register(student.id, sem3, ['ICT']);
    const ict = (await rows(sem3))[0];
    await api(`/college/registrations/${String(ict.id)}/result`, { percent: 80 });
    assert.equal((await api(`/college/transcript/${student.id}?programId=${programId}`)).creditsEarned, 12);

    const cert = await api('/college/certificates/program', { studentId: student.id, programId });
    assert.ok(cert.verificationCode, 'a certificate nobody can check is a photocopy');
    assert.equal(cert.creditsEarned, 12);
    assert.equal(cert.cgpa, 4.83);
    const verified = await app.documents.verify(cert.verificationCode);
    assert.equal(verified.valid, true);
    assert.match(verified.data.course, /HSC Science/);
    assert.equal(verified.data.credits, '12');

    const again = await api('/college/certificates/program', { studentId: student.id, programId });
    assert.equal(again.alreadyIssued, true);
    assert.equal(again.certificateId, cert.certificateId);
    assert.equal((await app.db.findMany('issued_documents', { school_id: schoolId, student_id: student.id, doc_type: 'certificate' })).length, 1);
  });

  // ---------------- coaching: selling a batch ----------------
  test('a batch is sold on instalments and enrols nobody who has paid nothing', async () => {
    const made = await app.lms.createCourse(schoolId, { title: 'Spoken English — Batch A', isPaid: true, price: 6000 });
    courseId = made.id;
    await app.lms.publishCourse(schoolId, courseId);
    // a course nobody pays for is enrolled into, not sold
    const free = await app.lms.createCourse(schoolId, { title: 'Library orientation', isPaid: false });
    await app.lms.publishCourse(schoolId, free.id);
    await assert.rejects(() => api('/college/sales', { courseId: free.id, studentId: coachStudent.id, count: 3 }), /this course is free/);

    const sale = await api('/college/sales', { courseId, studentId: coachStudent.id, count: 3, firstDue: day(0) });
    planId = sale.planId;
    assert.equal(sale.total, 6000);
    assert.equal(sale.instalments.length, 3);
    assert.equal(sale.enrolled, false);
    assert.equal(await app.db.count('course_enrollments', { course_id: courseId }), 0, 'a plan is a promise to pay, not payment');
    // the batch earns into a head of its own, so a centre with six batches can tell them apart
    assert.match(String((await app.db.findOne('fee_heads', { id: sale.feeHeadId })).code), /^CRS-/);

    // and a second sale to the same student is refused: "it did not go through" is how people get billed twice
    await assert.rejects(() => api('/college/sales', { courseId, studentId: coachStudent.id, count: 3 }), /already has a payment plan/);
  });

  test('the first instalment that is actually paid confirms the seat', async () => {
    const billed = await app.fees.billDueInstalments(schoolId, day(0));
    assert.ok(billed.billed >= 1, 'the instalment due today has been invoiced');
    const first = (await app.db.query(`SELECT * FROM invoices WHERE school_id = ? AND student_id = ? AND notes = ? ORDER BY due_date, id`, [schoolId, coachStudent.id, `instalment:${planId}`]))[0];
    assert.ok(first);

    await api('/fees/payments', { studentId: coachStudent.id, amount: Number(first.total), method: 'cash', invoiceIds: [String(first.id)] });
    for (let i = 0; i < 20 && !(await app.db.count('course_enrollments', { course_id: courseId })); i++) await app.tick({ budgetMs: 500 });
    assert.equal(await app.db.count('course_enrollments', { course_id: courseId, student_id: coachStudent.id }), 1);

    const sales = await api(`/college/sales?courseId=${courseId}`);
    assert.equal(sales.length, 1);
    assert.equal(Number(sales[0].enrolled), 1);
    // paying again is the second instalment, not a second seat
    const owed = await api(`/college/sales/outstanding?courseId=${courseId}&studentId=${coachStudent.id}`);
    assert.equal(owed.outstanding, 4000, 'two instalments are still to come — billed or not, they are owed');
    assert.equal(owed.unbilled, 4000);
  });

  test('the course certificate waits for the last instalment', async () => {
    await assert.rejects(() => api('/college/certificates/course', { courseId, studentId: coachStudent.id }), /Tk 4000 of the course fee is still to come/);

    await app.fees.billDueInstalments(schoolId, day(90));
    const unpaid = await app.db.query(`SELECT * FROM invoices WHERE school_id = ? AND student_id = ? AND notes = ? AND balance > 0 ORDER BY due_date, id`, [schoolId, coachStudent.id, `instalment:${planId}`]);
    for (const inv of unpaid) await api('/fees/payments', { studentId: coachStudent.id, amount: Number(inv.balance), method: 'cash', invoiceIds: [String(inv.id)] });
    assert.equal((await api(`/college/sales/outstanding?courseId=${courseId}&studentId=${coachStudent.id}`)).outstanding, 0);

    const cert = await api('/college/certificates/course', { courseId, studentId: coachStudent.id, onDate: day(0) });
    assert.ok(cert.verificationCode);
    assert.equal((await app.documents.verify(cert.verificationCode)).valid, true);
    const again = await api('/college/certificates/course', { courseId, studentId: coachStudent.id });
    assert.equal(again.alreadyIssued, true);
  });

  // ---------------- department portals ----------------
  test('a department shows its people, its subjects and the load riding on them', async () => {
    hodId = (await app.people.createStaff(schoolId, { firstName: 'Farhana', lastName: 'Akter', phone: '01933333333', departmentId: deptId, staffCategory: 'teaching', joinDate: day(-400) })).id;
    outsiderId = (await app.people.createStaff(schoolId, { firstName: 'Kamal', lastName: 'Uddin', phone: '01944444444', staffCategory: 'admin', joinDate: day(-300) })).id;
    // subjects are the department's own; the credit load then follows them without anybody typing it in
    for (const code of ['PHY', 'CHE', 'BIO']) {
      const s = await app.db.findOne('subjects', { school_id: schoolId, code });
      await app.db.update('subjects', { department_id: deptId }, { id: String(s.id) });
    }

    await assert.rejects(() => api(`/college/departments/${deptId}/head`, { staffId: outsiderId }), /head of a department has to belong to it/);
    await api(`/college/departments/${deptId}/head`, { staffId: hodId });

    const list = await api('/college/departments');
    const science = list.find(d => String(d.id) === deptId);
    assert.equal(science.head_first_name, 'Farhana');
    assert.equal(Number(science.staff), 1);
    assert.equal(Number(science.subjects), 3);
    assert.equal(Number(science.programs), 1, 'the programme belongs to the department that teaches it');

    const detail = await api(`/college/departments/${deptId}`);
    assert.equal(detail.head.employee_no, (await app.db.findOne('staff', { id: hodId })).employee_no);
    assert.equal(detail.programs.length, 1);
    const physics = detail.load.find(l => l.subject_name === 'Physics');
    assert.equal(Number(physics.registrations), 1, 'Physics carries one registration this year');
    assert.equal(Number(physics.credits), 4);
  });

  // ---------------- the nightly watch ----------------
  test('the registration watch chases a light semester exactly once, a week in', async () => {
    const run = onDate => app.college.jobs()['college.registration_watch']({ schoolId, jobKey: 'college.registration_watch', payload: { onDate }, deadline: Date.now() + 20_000 });
    // semester 3 started a week ago and Nabila is carrying 2 of 6 credits
    const today = await run(day(0));
    assert.equal(today.terms, 1);
    assert.ok(today.chased >= 1, 'a student under half a load is chased');
    // any other day of the year is silent, which is what stops a nightly job sending the same message twenty times
    assert.equal((await run(day(1))).terms, 0);
    assert.equal((await run(day(-1))).chased, 0);
  });
});
