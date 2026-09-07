// Year-1 gaps, batch 1: the paperwork a school still does by hand.
// Staff and attendance arrive as spreadsheets, marks go out and come back as one, a payment prints a
// receipt, a big fee is split into instalments that invoice themselves, and a cheque is only money
// once the bank says so.
//   node --test tests/gaps1.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-g1');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'g1-key-'.padEnd(64, 'x'), CRON_KEY: 'cron-g1', UPLOADS_DIR: 'tests/.tmp-g1/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-g1/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, schoolId, yearId, http, baseUrl, cookie, classes, students = [];
const t0 = Date.now();
const money = n => Math.round(Number(n) * 100) / 100;
const book = aoa => { const ws = XLSX.utils.aoa_to_sheet(aoa); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1'); return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })); };

describe('year-1 gaps: imports, receipts, instalments, cheques', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Gap School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01744444444', adminEmail: 'admin@g1.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    yearId = String((await app.academic.currentYear(schoolId)).id);
    classes = await app.academic.classes(schoolId);
    const cls = String(classes[5].id);
    for (let i = 0; i < 4; i++) students.push(await app.people.createStudent(schoolId, { firstName: `Gap${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2014-02-02', classId: cls, admissionDate: '2020-01-05', guardians: [{ fullName: `Payer ${i + 1}`, phone: `019400000${String(i).padStart(2, '0')}`, relation: 'father', isPrimary: true, paysFees: true }] }));
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@g1.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`gaps 1 finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET') => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 160)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const upload = async (p, buffer) => api(p, { base64: buffer.toString('base64'), fileName: 'sheet.xlsx' });
  const drain = async (jobId) => { let s, guard = 0; do { await app.adapters.queue.drain(10); s = await api(`/import/jobs/${jobId}`); } while (s.status !== 'success' && ++guard < 60); return s; };

  test('the templates carry the columns each list needs', async () => {
    for (const [entity, needle] of [['student', 'admission_no'], ['staff', 'employee_no'], ['attendance', 'admission_no']]) {
      const r = await fetch(`${baseUrl}/api/import/template?entity=${entity}`, { headers: { cookie } });
      assert.equal(r.status, 200);
      const wb = XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
      assert.ok(aoa[0].includes(needle), `${entity} template should have ${needle}: ${aoa[0].join(',')}`);
      assert.equal(aoa.length, 2, 'headers and one example row');
    }
  });

  test('a staff spreadsheet becomes staff, with their subjects and salary structure', async () => {
    const designation = 'Assistant Teacher';
    await app.people.createDesignation(schoolId, designation, 'teaching');
    const subjects = await app.db.findMany('subjects', { school_id: schoolId }, { limit: 2 });
    const rows = [
      ['employee_no', 'first_name', 'last_name', 'gender', 'phone', 'designation', 'category', 'join_date', 'subjects', 'basic_salary'],
      ['', 'Nusrat', 'Jahan', 'female', '01911110001', designation, 'teaching', '2024-01-01', subjects.map(s => s.name).join('; '), '18000'],
      ['', 'Kamrul', 'Hasan', 'male', '01911110002', designation, 'teaching', '2024-02-01', String(subjects[0].name), '17000'],
      ['', 'Bad', 'Row', 'male', '017', designation, 'teaching', '2024-02-01', '', ''],           // not a phone number
      ['', 'No', 'Subject', 'male', '01911110004', designation, 'teaching', '2024-02-01', 'Astrophysics', ''],
    ];
    const started = await upload('/import/staff', book(rows));
    assert.equal(started.entity, 'staff');
    assert.equal(started.total, 4);
    assert.equal(started.valid, 2, JSON.stringify(started.errors));
    assert.equal(started.invalid, 2);
    assert.ok(started.errors.some(e => e.field === 'phone'), JSON.stringify(started.errors));
    assert.ok(started.errors.some(e => e.field === 'subjects' && e.message.includes('Astrophysics')));
    const done = await drain(started.id);
    assert.equal(done.status, 'success');
    assert.equal(Number(done.success_rows), 2);
    assert.ok(done.errors_file_id, 'the bad rows come back as a workbook to fix and re-import');
    const staff = await app.people.staff(schoolId, { q: 'Nusrat' });
    assert.equal(staff.length, 1);
    assert.equal(String(staff[0].phone), '+8801911110001', 'the number is stored the way the SMS gateway wants it');
    const subjectsOf = await app.db.findMany('staff_subjects', { staff_id: String(staff[0].id) });
    assert.equal(subjectsOf.length, 2, 'both subjects from the sheet');
    const structure = await app.db.findOne('salary_structures', { staff_id: String(staff[0].id) });
    assert.ok(structure, 'the basic salary in the sheet became a salary structure');
    assert.equal(money(structure.basic), 18000);
  });

  test('a register of attendance imports as marked days, and bad rows are named not guessed', async () => {
    const admissionNos = students.map(s => s.admissionNo ?? s.admission_no);
    const rows = [
      ['admission_no', 'date', 'status', 'check_in', 'remarks'],
      [admissionNos[0], '2026-02-03', 'present', '07:52', ''],
      [admissionNos[1], '2026-02-03', 'absent', '', 'fever'],
      [admissionNos[2], '2026-02-03', 'late', '08:40', ''],
      ['STU-999999', '2026-02-03', 'present', '', ''],                 // nobody by that number
      [admissionNos[3], '03-02-2026', 'present', '', ''],              // not a date we can trust
      [admissionNos[3], '2026-02-03', 'sleeping', '', ''],             // not a status
    ];
    const started = await upload('/import/attendance', book(rows));
    assert.equal(started.valid, 3, JSON.stringify(started.errors));
    assert.equal(started.invalid, 3);
    assert.ok(started.errors.some(e => e.message.includes('STU-999999')));
    assert.ok(started.errors.some(e => e.field === 'date'));
    assert.ok(started.errors.some(e => e.field === 'status' && e.message.includes('sleeping')));
    const done = await drain(started.id);
    assert.equal(Number(done.success_rows), 3);
    const marked = await app.db.findMany('student_attendance', { school_id: schoolId, on_date: '2026-02-03' });
    assert.equal(marked.length, 3);
    assert.equal(marked.filter(m => m.status === 'absent').length, 1);
    assert.equal(String(marked.find(m => m.status === 'present').source), 'import');
    // re-importing the same day corrects rather than duplicates
    const again = await drain((await upload('/import/attendance', book([rows[0], [admissionNos[1], '2026-02-03', 'present', '07:50', '']]))).id);
    assert.equal(Number(again.success_rows), 1);
    const after = await app.db.findMany('student_attendance', { school_id: schoolId, on_date: '2026-02-03' });
    assert.equal(after.length, 3, 'still three rows for the day');
    assert.equal(after.filter(m => m.status === 'absent').length, 0, 'the correction replaced the absence');
  });

  test('marks go out as a sheet and come back, with a bad sheet saving nothing', async () => {
    const exam = await api('/exams', { name: 'Half Yearly', startDate: '2026-03-01', endDate: '2026-03-10', classIds: [String(classes[5].id)] });
    const schedules = await api(`/exams/${exam.id}/schedules`);
    const scheduleId = String(schedules[0].id);
    const full = Number(schedules[0].full_marks);
    const r = await fetch(`${baseUrl}/api/exams/marks/sheet?scheduleId=${scheduleId}`, { headers: { cookie } });
    assert.equal(r.status, 200);
    const wb = XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
    assert.equal(aoa[1][0], 'student_id', 'the sheet carries ids so a sorted sheet still matches the right child');
    assert.equal(aoa.length, 2 + students.length);

    // a sheet with one impossible mark saves nothing at all
    const bad = aoa.map(row => [...row]);
    bad[2][3] = String(full + 5);
    const rejected = await api(`/exams/marks/${scheduleId}/import`, { base64: book(bad).toString('base64') });
    assert.equal(rejected.saved, 0);
    assert.ok(rejected.errors[0].message.includes(`more than the full marks`), JSON.stringify(rejected.errors));
    assert.equal((await api(`/exams/marks?scheduleId=${scheduleId}`)).students.filter(s => s.mark_id).length, 0);

    // the same sheet, filled in properly
    const good = aoa.map(row => [...row]);
    for (let i = 2; i < good.length; i++) good[i][3] = String(60 + i);
    good[3][6] = 'yes';                              // one child sat nothing
    const saved = await api(`/exams/marks/${scheduleId}/import`, { base64: book(good).toString('base64') });
    assert.equal(saved.errors.length, 0, JSON.stringify(saved.errors));
    assert.equal(saved.saved, students.length);
    const grid = await api(`/exams/marks?scheduleId=${scheduleId}`);
    assert.equal(grid.students.filter(s => s.mark_id).length, students.length);
    assert.equal(grid.students.filter(s => Number(s.is_absent)).length, 1);
    // a re-import updates the same rows instead of adding new ones
    const twice = await api(`/exams/marks/${scheduleId}/import`, { base64: book(good).toString('base64') });
    assert.equal(twice.saved, students.length);
    assert.equal((await app.db.findMany('marks', { schedule_id: scheduleId })).length, students.length);
  });

  test('a payment prints a receipt once, and the same receipt comes back after that', async () => {
    const head = (await api('/fees/overview')).heads[0];
    const invoice = await api('/fees/invoices', { studentId: students[0].id, items: [{ feeHeadId: String(head.id), description: 'Tuition', amount: 1200 }] });
    const payment = await api('/fees/payments', { studentId: students[0].id, amount: 800, method: 'cash', invoiceIds: [invoice.id] });
    const receipt = await api(`/fees/payments/${payment.id}/receipt`, {});
    assert.ok(receipt.fileId);
    assert.match(receipt.documentNo, /^RECEIP-/);
    const file = await app.db.findOne('files', { id: receipt.fileId });
    assert.equal(String(file.mime_type), 'application/pdf');
    assert.ok(Number(file.size_bytes) > 500, 'a real PDF, not an empty one');
    const issued = await app.db.findOne('issued_documents', { school_id: schoolId, doc_type: 'receipt' });
    const snapshot = typeof issued.data_snapshot === 'string' ? JSON.parse(issued.data_snapshot) : issued.data_snapshot;
    assert.equal(snapshot.amount, '800');
    assert.equal(snapshot.outstanding, '400', 'the receipt says what is still owed');
    const twice = await api(`/fees/payments/${payment.id}/receipt`, {});
    assert.equal(twice.alreadyIssued, true);
    assert.equal(twice.fileId, receipt.fileId, 'one payment, one receipt');
  });

  test('a big fee splits into instalments that invoice themselves on the day they fall due', async () => {
    const head = (await api('/fees/overview')).heads[0];
    const plan = await api('/fees/instalments', { studentId: students[1].id, feeHeadId: String(head.id), totalAmount: 9000, count: 3, firstDue: '2026-04-10' });
    assert.equal(plan.instalments.length, 3);
    assert.equal(money(plan.instalments.reduce((a, i) => a + i.amount, 0)), 9000);
    assert.deepEqual(plan.instalments.map(i => i.due), ['2026-04-10', '2026-05-10', '2026-06-10']);
    // nothing is billed before its date
    assert.equal((await api('/fees/instalments/run?date=2026-04-09', {})).billed, 0);
    assert.equal((await api(`/fees/invoices?studentId=${students[1].id}`)).length, 0);
    // the first two fall due; the third does not
    const may = await api('/fees/instalments/run?date=2026-05-11', {});
    assert.equal(may.billed, 2);
    assert.equal(may.completed, 0);
    const invoices = await api(`/fees/invoices?studentId=${students[1].id}`);
    assert.equal(invoices.length, 2);
    assert.equal(money(invoices.reduce((a, i) => a + Number(i.total), 0)), 6000);
    // running again on the same day bills nothing twice
    assert.equal((await api('/fees/instalments/run?date=2026-05-11', {})).billed, 0);
    const june = await api('/fees/instalments/run?date=2026-06-30', {});
    assert.equal(june.billed, 1);
    assert.equal(june.completed, 1);
    assert.equal(String((await api(`/fees/instalments?studentId=${students[1].id}`))[0].status), 'completed');
    // a plan whose parts do not add up to the total is refused outright
    const wrong = await fetch(`${baseUrl}/api/fees/instalments`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ studentId: students[1].id, feeHeadId: String(head.id), totalAmount: 5000, instalments: [{ due: '2026-04-10', amount: 2000 }, { due: '2026-05-10', amount: 2000 }] }) });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /add up to 4000/);
  });

  test('a cheque is not money until the bank says so', async () => {
    const head = (await api('/fees/overview')).heads[0];
    const invoice = await api('/fees/invoices', { studentId: students[2].id, items: [{ feeHeadId: String(head.id), description: 'Admission', amount: 5000 }] });
    const cheque = await api('/fees/payments', { studentId: students[2].id, amount: 5000, method: 'cheque', reference: 'CHQ-77123', invoiceIds: [invoice.id] });
    assert.equal(cheque.pending, true);
    assert.equal(cheque.journalEntryId, null, 'nothing is posted to the books yet');
    assert.equal(money((await api(`/fees/invoices/${invoice.id}`)).balance), 5000, 'the fee is still owed');
    assert.equal((await app.db.findMany('payment_allocations', { payment_id: cheque.id })).length, 0);
    assert.equal((await api('/fees/cheques')).length, 1);
    // a cheque with no number is refused: there is nothing to chase the bank with
    const noNumber = await fetch(`${baseUrl}/api/fees/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ studentId: students[2].id, amount: 100, method: 'cheque' }) });
    assert.equal(noNumber.status, 400);

    const cleared = await api(`/fees/cheques/${cheque.id}/clear`, { clearedAt: '2026-05-02 10:00:00' });
    assert.equal(cleared.id, cheque.id, 'the same receipt number, not a new one');
    assert.equal(cleared.paymentNo, cheque.paymentNo);
    assert.ok(cleared.journalEntryId);
    assert.equal(money((await api(`/fees/invoices/${invoice.id}`)).balance), 0);
    assert.equal(String((await app.db.findOne('payments', { id: cheque.id })).status), 'success');
    const entry = await app.db.findOne('journal_entries', { id: cleared.journalEntryId });
    assert.ok(entry, 'clearing posts the journal the receipt never did');
    assert.equal((await api('/fees/cheques')).length, 0);
    // and it cannot be cleared twice
    const twice = await fetch(`${baseUrl}/api/fees/cheques/${cheque.id}/clear`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}' });
    assert.equal(twice.status, 409);

    // one that bounces leaves the fee outstanding and tells the guardian
    const invoice2 = await api('/fees/invoices', { studentId: students[3].id, items: [{ feeHeadId: String(head.id), description: 'Admission', amount: 3000 }] });
    const bad = await api('/fees/payments', { studentId: students[3].id, amount: 3000, method: 'cheque', reference: 'CHQ-77124', invoiceIds: [invoice2.id] });
    const bounced = await api(`/fees/cheques/${bad.id}/bounce`, { reason: 'insufficient funds' });
    assert.equal(bounced.status, 'failed');
    assert.equal(money((await api(`/fees/invoices/${invoice2.id}`)).balance), 3000);
    await app.adapters.queue.drain(20);
    const told = await app.db.query(`SELECT * FROM notifications WHERE school_id = ? AND event_key = 'fees.cheque_bounced'`, [schoolId]);
    assert.ok(told.length >= 1, 'the guardian hears about it from the school, not from the bank');
    assert.equal((await api('/fees/cheques')).length, 0);
    // the books never saw the bounced cheque at all
    assert.equal((await app.db.findMany('journal_entries', { school_id: schoolId, source_id: bad.id })).length, 0);
  });
});
