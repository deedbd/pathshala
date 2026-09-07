// Phase 6: 500 applications taken from the public form through merit selection to enrolment, plus
// documents — eligibility, issue, QR verification, ID cards — with nothing touched by hand.
//   node --test tests/phase6.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-p6');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'p6-key-'.padEnd(64, 'x'), CRON_KEY: 'cron-p6', UPLOADS_DIR: 'tests/.tmp-p6/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-p6/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

const APPLICANTS = 500;
const SEATS = 200;
let app, schoolId, yearId, http, baseUrl, cookie, classId, campaignId, slug, testId, applications = [], enrolledStudentId;
const t0 = Date.now();

describe('phase 6', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Phase Six School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01766666666', adminEmail: 'admin@p6.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    await app.settings.set(schoolId, 'notifications.channels', { push: true, sms: true, email: true, in_app: true });   // an admissions desk runs on SMS
    yearId = String((await app.academic.currentYear(schoolId)).id);
    classId = String((await app.academic.classes(schoolId))[3].id);
    // the class charges an admission fee, so an offer carries a real invoice to pay
    const admissionHead = await app.db.findOne('fee_heads', { school_id: schoolId, code: 'ADMISSION' });
    await app.fees.createStructure(schoolId, { academicYearId: yearId, classId, name: 'Admission fee', items: [{ feeHeadId: String(admissionHead.id), amount: 5000, frequency: 'one_time', dueDay: 10 }] });
    // a counsellor for the enquiry rota
    await app.people.createStaff(schoolId, { firstName: 'Counsellor', phone: '01922000000', staffCategory: 'admin', joinDate: '2024-01-01' });
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@p6.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`phase 6 finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 200)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const pub = async (p, body) => { const r = await fetch(`${baseUrl}/api/public${p}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const asJson = v => (typeof v === 'string' ? JSON.parse(v) : v);
  // keep going while either engine still has work: 500 payments raise thousands of events
  const drain = async () => { let guard = 0; while (++guard < 500) { const { ran } = await app.adapters.queue.drain(10); const { published } = await app.relay.run(); if (!ran && !published) break; } };

  test('a campaign opens and its form goes live on the website', async () => {
    const r = await api('/admissions/campaigns', { name: 'Admission 2027', opensAt: '2026-01-01 00:00:00', closesAt: '2099-12-31 23:59:59', formFee: 200, selectionMode: 'test', offerValidityDays: 7, classes: [{ classId, seats: SEATS, minAgeYears: 3, maxAgeYears: 20 }] });
    campaignId = r.id; slug = r.slug;
    assert.equal(slug, 'admission-2027');
    // a draft campaign is not public yet
    await assert.rejects(() => pub(`/admission/${slug}`), /no admission is open/);
    await api(`/admissions/campaigns/${campaignId}`, { status: 'open' }, 'PATCH');
    const form = await pub(`/admission/${slug}`);
    assert.equal(form.campaign.formFee, 200);
    assert.equal(form.classes.length, 1);
    assert.equal(Number(form.classes[0].seats), SEATS);
  });

  test('an enquiry from the website gets a counsellor, an acknowledgement and a follow-up task', async () => {
    const r = await pub('/site/enquiry', { studentName: 'Ayesha Rahman', guardianName: 'Rahim Rahman', phone: '01933000001', classId, notes: 'Wants class 4' });
    assert.ok(r.id);
    await drain();
    const enquiry = (await api('/admissions/enquiries'))[0];
    assert.ok(enquiry.assigned_to, 'a counsellor was assigned');
    const tasks = await app.db.count('tasks', { school_id: schoolId, task_type: 'admissions.followup' });
    assert.equal(tasks, 1);
    const sms = await app.db.count('notifications', { school_id: schoolId, event_key: 'admissions.enquiry_ack' });
    assert.equal(sms, 1);
    await api(`/admissions/enquiries/${enquiry.id}/followups`, { note: 'Called; will visit on Friday.', channel: 'call', status: 'contacted', nextAt: '2026-02-01 10:00:00' });
    assert.equal((await api(`/admissions/enquiries/${enquiry.id}/followups`)).length, 1);
  });

  test('the public form refuses a child who is too young and a second application from one phone', async () => {
    const base = { classId, firstName: 'Too', lastName: 'Young', gender: 'male', dateOfBirth: '2025-01-01', guardianName: 'Someone', guardianPhone: '01933000002' };
    await assert.rejects(() => pub(`/admission/${slug}/apply`, base), /at least 3 years old/);
    const ok = await pub(`/admission/${slug}/apply`, { ...base, firstName: 'Right', dateOfBirth: '2018-03-03' });
    assert.equal(ok.status, 'draft', 'it waits for the form fee');
    assert.ok(ok.invoiceId, 'and a form-fee invoice is raised');
    await assert.rejects(() => pub(`/admission/${slug}/apply`, { ...base, firstName: 'Right', dateOfBirth: '2018-03-03' }), /already applied/);
    // the tracker tells the guardian where things stand
    const track = await pub(`/admission/${slug}/track`, { applicationNo: ok.applicationNo, phone: '01933000002' });
    assert.equal(track.status, 'draft');
    assert.equal(track.meritRank, null);
  });

  test(`${APPLICANTS} applications arrive and paying the form fee submits each one`, async () => {
    const started = Date.now();
    for (let i = 0; i < APPLICANTS; i++) {
      const r = await app.admissions.apply(schoolId, campaignId, {
        classId, firstName: `Applicant${i + 1}`, lastName: 'Khan', gender: i % 2 ? 'female' : 'male', dateOfBirth: `201${8 - (i % 3)}-0${(i % 9) + 1}-1${i % 9}`,
        guardianName: `Guardian ${i + 1}`, guardianPhone: `0194${String(1000000 + i).slice(-7)}`,
      });
      applications.push(r);
    }
    console.log(`${APPLICANTS} applications in ${Date.now() - started} ms`);
    assert.equal(applications.length, APPLICANTS);
    assert.ok(applications.every(a => a.status === 'draft' && a.invoiceId));
    // pay the form fee for all of them; A4 submits the application and issues an admit card
    const paying = Date.now();
    for (const a of applications) await app.fees.recordPayment(schoolId, { amount: 200, method: 'cash', invoiceIds: [a.invoiceId] });
    await drain();
    console.log(`${APPLICANTS} form fees paid and applications submitted in ${Date.now() - paying} ms`);
    const submitted = await app.db.query(`SELECT status, COUNT(*) AS n FROM admission_applications WHERE school_id = ? GROUP BY status`, [schoolId]);
    const byStatus = Object.fromEntries(submitted.map(r => [r.status, Number(r.n)]));
    assert.equal((byStatus.submitted ?? 0) + (byStatus.test_scheduled ?? 0), APPLICANTS, JSON.stringify(byStatus));
  });

  test('an admission test is held and the marks come in', async () => {
    const t = await api('/admissions/tests', { campaignId, classId, name: 'Entrance test', heldAt: '2026-03-01 10:00:00', venue: 'Main hall', totalMarks: 100 });
    testId = t.id;
    const apps = await api(`/admissions/applications?campaignId=${campaignId}&classId=${classId}`);
    assert.equal(apps.length, APPLICANTS + 1, 'the walk-in applicant is in there too');
    await assert.rejects(() => api(`/admissions/tests/${testId}/results`, { results: [{ applicationId: apps[0].id, totalMarks: 150 }] }), /more than the test's/);
    const scored = apps.filter(a => String(a.first_name).startsWith('Applicant'));
    const started = Date.now();
    for (let i = 0; i < scored.length; i += 200) {
      await api(`/admissions/tests/${testId}/results`, { results: scored.slice(i, i + 200).map((a, j) => ({ applicationId: String(a.id), totalMarks: 30 + ((i + j) % 70) })) });
    }
    console.log(`${scored.length} test results in ${Date.now() - started} ms`);
    await drain();
    const tested = await app.db.count('admission_applications', { school_id: schoolId, status: 'tested' });
    assert.ok(tested === 0 || tested < scored.length, 'the merit list has already moved them on');
  });

  test(`the merit list fills ${SEATS} seats and waitlists the rest, in merit order`, async () => {
    // the last batch of marks triggered it automatically; a partial cohort is never ranked
    const list = await api(`/admissions/campaigns/${campaignId}/merit?classId=${classId}`);
    assert.equal(list.length, APPLICANTS, `${list.length} applicants ranked`);
    const shortlisted = list.filter(x => ['shortlisted', 'offered', 'enrolled'].includes(String(x.status)));
    const waitlisted = list.filter(x => String(x.status) === 'waitlisted');
    assert.equal(shortlisted.length, SEATS);
    assert.equal(waitlisted.length, APPLICANTS - SEATS);
    const byRank = [...list].sort((a, b) => Number(a.merit_rank) - Number(b.merit_rank));
    assert.equal(Number(byRank[0].merit_rank), 1);
    for (let i = 1; i < byRank.length; i++) {
      const prev = byRank[i - 1], cur = byRank[i];
      assert.ok(Number(prev.test_score) >= Number(cur.test_score), `rank ${cur.merit_rank} scores more than the one above it`);
      // equal scores are separated by age, never at random
      if (Number(prev.test_score) === Number(cur.test_score)) assert.ok(String(prev.date_of_birth) <= String(cur.date_of_birth), 'the older child is ranked first');
    }
    assert.ok(byRank.slice(0, SEATS).every(x => String(x.status) !== 'waitlisted'), 'the seats went to the top of the list');
    assert.ok(byRank.slice(SEATS).every(x => String(x.status) === 'waitlisted'));
  });

  test('every shortlisted applicant has an offer, an invoice and an offer letter', async () => {
    await drain();
    const offers = await api(`/admissions/campaigns/${campaignId}/offers`);
    assert.equal(offers.length, SEATS, 'auto_offer made one offer per seat');
    assert.ok(offers.every(o => o.offer_letter_file_id), 'each with a letter');
    const url = await api(`/files/${offers[0].offer_letter_file_id}/url`);
    const u = new URL(url.url);
    const buf = Buffer.from(await (await fetch(`${baseUrl}${u.pathname}${u.search}`)).arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString(), '%PDF');
    // one message per offer per channel (SMS and email), so count the offers that were told, not the rows
    const told = await app.db.query(`SELECT COUNT(DISTINCT entity_id) AS n FROM notifications WHERE school_id = ? AND event_key = 'admissions.offer_made'`, [schoolId]);
    assert.equal(Number(told[0].n), SEATS, 'every offer reached its guardian');
  });

  test('paying the admission fee enrols the child, with guardian, account and section', async () => {
    // give the class an admission fee so the offer carries a real invoice
    const offers = await api(`/admissions/campaigns/${campaignId}/offers`);
    const target = offers.find(o => o.admission_fee_invoice_id);
    assert.ok(target, 'the offer carries an admission-fee invoice');
    const invoice = await app.db.findOne('invoices', { id: String(target.admission_fee_invoice_id) });
    assert.equal(Number(invoice.total), 5000);
    assert.equal(invoice.student_id, null, 'billed to the applicant, who is not a student yet');
    await app.fees.recordPayment(schoolId, { amount: 5000, method: 'bkash', invoiceIds: [String(target.admission_fee_invoice_id)] });
    await drain();
    const enrolledApp = await app.db.findOne('admission_applications', { id: String(target.application_id) });
    const studentId = enrolledApp.student_id;
    assert.ok(studentId, 'paying the admission fee made the applicant a student');
    enrolledStudentId = String(studentId);
    const student = await app.db.findOne('students', { id: enrolledStudentId });
    assert.equal(student.current_class_id, classId);
    assert.ok(student.current_section_id, 'and was placed in a section');
    const guardians = await app.db.query(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ?`, [enrolledStudentId]);
    assert.equal(guardians.length, 1);
    assert.ok(guardians[0].user_id, 'the guardian can sign in');
    const application = await app.db.findOne('admission_applications', { id: String(target.application_id) });
    assert.equal(application.status, 'enrolled');
  });

  test('an expired offer is revoked and the waitlist moves up', async () => {
    const offers = await api(`/admissions/campaigns/${campaignId}/offers`);
    const open = offers.find(o => !o.accepted_at && !o.revoked_at && !o.declined_at);
    await app.db.execute(`UPDATE admission_offers SET expires_at = ? WHERE id = ?`, ['2020-01-01 00:00:00', String(open.id)]);
    const waitlistedBefore = await app.db.count('admission_applications', { school_id: schoolId, status: 'waitlisted' });
    const r = await app.admissions.jobs()['admissions.offer_expiry']({ schoolId, jobKey: 'admissions.offer_expiry', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(r.revoked, 1);
    assert.equal(r.promoted, 1, 'the next applicant on the list took the seat');
    const waitlistedAfter = await app.db.count('admission_applications', { school_id: schoolId, status: 'waitlisted' });
    assert.equal(waitlistedAfter, waitlistedBefore - 1);
    const rejected = await app.db.findOne('admission_applications', { id: String(open.application_id) });
    assert.equal(rejected.status, 'rejected');
    assert.match(String(rejected.rejection_reason), /expired/);
  });

  test('a transfer certificate is blocked by unpaid fees and issued once they are cleared', async () => {
    const inv = await app.fees.createInvoice(schoolId, { studentId: enrolledStudentId, academicYearId: yearId, items: [{ description: 'Tuition', amount: 1200 }] });
    const blocked = await api('/documents/requests', { docType: 'tc', personType: 'student', studentId: enrolledStudentId, reason: 'moving city' });
    assert.equal(blocked.status, 'blocked');
    assert.ok(blocked.blockers.some(b => b.kind === 'fees'), JSON.stringify(blocked.blockers));
    await assert.rejects(() => api(`/documents/requests/${blocked.id}/issue`, {}), /still blocked/);
    await app.fees.recordPayment(schoolId, { studentId: enrolledStudentId, amount: 1200, method: 'cash', invoiceIds: [inv.id] });
    const fresh = await api('/documents/requests', { docType: 'tc', personType: 'student', studentId: enrolledStudentId, reason: 'moving city' });
    assert.equal(fresh.status, 'approved', 'no workflow configured, so it approves itself');
    const issued = await api(`/documents/requests/${fresh.id}/issue`, {});
    assert.ok(issued.documentNo.startsWith('TC-'));
    assert.ok(issued.verificationCode.length >= 8);
    const url = await api(`/files/${issued.fileId}/url`);
    const u = new URL(url.url);
    const buf = Buffer.from(await (await fetch(`${baseUrl}${u.pathname}${u.search}`)).arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString(), '%PDF');
    // the public check confirms it, and the check itself is logged
    const verified = await pub(`/verify/${issued.verificationCode}`);
    assert.equal(verified.valid, true);
    assert.equal(verified.documentNo, issued.documentNo);
    assert.ok(verified.data.name.includes('Applicant') || verified.data.name.length > 0);
    assert.equal(await app.db.count('document_verifications', { school_id: schoolId }), 1);
    // revoking it flips the public answer
    const doc = (await api(`/documents/issued?studentId=${enrolledStudentId}`))[0];
    await api(`/documents/issued/${doc.id}/revoke`, { reason: 'issued in error' });
    const after = await pub(`/verify/${issued.verificationCode}`);
    assert.equal(after.valid, false);
    assert.equal(after.revoked, true);
    // an unknown code is simply not found
    assert.equal((await fetch(`${baseUrl}/api/public/verify/DEADBEEFDEADBEEF`)).status, 404);
  });

  test('ID cards are batched into one print job', async () => {
    const r = await api('/documents/id-cards', { personType: 'student', validFrom: '2027-01-01', validTo: '2027-12-31' });
    assert.ok(r.cards >= 1, `${r.cards} cards`);
    await drain();
    const job = (await api('/documents/print-jobs'))[0];
    assert.equal(job.status, 'ready');
    assert.ok(job.file_id, 'with a sheet to print');
    const cards = await app.db.query(`SELECT status, file_id FROM id_cards WHERE school_id = ?`, [schoolId]);
    assert.ok(cards.every(c => c.status === 'active' && c.file_id));
    // running it again issues nothing: the cards are still valid
    const twice = await api('/documents/id-cards', { personType: 'student', validFrom: '2027-01-01', validTo: '2027-12-31' });
    assert.equal(twice.cards, 0);
  });

  test('a guardian sees their own child’s documents and nobody else’s', async () => {
    const g = (await app.db.query(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ?`, [enrolledStudentId]))[0];
    const session = await app.auth.createSession(await app.db.findOne('users', { id: g.user_id }));
    const gc = `ps_session=${session.token}`;
    const mine = await api(`/portal/documents/${enrolledStudentId}`, undefined, 'GET', { cookie: gc });
    assert.equal(mine.documents.length, 1);
    const other = await app.db.query(`SELECT id FROM students WHERE school_id = ? AND id <> ? LIMIT 1`, [schoolId, enrolledStudentId]);
    if (other[0]) assert.equal((await fetch(`${baseUrl}/api/portal/documents/${other[0].id}`, { headers: { cookie: gc } })).status, 403);
    // and the console page renders
    const html = await fetch(`${baseUrl}/admissions?campaignId=${campaignId}`, { headers: { cookie } });
    assert.equal(html.status, 200);
    assert.ok((await html.text()).includes('Admission 2027'));
  });

  test('a lottery campaign draws a repeatable order without any test', async () => {
    const c = await api('/admissions/campaigns', { name: 'Lottery 2027', opensAt: '2026-01-01 00:00:00', closesAt: '2099-12-31 23:59:59', formFee: 0, selectionMode: 'lottery', requiresTest: false, autoOffer: false, classes: [{ classId, seats: 5 }] });
    await api(`/admissions/campaigns/${c.id}`, { status: 'open' }, 'PATCH');
    for (let i = 0; i < 20; i++) {
      await app.admissions.apply(schoolId, c.id, { classId, firstName: `Lot${i + 1}`, gender: 'male', dateOfBirth: '2018-01-01', guardianName: `G ${i}`, guardianPhone: `0195${String(2000000 + i).slice(-7)}` });
    }
    const r = await api(`/admissions/campaigns/${c.id}/merit`, { classId });
    assert.equal(r.shortlisted, 5);
    assert.equal(r.waitlisted, 15);
    const list = await api(`/admissions/campaigns/${c.id}/merit?classId=${classId}`);
    assert.ok(list.every(x => x.lottery_no), 'every applicant has a draw number to check');
    const first = list.map(x => `${x.id}:${x.lottery_no}`).sort().join('|');
    await api(`/admissions/campaigns/${c.id}/merit`, { classId });
    const second = (await api(`/admissions/campaigns/${c.id}/merit?classId=${classId}`)).map(x => `${x.id}:${x.lottery_no}`).sort().join('|');
    assert.equal(second, first, 'the same draw comes out every time');
  });
});
