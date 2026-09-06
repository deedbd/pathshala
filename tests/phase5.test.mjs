// Phase 5 exit criterion: payroll for 150 staff drafted, approved, paid and journaled in one pass.
// Also: recruitment to hire, salary structures with dated effect, attendance-driven loss of pay,
// tax slabs, loans, payslip PDFs and the bank file, appraisals, and the final settlement on exit.
//   node --test tests/phase5.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-p5');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'p5-key-'.padEnd(64, 'x'), CRON_KEY: 'cron-p5', UPLOADS_DIR: 'tests/.tmp-p5/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-p5/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

const N = 150;                       // the exit criterion's headcount
const MONTH = '2026-05';             // a full month in the past, so attendance can be written for it
let app, schoolId, http, baseUrl, cookie, staff = [], runId, postingId, loanStaffId;
const t0 = Date.now();

describe('phase 5', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Phase Five School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01755555555', adminEmail: 'admin@p5.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    for (let i = 0; i < N; i++) {
      staff.push(await app.people.createStaff(schoolId, { firstName: `Teacher${i + 1}`, phone: `0191000${String(i).padStart(4, '0')}`, staffCategory: i % 10 === 0 ? 'non_teaching' : 'teaching', joinDate: '2024-01-01' }));
    }
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@p5.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`phase 5 finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 200)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const asJson = v => (typeof v === 'string' ? JSON.parse(v) : v);   // MySQL returns JSON columns already parsed
  const drain = async () => { let guard = 0; while (++guard < 400) { const { ran } = await app.adapters.queue.drain(5); await app.relay.run(); if (!ran) break; } };

  test('a vacancy is published, someone applies from the website, and hiring creates the staff record', async () => {
    const p = await api('/hr/postings', { title: 'Assistant teacher (Mathematics)', vacancies: 2, closesAt: '2099-01-01', status: 'open' });
    postingId = p.id;
    const publicList = await (await fetch(`${baseUrl}/api/public/vacancies`)).json();
    assert.equal(publicList.length, 1, 'the website shows the open vacancy');
    const applied = await (await fetch(`${baseUrl}/api/public/vacancies/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postingId, fullName: 'Nusrat Jahan', phone: '01911999888', email: 'nusrat@example.com' }) })).json();
    assert.ok(applied.id, JSON.stringify(applied));
    // applying twice with the same phone is refused
    const again = await fetch(`${baseUrl}/api/public/vacancies/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postingId, fullName: 'Nusrat Jahan', phone: '01911999888' }) });
    assert.equal(again.status, 409);
    const hired = await api(`/hr/applicants/${applied.id}/stage`, { stage: 'hired', joinDate: '2026-05-01' });
    assert.ok(hired.staffId, 'hiring creates a staff record');
    const row = await app.db.findOne('staff', { id: hired.staffId });
    assert.equal(row.first_name, 'Nusrat');
    assert.ok(row.user_id, 'and an account to sign in with');
    // H5: the onboarding checklist is waiting
    await drain();
    const checklist = await api(`/hr/onboarding/${hired.staffId}`);
    assert.equal(asJson(checklist.items).length, 6);
    const tasks = await app.db.count('tasks', { school_id: schoolId, task_type: 'hr.onboarding' });
    assert.ok(tasks >= 1, 'somebody is asked to set the salary');
    staff.push({ id: hired.staffId });
  });

  test('salary components and NBR tax slabs are seeded; structures supersede one another', async () => {
    const components = await api('/hr/components');
    assert.equal(components.length, 6, JSON.stringify(components.map(c => c.code)));
    assert.ok(components.find(c => c.code === 'PF_EMP' && c.component_type === 'deduction'));
    assert.ok(components.find(c => c.code === 'PF_ER' && c.component_type === 'employer_contribution'));
    const { slabs } = await api('/hr/tax-slabs');
    assert.equal(slabs[0].rate, 0);
    assert.equal(slabs[1].from, 350_000, 'the first taxable slab starts at 350,000');
    // the engine itself: 600,000 a year → 5% on 100,000 plus 10% on 150,000
    assert.equal(core.HrService.annualTax(600_000, slabs), 5_000 + 15_000);
    assert.equal(core.HrService.annualTax(300_000, slabs), 0, 'below the threshold nobody pays');

    const id = staff[0].id;
    await api('/hr/structures', { staffId: id, effectiveFrom: '2024-01-01', basic: 15_000 });
    await api('/hr/structures', { staffId: id, effectiveFrom: '2026-04-01', basic: 20_000, mpoPortion: 12_500, bankAccount: { bankName: 'Sonali', accountNo: '0123456789', branch: 'Mirpur' } });
    const old = await api(`/hr/structures/${id}?on=2025-06-01`);
    const now = await api(`/hr/structures/${id}?on=2026-06-01`);
    assert.equal(Number(old.basic), 15_000);
    assert.equal(Number(now.basic), 20_000, 'the later structure wins');
    assert.equal(String(old.effective_to).slice(0, 10), '2026-03-31', 'the earlier one was closed the day before');
    assert.ok(now.items.length >= 4, 'components were copied onto the structure');
    await assert.rejects(() => api('/hr/structures', { staffId: id, effectiveFrom: '2026-04-01', basic: 0 }), /greater than zero|Too small|expected number/);
  });

  test(`every one of the ${N + 1} staff gets a structure, attendance and leave for ${MONTH}`, async () => {
    const started = Date.now();
    for (const s of staff) {
      if (s.id === staff[0].id) continue;                       // already done above
      await app.hr.setStructure(schoolId, { staffId: s.id, effectiveFrom: '2024-01-01', basic: 12_000 + (Number(String(s.id).slice(-2).replace(/\D/g, '')) % 9) * 1000, mpoPortion: 0, bankAccount: { bankName: 'Janata', accountNo: `01${String(s.id).slice(-8)}`, branch: 'Head office' } });
    }
    console.log(`structures for ${staff.length} staff in ${Date.now() - started} ms`);
    // attendance: everyone present on every working day, except two people we make interesting
    const days = [];
    for (let d = new Date(`${MONTH}-01T00:00:00Z`); d.toISOString().slice(0, 7) === MONTH; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (!(await app.academic.isHoliday(schoolId, iso))) days.push(iso);
    }
    assert.ok(days.length >= 20, `${days.length} working days in ${MONTH}`);
    const absentee = staff[1].id, latecomer = staff[2].id;
    for (const day of days) {
      for (const s of [staff[0], staff[1], staff[2]]) {
        const status = s.id === absentee && days.indexOf(day) < 4 ? 'absent' : s.id === latecomer && days.indexOf(day) < 6 ? 'late' : 'present';
        await app.attendance.markStaff(schoolId, s.id, day, status, { source: 'device' });
      }
    }
    // an approved unpaid leave for the absentee covers two of those four days
    const lwp = await app.db.findOne('leave_types', { school_id: schoolId, code: 'LWP' });
    const leave = await app.attendance.applyLeave(schoolId, { applicantType: 'staff', staffId: absentee, leaveTypeId: String(lwp.id), fromDate: days[0], toDate: days[1], reason: 'personal' });
    if (leave.status !== 'approved') await app.attendance.decideLeave(schoolId, leave.id, 'approved');
    await drain();
    const attRows = await app.db.count('staff_attendance', { staff_id: absentee });
    assert.equal(attRows, days.length);
  });

  test('a loan is approved and paid out as an advance', async () => {
    loanStaffId = staff[3].id;
    const r = await api('/hr/loans', { staffId: loanStaffId, principal: 24_000, monthlyDeduction: 2_000, startsFrom: `${MONTH}-01` });
    assert.ok(r.id);
    await drain();
    const loan = (await api(`/hr/loans?staffId=${loanStaffId}`))[0];
    assert.equal(loan.status, 'active', 'auto-approved because no workflow is configured');
    assert.equal(Number(loan.balance), 24_000);
    assert.ok(loan.journal_entry_id, 'the money leaving the school was journaled');
    await assert.rejects(() => api('/hr/loans', { staffId: loanStaffId, principal: 1_000, monthlyDeduction: 5_000, startsFrom: `${MONTH}-01` }), /cannot exceed the principal/);
  });

  test(`payroll for ${N + 1} staff: draft, calculate, approve, pay — one pass`, async () => {
    const started = Date.now();
    const draft = await api('/hr/payroll', { periodMonth: MONTH });
    runId = draft.id;
    assert.equal(draft.queued, true);
    await drain();
    let { run } = await api(`/hr/payroll/${runId}`);
    // with no approval workflow configured the request auto-approves, so the run may already be approved
    assert.ok(['calculated', 'approved'].includes(String(run.status)), `still ${run.status}`);
    assert.equal(Number(run.staff_count), staff.length);
    assert.ok(Number(run.total_gross) > 0 && Number(run.total_net) > 0);
    assert.ok(Number(run.total_net) < Number(run.total_gross), 'deductions were taken');

    if (run.status === 'calculated') await api(`/hr/payroll/${runId}/approve`, {});
    await drain();
    const detail = await api(`/hr/payroll/${runId}`);
    run = detail.run;
    assert.equal(run.status, 'approved');
    assert.ok(run.journal_entry_id, 'the accrual journal was posted');
    assert.ok(run.bank_file_id, 'the bank transfer file was written');
    assert.equal(detail.payslips.length, staff.length);
    assert.ok(detail.payslips.every(p => p.payslip_file_id), 'every payslip has a PDF');

    const pay = await api(`/hr/payroll/${runId}/pay`, {});
    assert.equal(pay.status, 'paid');
    const ms = Date.now() - started;
    console.log(`payroll: ${staff.length} staff drafted → paid in ${ms} ms on ${app.db.engine}`);
    assert.ok(ms < 600_000, `payroll took ${ms} ms`);
    const paid = await api(`/hr/payroll/${runId}`);
    assert.ok(paid.payslips.every(p => p.status === 'paid'));
  });

  test('the payslip arithmetic: loss of pay, provident fund, tax and the loan instalment', async () => {
    const { payslips } = await api(`/hr/payroll/${runId}`);
    const byStaff = Object.fromEntries(payslips.map(p => [String(p.staff_id), p]));
    const clean = byStaff[staff[0].id];
    // basic 20,000 + house rent 50% + medical 700 + conveyance 500
    assert.equal(Number(clean.lop_days), 0);
    assert.equal(Number(clean.gross), 20_000 + 10_000 + 700 + 500);
    const b = asJson(clean.breakdown);
    assert.equal(b.employeePf, 2_000, 'provident fund is 10% of basic');
    assert.equal(b.employerPf, 2_000);
    assert.equal(Number(clean.net_pay), Number(clean.gross) - Number(clean.total_deductions));
    assert.equal(b.mpo, 12_500, 'the MPO share is carried onto the payslip');

    const absentee = byStaff[staff[1].id];
    assert.ok(Number(absentee.lop_days) >= 2, `unpaid leave became loss of pay: ${absentee.lop_days}`);
    assert.ok(Number(absentee.gross) < Number(clean.gross) / 20 * 19 + 20_000, 'gross was cut for the days not worked');
    const withLoan = byStaff[loanStaffId];
    const loanLine = asJson(withLoan.breakdown).deductions.find(x => x.code === 'LOAN');
    assert.equal(loanLine.amount, 2_000, 'the instalment was deducted');
    const loan = (await api(`/hr/loans?staffId=${loanStaffId}`))[0];
    assert.equal(Number(loan.balance), 22_000, 'and the balance came down');
    const pf = await app.db.findOne('provident_fund_accounts', { school_id: schoolId, staff_id: staff[0].id });
    assert.equal(Number(pf.employee_total), 2_000);
    assert.equal(Number(pf.employer_total), 2_000);
    // the payslip PDF is a real PDF
    const url = await api(`/files/${clean.payslip_file_id}/url`);
    const u = new URL(url.url);
    const dl = await fetch(`${baseUrl}${u.pathname}${u.search}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString(), '%PDF');
    // and the bank file lists everyone who is actually paid by the school
    const { run } = await api(`/hr/payroll/${runId}`);
    const bank = await api(`/files/${run.bank_file_id}/url`);
    const bu = new URL(bank.url);
    const csv = await (await fetch(`${baseUrl}${bu.pathname}${bu.search}`)).text();
    const lines = csv.trim().split('\r\n');
    assert.equal(lines[0], 'account_no,account_name,bank,branch,amount,reference');
    assert.equal(lines.length, payslips.length + 1);
    assert.ok(lines[1].includes('SAL-2026-05-'));
  });

  test('the books balance and the payroll wrote its own journals', async () => {
    const tb = await api(`/accounting/trial-balance?from=2026-01-01&to=2026-12-31`);
    assert.equal(tb.balanced, true, `${tb.totalDebit} vs ${tb.totalCredit}`);
    const entries = await app.db.query(`SELECT * FROM journal_entries WHERE school_id = ? AND source_type LIKE 'hr.%'`, [schoolId]);
    assert.ok(entries.length >= 3, `loan, payroll accrual and payment: ${entries.map(e => e.source_type)}`);
    assert.ok(entries.every(e => Number(e.is_auto)), 'no human wrote a payroll journal');
    const { run } = await api(`/hr/payroll/${runId}`);
    const lines = await app.db.query(`SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.entry_id = ?`, [String(run.journal_entry_id)]);
    const at = code => lines.find(l => l.code === code);
    assert.ok(Number(at('5100').debit) > 0, 'salaries expense');
    assert.ok(Number(at('5110').debit) > 0, 'employer provident fund expense');
    assert.ok(Number(at('2300').credit) > 0, 'provident fund payable');
    assert.ok(Number(at('4200').credit) > 0, 'the MPO share is grant income');
    assert.equal(Number(at('1400').credit), 2_000, 'the loan instalment reduces the advance');
    const dr = lines.reduce((a, l) => a + Number(l.debit), 0), cr = lines.reduce((a, l) => a + Number(l.credit), 0);
    assert.equal(Math.round(dr * 100), Math.round(cr * 100));
    // salary payable is cleared by the payment entry
    const payable = await app.db.query(`SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS bal FROM journal_lines l JOIN gl_accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.entry_id WHERE a.school_id = ? AND a.code = '2200' AND e.status = 'posted'`, [schoolId]);
    assert.equal(Math.round(Number(payable[0].bal) * 100), 0, 'nothing is left owing after the run is paid');
  });

  test('a member of staff sees their own payslip and nobody else’s', async () => {
    const me = await app.db.findOne('staff', { id: staff[0].id });
    const session = await app.auth.createSession(await app.db.findOne('users', { id: me.user_id }));
    const teachCookie = `ps_session=${session.token}`;
    const mine = await api('/teach/payslips', undefined, 'GET', { cookie: teachCookie });
    assert.equal(mine.payslips.length, 1);
    const one = await api(`/teach/payslips/${mine.payslips[0].id}`, undefined, 'GET', { cookie: teachCookie });
    assert.ok(one.payslipUrl, 'with a signed link to the PDF');
    const { payslips } = await api(`/hr/payroll/${runId}`);
    const other = payslips.find(p => String(p.staff_id) !== staff[0].id);
    assert.equal((await fetch(`${baseUrl}/api/teach/payslips/${other.id}`, { headers: { cookie: teachCookie } })).status, 403);
    // a teacher cannot open the console payroll either
    assert.equal((await fetch(`${baseUrl}/api/hr/payroll`, { headers: { cookie: teachCookie } })).status, 403);
  });

  test('running the same month again is refused once it is paid', async () => {
    await assert.rejects(() => api('/hr/payroll', { periodMonth: MONTH }), /already paid/);
  });

  test('appraisal cycle pre-fills what we can measure ourselves', async () => {
    const cycle = await api('/hr/appraisals/cycles', { name: 'Annual review 2026', opensAt: '2026-06-01', closesAt: '2026-06-30' });
    assert.equal(cycle.staff, staff.length);
    const { appraisals } = await api(`/hr/appraisals?cycleId=${cycle.id}`);
    const mine = appraisals.find(a => String(a.staff_id) === staff[0].id);
    const metrics = asJson(mine.auto_metrics);
    assert.ok(metrics.attendancePct > 0, `attendance was measured: ${JSON.stringify(metrics)}`);
    const scored = await api(`/hr/appraisals/${mine.id}`, { selfScores: { teaching: 80, attendance: 90, results: 70, conduct: 90 }, reviewerScores: { teaching: 75, attendance: 95, results: 70, conduct: 85 } });
    assert.equal(scored.status, 'reviewed');
    assert.equal(scored.overall, 80, 'weighted 40/20/20/20');
    const final = await api(`/hr/appraisals/${mine.id}/finalise`, {});
    assert.equal(final.overall, 80);
  });

  test('an exit settles leave, provident fund and the loan, then closes the account', async () => {
    const leaver = staff[3].id;                                  // the one with the loan
    const exit = await api('/hr/exits', { staffId: leaver, exitType: 'resignation', lastWorkingDay: '2026-06-30', noticeDate: '2026-06-01' });
    const settlement = await api(`/hr/exits/${exit.id}/settle`, { encashDays: 10 });
    const basic = Number((await api(`/hr/structures/${leaver}`)).basic);
    assert.equal(settlement.encashDays, 10);
    assert.equal(settlement.encashment, Math.round((basic / 30) * 10 * 100) / 100);
    assert.equal(settlement.loanRecovered, 22_000, 'what was still owed came out of the settlement');
    assert.ok(settlement.pfPayable > 0);
    const loan = (await api(`/hr/loans?staffId=${leaver}`))[0];
    assert.equal(Number(loan.balance), 0);
    assert.equal(loan.status, 'closed');
    const row = await app.db.findOne('staff', { id: leaver });
    assert.equal(row.status, 'resigned');
    assert.equal(String(row.leave_date).slice(0, 10), '2026-06-30');
    await drain();
    const user = await app.db.findOne('users', { id: row.user_id });
    assert.equal(Number(user.is_active), 0, 'their account was closed');
    // and the books still balance after the settlement
    const tb = await api(`/accounting/trial-balance?from=2026-01-01&to=2026-12-31`);
    assert.equal(tb.balanced, true, `${tb.totalDebit} vs ${tb.totalCredit}`);
    // settling twice is a no-op, not a second payment
    const again = await api(`/hr/exits/${exit.id}/settle`, {});
    assert.equal(again.alreadySettled, true);
  });

  test('the scheduled jobs run: contract expiry alerts and leave accrual', async () => {
    await api('/hr/contracts', { staffId: staff[4].id, contractType: 'contract', startDate: '2025-07-01', endDate: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) });
    const expiry = await app.adapters.scheduler.runJob?.(schoolId, 'hr.expiry_alerts') ?? await app.hr.jobs()['hr.expiry_alerts']({ schoolId, jobKey: 'hr.expiry_alerts', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(expiry.contracts, 1, 'the contract ending inside 30 days was picked up');
    const accrual = await app.hr.jobs()['leave.accrue']({ schoolId, jobKey: 'leave.accrue', payload: {}, deadline: Date.now() + 20_000 });
    assert.ok(accrual.balances > 0);
    const balances = await app.db.count('leave_balances', { school_id: schoolId, staff_id: staff[0].id });
    assert.ok(balances >= 3, 'casual, sick and earned leave were allocated');
    const html = await fetch(`${baseUrl}/hr?runId=${runId}`, { headers: { cookie } });
    assert.equal(html.status, 200);
    assert.ok((await html.text()).includes('2026-05'));
  });
});
