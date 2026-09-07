// Year-1 gaps, batch 2: the government's share of a salary, and what a school owes someone who leaves.
// The MPO return the office has to file bank by bank, one transfer file per bank, what happens when the
// government releases less than was claimed, and gratuity on the way out.
//   node --test tests/gaps2.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-g2');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'g2-key-'.padEnd(64, 'x'), CRON_KEY: 'cron-g2', UPLOADS_DIR: 'tests/.tmp-g2/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-g2/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

const MONTH = '2026-05-01';
let app, schoolId, http, baseUrl, cookie, runId;
const staff = {};
const t0 = Date.now();
const money = n => Math.round(Number(n) * 100) / 100;

describe('year-1 gaps: MPO and gratuity', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'MPO High School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01755555555', adminEmail: 'admin@g2.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);

    // two teachers on the government's list and one the school pays entirely itself
    staff.listed = await app.people.createStaff(schoolId, { firstName: 'Rokeya', lastName: 'Begum', phone: '01911220001', staffCategory: 'teaching', employmentType: 'mpo', joinDate: '2018-01-01' });
    staff.noIndex = await app.people.createStaff(schoolId, { firstName: 'Hasan', lastName: 'Ali', phone: '01911220002', staffCategory: 'teaching', employmentType: 'mpo', joinDate: '2019-01-01' });
    staff.school = await app.people.createStaff(schoolId, { firstName: 'Farida', lastName: 'Khatun', phone: '01911220003', staffCategory: 'teaching', joinDate: '2018-01-01' });
    await app.db.update('staff', { mpo_index_no: 'MPO-778899' }, { id: staff.listed.id });
    await app.hr.setStructure(schoolId, { staffId: staff.listed.id, effectiveFrom: '2024-01-01', basic: 20_000, mpoPortion: 12_000, bankAccount: { bankName: 'Janata', accountNo: '0011223344', branch: 'Mirpur' } });
    await app.hr.setStructure(schoolId, { staffId: staff.noIndex.id, effectiveFrom: '2024-01-01', basic: 18_000, mpoPortion: 10_000, bankAccount: { bankName: 'Sonali', accountNo: '0055667788', branch: 'Motijheel' } });
    await app.hr.setStructure(schoolId, { staffId: staff.school.id, effectiveFrom: '2024-01-01', basic: 15_000, mpoPortion: 0, bankAccount: { bankName: 'Janata', accountNo: '0099887766', branch: 'Mirpur' } });

    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@g2.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`gaps 2 finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET') => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 160)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const drain = async () => { for (let i = 0; i < 40; i++) await app.adapters.queue.drain(10); };
  const csv = async fileId => { const { stream } = await app.files.stream(fileId, schoolId); const parts = []; for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return Buffer.concat(parts).toString('utf8'); };

  test('the payroll splits each salary into the government share and the school share', async () => {
    const draft = await api('/hr/payroll', { periodMonth: MONTH });
    runId = draft.id;
    await drain();
    let { run } = await api(`/hr/payroll/${runId}`);
    if (run.status === 'calculated') { await api(`/hr/payroll/${runId}/approve`, {}); await drain(); run = (await api(`/hr/payroll/${runId}`)).run; }
    assert.equal(run.status, 'approved');
    assert.equal(Number(run.staff_count), 3);
    assert.equal(money(run.total_mpo), 22_000, 'twelve thousand plus ten, and nothing for the third');
    // the grant is income the moment the salary is recognised, and the school owes only the rest
    const lines = await app.db.query(`SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.entry_id = ?`, [String(run.journal_entry_id)]);
    assert.equal(money(lines.find(l => l.code === '4200').credit), 22_000);
    const payable = lines.find(l => l.code === '2200');
    assert.equal(money(payable.credit), money(Number(run.total_net) - 22_000));
  });

  test('the MPO return is grouped bank by bank, and says who cannot be claimed for', async () => {
    const sheet = await api(`/hr/payroll/${runId}/mpo`);
    assert.equal(sheet.staff, 2, 'only the two on the government list');
    assert.equal(money(sheet.total), 22_000);
    assert.equal(sheet.banks, 2);
    assert.equal(sheet.missing.length, 1);
    assert.match(sheet.missing[0].why, /MPO index number/);
    assert.equal(sheet.missing[0].name, 'Hasan Ali');
    const text = await csv(sheet.fileId);
    assert.match(text, /Bank: Janata/);
    assert.match(text, /Bank: Sonali/);
    assert.match(text, /MPO-778899/);
    assert.ok(!text.includes('Farida'), 'the teacher the school pays itself is not on the government return');
    assert.match(text, /Total claimed.*22000\.00/);
  });

  test('each bank gets its own transfer file, for the school share only', async () => {
    const files = await api(`/hr/payroll/${runId}/bank-files`);
    assert.equal(files.length, 2, 'a bank will not take another bank’s rows');
    const janata = files.find(f => f.bank === 'Janata');
    const sonali = files.find(f => f.bank === 'Sonali');
    assert.equal(janata.rows, 2);
    assert.equal(sonali.rows, 1);
    const detail = await api(`/hr/payroll/${runId}`);
    const net = id => Number(detail.payslips.find(p => String(p.staff_id) === id).net_pay);
    assert.equal(money(sonali.total), money(net(staff.noIndex.id) - 10_000), 'the bank pays only what the school owes');
    assert.equal(money(janata.total), money(net(staff.listed.id) - 12_000 + net(staff.school.id)));
    assert.match(await csv(sonali.fileId), /0055667788/);
  });

  test('a short release is the school’s debt, not a rounding note', async () => {
    const r = await api(`/hr/payroll/${runId}/mpo-reconcile`, { released: 20_000, releasedOn: '2026-06-10', note: 'two teachers paid at the old scale' });
    assert.equal(money(r.claimed), 22_000);
    assert.equal(money(r.gap), 2_000);
    assert.ok(r.journalEntryId);
    const lines = await app.db.query(`SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.entry_id = ?`, [r.journalEntryId]);
    assert.equal(money(lines.find(l => l.code === '4200').debit), 2_000, 'the grant income comes back down');
    assert.equal(money(lines.find(l => l.code === '2200').credit), 2_000, 'and the school now owes it');
    const tb = await api('/accounting/trial-balance?from=2026-01-01&to=2026-12-31');
    assert.equal(tb.balanced, true, `${tb.totalDebit} vs ${tb.totalCredit}`);
    // somebody has to chase it, so there is a task with the month on it
    const tasks = await app.db.query(`SELECT * FROM tasks WHERE school_id = ? AND title LIKE 'MPO short%'`, [schoolId]);
    assert.equal(tasks.length, 1);
    // and the month cannot be reconciled twice
    await assert.rejects(() => api(`/hr/payroll/${runId}/mpo-reconcile`, { released: 22_000 }), /already been reconciled/);
  });

  test('gratuity: a month of basic for every completed year, and nothing to anyone dismissed', async () => {
    await app.settings.set(schoolId, 'hr.gratuity', { enabled: true, minYears: 5, monthsPerYear: 1, forfeitOn: ['termination'] });
    const exit = await api('/hr/exits', { staffId: staff.listed.id, exitType: 'resignation', lastWorkingDay: '2026-06-30', noticeDate: '2026-06-01' });
    const settlement = await api(`/hr/exits/${exit.id}/settle`, { encashDays: 0 });
    assert.equal(settlement.gratuityYears, 8, 'joined at the start of 2018, left in the middle of 2026');
    assert.equal(money(settlement.gratuity), 8 * 20_000);
    assert.equal(money(settlement.net), money(8 * 20_000 + settlement.pfPayable));
    const tb = await api('/accounting/trial-balance?from=2026-01-01&to=2026-12-31');
    assert.equal(tb.balanced, true, `${tb.totalDebit} vs ${tb.totalCredit}`);

    // dismissal forfeits it; the years of service are still recorded, so the decision is visible
    const sacked = await api('/hr/exits', { staffId: staff.noIndex.id, exitType: 'termination', lastWorkingDay: '2026-06-30', noticeDate: '2026-06-01' });
    const nothing = await api(`/hr/exits/${sacked.id}/settle`, { encashDays: 0 });
    assert.equal(money(nothing.gratuity), 0);
    assert.equal(nothing.gratuityYears, 7);
    // someone short of the qualifying period gets none either
    const short = await app.hr.gratuityFor(schoolId, staff.school.id, '2022-01-01', 'resignation', 15_000);
    assert.equal(short.amount, 0);
    assert.match(short.reason, /4 years of service, 5 needed/);
    // a school that does not pay gratuity at all is respected
    await app.settings.set(schoolId, 'hr.gratuity', { enabled: false });
    const off = await app.hr.gratuityFor(schoolId, staff.school.id, '2026-06-30', 'resignation', 15_000);
    assert.equal(off.amount, 0);
    assert.match(off.reason, /does not pay gratuity/);
  });
});
