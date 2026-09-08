// Phase 3 exit criterion: a month closes with a balanced trial balance and zero manual fee journals.
// Also: invoice batch with pro-rata, discounts, allocation oldest-first, reminders, fines, refunds,
// gateway IPN (signed and idempotent), counter cash sessions, guardian pay flow.
//   node --test tests/phase3.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-p3');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'p3-key-'.padEnd(64, 'x'), CRON_KEY: 'cron-p3', UPLOADS_DIR: 'tests/.tmp-p3/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-p3/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, schoolId, yearId, http, baseUrl, cookie, guardianCookie, students = [], classes, period, monthStart, monthEnd;
const t0 = Date.now();
const money = n => Math.round(Number(n) * 100) / 100;

describe('phase 3', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Phase Three School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01733333333', adminEmail: 'admin@p3.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    await app.settings.set(schoolId, 'notifications.channels', { push: true, sms: true, email: true, in_app: true });
    yearId = String((await app.academic.currentYear(schoolId)).id);
    classes = await app.academic.classes(schoolId);
    period = new Date().toISOString().slice(0, 7) + '-01';
    monthStart = period; monthEnd = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
    // ten students in one class, one of them admitted mid-month (pro-rata) and two siblings
    const cls = String(classes[5].id);
    for (let i = 0; i < 10; i++) students.push(await app.people.createStudent(schoolId, { firstName: `Pupil${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2014-02-02', classId: cls, admissionDate: i === 9 ? `${period.slice(0, 7)}-16` : '2020-01-05', guardians: [{ fullName: `Payer ${i + 1}`, phone: `018300000${String(i).padStart(2, '0')}`, relation: 'father', isPrimary: true, paysFees: true }] }));
    // a sibling sharing the first guardian's phone
    students.push(await app.people.createStudent(schoolId, { firstName: 'Sibling', gender: 'male', dateOfBirth: '2016-03-03', classId: String(classes[3].id), admissionDate: '2020-01-05', guardians: [{ fullName: 'Payer 1', phone: '01830000000', relation: 'father', isPrimary: true }] }));
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@p3.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`phase 3 finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 160)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const otpLogin = async target => { const req = await api('/auth/otp/request', { target, channel: 'sms' }); const v = await fetch(`${baseUrl}/api/auth/otp/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, code: req.code }) }); return v.headers.get('set-cookie').split(';')[0]; };

  test('installer seeded the chart of accounts, bank accounts, fee structures and a fine rule', async () => {
    const ov = await api('/fees/overview');
    assert.ok(ov.heads.length >= 8, JSON.stringify(ov.heads.length));
    assert.ok(ov.structures.length >= 10, 'a structure per class');
    const accounts = await api('/accounting/accounts');
    assert.ok(accounts.length > 40);
    assert.ok(accounts.find(a => a.code === '1300' && a.name.includes('Receivable')));
    assert.equal((await app.accounting.bankAccounts(schoolId)).length, 2);
    assert.ok(await app.db.findOne('late_fine_rules', { school_id: schoolId }));
  });

  test('invoice batch: one invoice per student, pro-rata for the mid-month admission, journals posted', async () => {
    const b = await api('/fees/batches', { billingPeriod: period });
    assert.ok(b.batchId);
    let batch; let guard = 0;
    do { await app.adapters.queue.drain(10); batch = await api(`/fees/batches/${b.batchId}`); } while (batch.status !== 'success' && ++guard < 60);
    assert.equal(batch.status, 'success', JSON.stringify(batch));
    assert.equal(Number(batch.invoice_count), 11, 'ten in one class plus the sibling in another');
    const invoices = await api(`/fees/invoices?period=${period}`);
    assert.equal(invoices.length, 11);
    const full = invoices.find(i => i.student_id === students[0].id);
    const prorata = invoices.find(i => i.student_id === students[9].id);
    assert.ok(Number(prorata.total) < Number(full.total), `pro-rata ${prorata.total} should be less than ${full.total}`);
    assert.ok(Number(prorata.total) > 0);
    // every invoice posted its own journal entry
    const entries = await app.accounting.entries(schoolId, { sourceType: 'invoice', from: monthStart, to: monthEnd });
    assert.equal(entries.length, 11, 'one journal per invoice, all automatic');
    assert.ok(entries.every(e => Number(e.is_auto) === 1), 'zero manual fee journals');
    // re-running the batch does not double-bill
    const again = await api('/fees/batches', { billingPeriod: period });
    assert.equal(again.already, true);
    assert.equal((await api(`/fees/invoices?period=${period}`)).length, 11);
  });

  test('sibling discount is proposed automatically and applies once approved (A9)', async () => {
    await app.relay.run();
    const proposed = await api('/fees/discounts');
    const sib = proposed.find(x => x.discount_kind === 'sibling');
    assert.ok(sib, `a sibling discount should be proposed: ${JSON.stringify(proposed)}`);
    assert.equal(sib.status, 'pending', 'it waits for approval');
    await api(`/fees/discounts/${sib.id}/decide`, { decision: 'approved' });
    // the next invoice for that student carries the discount
    const inv = await api('/fees/invoices', { studentId: sib.student_id ?? students[10].id, items: [{ description: 'Extra tuition', amount: 1000 }] });
    const full = await api(`/fees/invoices/${inv.id}`);
    assert.ok(Number(full.discount_total) > 0, `discount applied: ${JSON.stringify({ subtotal: full.subtotal, discount: full.discount_total })}`);
    assert.equal(money(Number(full.subtotal) - Number(full.discount_total)), money(full.total));
  });

  test('payment: allocated oldest-first, ledger and journal follow, guardian gets an SMS', async () => {
    const before = app.adapters.sms.sent.length;
    const invoices = await api(`/fees/invoices?studentId=${students[0].id}`);
    const invoice = invoices[0];
    const half = money(Number(invoice.total) / 2);
    const p1 = await api('/fees/payments', { studentId: students[0].id, amount: half, method: 'cash' });
    assert.equal(p1.allocated.length, 1);
    assert.equal(money(p1.allocated[0].amount), half);
    let inv = await api(`/fees/invoices/${invoice.id}`);
    assert.equal(inv.status, 'partially_paid');
    assert.equal(money(inv.balance), money(Number(invoice.total) - half));
    const p2 = await api('/fees/payments', { studentId: students[0].id, amount: money(Number(invoice.total) - half + 200), method: 'bkash' });
    inv = await api(`/fees/invoices/${invoice.id}`);
    assert.equal(inv.status, 'paid');
    assert.equal(money(inv.balance), 0);
    assert.equal(money(p2.unallocated), 200, 'the extra stays as an advance');
    const ledger = await api(`/fees/students/${students[0].id}/ledger`);
    assert.ok(ledger.entries.length >= 3);
    assert.equal(ledger.entries[0].entry_type, 'invoice');
    assert.ok(ledger.entries.some(e => e.entry_type === 'payment'));
    await app.adapters.queue.drain(30);
    assert.ok(app.adapters.sms.sent.length > before, 'the guardian was told about the payment');
    // both payments posted their own journal
    const entries = await app.accounting.entries(schoolId, { sourceType: 'payment' });
    assert.equal(entries.length, 2);
  });

  test('reminder ladder and late fines', async () => {
    // an invoice due 10 days ago for a student with no payments
    const due = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
    await app.db.update('invoices', { due_date: due }, { student_id: students[1].id });
    const smsBefore = app.adapters.sms.sent.length;
    const r = await api('/fees/reminders/run', {});
    assert.ok(r.sent >= 1, JSON.stringify(r));
    await app.adapters.queue.drain(30);
    assert.ok(app.adapters.sms.sent.length > smsBefore);
    // the same stage never fires twice
    assert.equal((await api('/fees/reminders/run', {})).sent, 0);
    const fines = await api('/fees/fines/run', {});
    assert.ok(fines.overdue >= 1 && fines.fined >= 1, JSON.stringify(fines));
    const inv = (await api(`/fees/invoices?studentId=${students[1].id}`))[0];
    assert.ok(Number(inv.fine_total) > 0);
    assert.equal(inv.status, 'overdue');
    assert.equal(money(inv.balance), money(Number(inv.total) - Number(inv.paid_total)));
    // running fines again does not stack a second fine on the same invoice
    const before = Number(inv.fine_total);
    await api('/fees/fines/run', {});
    assert.equal(Number((await api(`/fees/invoices?studentId=${students[1].id}`))[0].fine_total), before);
  });

  test('the ladder can be read back as it actually ran', async () => {
    const r = await api('/fees/reminders');
    assert.ok(r.ladder.length >= 5, 'every stage of the ladder is named');
    assert.deepEqual(r.ladder.map(s => s.stage), ['due_in_3', 'due_today', 'overdue_3', 'overdue_7', 'overdue_15']);
    assert.equal(r.stages.length, r.ladder.length, 'a stage with nothing to show is still listed');
    const fired = r.stages.filter(s => s.reminders > 0);
    assert.ok(fired.length >= 1, JSON.stringify(r.stages));
    assert.ok(fired.every(s => s.lastSent), 'a stage that has run says when');
    assert.ok(r.rows.length >= 1, 'one row per invoice per stage');
    const row = r.rows[0];
    assert.ok(row.invoice_no && row.first_name, 'the row names the invoice and the child');
    assert.ok(row.told >= 1, 'it says how many people were written to');
    assert.ok(row.messages.every(m => m.channel && m.status), 'each message carries its channel and what came back');
    assert.ok(row.messages.some(m => m.channel === 'sms'), 'the SMS the guardian was sent is on the row');
    // filtering by a stage that fired returns only that stage
    const one = await api(`/fees/reminders?stage=${row.stage}`);
    assert.ok(one.rows.length >= 1 && one.rows.every(x => x.stage === row.stage));
    // and a stage nothing reached comes back empty rather than wrong
    assert.equal((await api('/fees/reminders?stage=nothing_like_this')).rows.length, 0);
  });

  test('chasing one family by hand never silences the stage the ladder owes them', async () => {
    const before = await api('/fees/reminders');
    const stagesBefore = JSON.stringify(before.stages);
    const smsBefore = app.adapters.sms.sent.length;
    const chased = await api(`/fees/students/${students[1].id}/remind`, {});
    assert.ok(chased.told >= 1 && chased.owed > 0, JSON.stringify(chased));
    await app.adapters.queue.drain(20);
    assert.ok(app.adapters.sms.sent.length > smsBefore, 'the guardian is actually written to');
    // it is recorded as its own stage, so nothing the ladder still owes has been marked as done
    const after = await api('/fees/reminders');
    assert.equal(JSON.stringify(after.stages), stagesBefore, 'not one ladder stage moved');
    assert.ok(after.rows.some(r => r.stage === 'manual' && r.student_id === students[1].id), 'and the chase is on the log');
    // a family that owes nothing is told so rather than sent a demand for zero
    const settled = await app.people.createStudent(schoolId, { firstName: 'Settled', gender: 'male', dateOfBirth: '2015-04-04', classId: String(classes[5].id), admissionDate: '2020-01-05', guardians: [{ fullName: 'Payer S', phone: '01830000090', relation: 'father', isPrimary: true }] });
    await assert.rejects(() => api(`/fees/students/${settled.id}/remind`, {}), /owes nothing/);
    // a call task is raised once per child, not once per press
    const t1 = await api(`/fees/students/${students[1].id}/call-task`, {});
    assert.ok(t1.taskId && t1.already === false, JSON.stringify(t1));
    const t2 = await api(`/fees/students/${students[1].id}/call-task`, {});
    assert.equal(t2.already, true);
    assert.equal(await app.db.count('tasks', { school_id: schoolId, entity_type: 'fees.student', entity_id: students[1].id, status: 'open' }), 1);
  });

  test('gateway IPN: signed, idempotent, credits the invoice', async () => {
    const gw = await api('/fees/gateways', { provider: 'bkash', displayName: 'bKash merchant', credentials: { appKey: 'k', appSecret: 's' }, isSandbox: true });
    const invoice = (await api(`/fees/invoices?studentId=${students[2].id}`))[0];
    const amount = money(invoice.balance);
    const sig = app.fees.ipnSignature(gw.id, 'TXN-1', amount);
    const bad = await fetch(`${baseUrl}/api/fees/ipn/${gw.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txnId: 'TXN-1', amount, status: 'success', sig: 'f'.repeat(64), studentId: students[2].id }) });
    assert.equal(bad.status, 403, 'a forged signature is refused');
    const ok = await fetch(`${baseUrl}/api/fees/ipn/${gw.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txnId: 'TXN-1', amount, status: 'success', sig, studentId: students[2].id, invoiceIds: [invoice.id] }) });
    const j = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(j));
    assert.equal(j.duplicate, false);
    assert.equal(money((await api(`/fees/invoices/${invoice.id}`)).balance), 0);
    // the gateway retries the same callback
    const retry = await (await fetch(`${baseUrl}/api/fees/ipn/${gw.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txnId: 'TXN-1', amount, status: 'success', sig, studentId: students[2].id }) })).json();
    assert.equal(retry.duplicate, true, 'a retried IPN must not double-credit');
    assert.equal(await app.db.count('payments', { gateway_txn_id: 'TXN-1' }), 1);
  });

  test('counter cash session reconciles what the cashier collected, and names the variance the moment it is counted', async () => {
    const s = await api('/fees/cash/open', { openingCash: 500 });
    assert.equal(s.already, false);
    await api('/fees/payments', { studentId: students[3].id, amount: 300, method: 'cash' });
    await api('/fees/payments', { studentId: students[4].id, amount: 200, method: 'cash' });
    // a bKash payment taken at the same counter is in the takings and never in the drawer
    await api('/fees/payments', { studentId: students[6].id, amount: 150, method: 'bkash', reference: 'TRX-COUNTER' });
    // the till as the cashier sees it, before anybody counts anything
    const till = await api(`/fees/cash/${s.id}`);
    assert.equal(till.closed, false);
    assert.equal(money(till.openingCash), 500);
    assert.equal(money(till.cashTaken), 500, 'only cash lands in the drawer');
    assert.equal(money(till.expected), 1000, 'opening 500 + 500 collected');
    assert.equal(money(till.takings), 650, 'everything taken at this counter, whatever the method');
    assert.equal(till.counted, null, 'nothing is counted until somebody counts it');
    assert.equal(till.receipts.length, 3, 'every receipt taken at this counter belongs to the session');
    const cashLine = till.byMethod.find(m => m.method === 'cash');
    assert.equal(money(cashLine.total), 500);
    assert.ok(till.byMethod.some(m => m.method === 'bkash' && money(m.total) === 150));
    const closed = await api('/fees/cash/close', { sessionId: s.id, countedCash: 990 });
    assert.equal(money(closed.expected), 1000, 'opening 500 + 500 collected');
    assert.equal(money(closed.variance), -10, 'a ten-taka shortfall is reported, not hidden');
    // and it is said out loud the moment it is counted, not found in a report tomorrow
    const told = await app.db.query(`SELECT * FROM notifications WHERE school_id = ? AND event_key = 'fees.cash_variance' AND entity_id = ?`, [schoolId, s.id]);
    assert.ok(told.length >= 1, 'the accountant and the head are told about the shortfall');
    assert.ok(told.some(n => String(n.body).includes('990') && String(n.body).includes('1000')), JSON.stringify(told[0]?.body));
    const after = await api(`/fees/cash/${s.id}`);
    assert.equal(after.closed, true);
    assert.equal(money(after.counted), 990);
    assert.equal(money(after.variance), -10);
    const list = await api('/fees/cash/sessions');
    assert.ok(list.some(x => x.id === s.id && money(x.variance) === -10 && x.cashier_name));
  });

  test('refund reverses the allocation and posts its own journal', async () => {
    const payments = await api('/fees/payments');
    const cash = payments.find(p => p.method === 'cash' && Number(p.amount) === 300);
    const r = await api(`/fees/payments/${cash.id}/refund`, { amount: 300, reason: 'Paid twice at the counter' });
    assert.ok(r.id);
    const ledger = await api(`/fees/students/${students[3].id}/ledger`);
    assert.ok(ledger.entries.some(e => e.entry_type === 'refund'));
    const entries = await app.accounting.entries(schoolId, { sourceType: 'refund' });
    assert.equal(entries.length, 1);
  });

  test('expenses post to the ledger and the month closes with a balanced trial balance', async () => {
    const cats = await api('/accounting/expense-categories');
    assert.ok(cats.length >= 8);
    const e = await api('/accounting/expenses', { categoryId: cats.find(c => c.name.includes('Utilities')).id, amount: 4500, description: 'Electricity bill' });
    assert.equal(e.status, 'approved', 'no workflow configured → approved and paid');
    const expenses = await api('/accounting/overview');
    assert.ok(expenses.expenses.some(x => Number(x.amount) === 4500 && x.status === 'paid'));
    const tb = await api(`/accounting/trial-balance?from=${monthStart}&to=${monthEnd}`);
    assert.equal(tb.balanced, true, `debits ${tb.totalDebit} vs credits ${tb.totalCredit}`);
    assert.ok(tb.totalDebit > 0);
    // the numbers the school cares about
    const st = await app.accounting.statements(schoolId, monthStart, monthEnd);
    assert.ok(st.income > 0 && st.expense >= 4500);
    assert.equal(money(st.surplus), money(st.income - st.expense));
    // the receivable account and the fee module must agree: invoiced - received + refunded
    const receivable = tb.accounts.find(a => a.code === '1300');
    const summary = await app.fees.receivablesSummary(schoolId);
    assert.equal(money(receivable.balance), money(summary.net), `ledger ${receivable.balance} vs fees ${summary.net}`);
    assert.ok(summary.advances > 0, 'the unallocated 200 is reported as an advance, not lost');
    assert.equal(money(summary.outstanding - summary.advances), money(summary.net));
  });

  test('the chart of accounts reads its balances off the journal, and a group is only what sits under it', async () => {
    const chart = await api('/accounting/chart');
    assert.ok(chart.accounts.length >= 20);
    const cash = chart.accounts.find(a => a.code === '1100');
    assert.equal(cash.is_group, false);
    assert.ok(cash.depth >= 1, 'a leaf sits under its group');
    // the leaf agrees with the ledger it was read from
    const tb = await api(`/accounting/trial-balance?from=1900-01-01&to=${monthEnd}`);
    const tbCash = tb.accounts.find(a => a.code === '1100');
    assert.equal(money(cash.balance), money(tbCash.debit - tbCash.credit));
    // a group carries nothing of its own: its figure is the sum of the leaves beneath it
    const assets = chart.accounts.find(a => a.code === '1000');
    assert.equal(assets.is_group, true);
    const byId = new Map(chart.accounts.map(a => [a.id, a]));
    const under = a => { let p = a.parent_id; while (p) { if (p === assets.id) return true; p = byId.get(p)?.parent_id ?? null; } return false; };
    const sum = chart.accounts.filter(a => !a.is_group && under(a)).reduce((a, l) => a + l.own, 0);
    assert.equal(money(assets.balance), money(sum), 'the group total is its children');
    assert.equal(money(assets.own), 0, 'and nothing was posted to the group itself');
  });

  test('an approved expense waits for one click, and pressing it twice does not spend twice', async () => {
    // a school that asks for a signature before money leaves: one step, the principal
    await app.db.execute(`UPDATE approval_workflows SET steps = ? WHERE school_id = ? AND entity_type = 'expense'`, [JSON.stringify([{ role: 'principal' }]), schoolId]);
    const cats = await api('/accounting/expense-categories');
    const e = await api('/accounting/expenses', { categoryId: cats.find(c => c.name.includes('Stationery')).id, amount: 2700, description: 'Whiteboard markers' });
    assert.equal(e.status, 'pending', 'the workflow holds it');
    const before = (await api('/accounting/expenses?status=pending')).find(x => x.id === e.id);
    assert.equal(before.journal_entry_id, null, 'nothing has been posted, so no money has moved');
    // everything but the click is already done — the number, the category, the two accounts it will hit
    const paid = await api(`/accounting/expenses/${e.id}/pay`, {});
    assert.ok(paid.entryNo, JSON.stringify(paid));
    const after = (await api('/accounting/expenses?status=paid')).find(x => x.id === e.id);
    assert.equal(after.status, 'paid');
    assert.ok(after.journal_entry_id);
    const entry = await api(`/accounting/entries/${paid.journalEntryId}`);
    assert.equal(entry.lines.length, 2);
    assert.equal(money(entry.lines.reduce((a, l) => a + Number(l.debit), 0)), 2700);
    // a second press posts nothing: the expense already carries its journal
    const again = await api(`/accounting/expenses/${e.id}/pay`, {});
    assert.equal(again.alreadyPosted, true);
    assert.equal(await app.db.count('journal_entries', { school_id: schoolId, source_type: 'expense', source_id: e.id }), 1);
    await app.db.execute(`UPDATE approval_workflows SET steps = ? WHERE school_id = ? AND entity_type = 'expense'`, [JSON.stringify([]), schoolId]);
  });

  test('a bank statement matches itself to what the modules already wrote, and says what is left', async () => {
    const banks = await api('/accounting/overview');
    const bank = banks.banks.find(b => b.account_kind === 'cash_box') ?? banks.banks[0];
    const on = new Date().toISOString().slice(0, 10);
    const r = await api('/accounting/bank/import', { bankAccountId: bank.id, lines: [
      { txnDate: on, description: 'CASH DEPOSIT COUNTER', reference: 'TRX100001', credit: 300 },
      { txnDate: on, description: 'CHQ 004512 STATIONERS', reference: 'TRX100002', debit: 2700 },
      { txnDate: on, description: 'BANK CHARGE', reference: 'TRX100003', debit: 41.37 },
    ] });
    assert.equal(r.imported, 3);
    assert.ok(r.matched >= 2, `a deposit of 300 and a payment of 2700 are already in the books: ${JSON.stringify(r)}`);
    assert.equal(r.unmatched, 3 - r.matched);
    const lines = await api('/accounting/bank/lines');
    assert.equal(lines.filter(l => l.reference?.startsWith('TRX1000')).length, 3);
    const charge = lines.find(l => l.reference === 'TRX100003');
    assert.equal(charge.matched_id, null, 'nothing in the books is 41.37, so it is left for a person rather than guessed at');
    assert.ok(lines.find(l => l.reference === 'TRX100002').matched_type, 'the stationery cheque found its expense');
    assert.equal(lines[0].bank_name, bank.bank_name, 'the line says which account it came off');
    // only what is still unmatched is looked at again, so a second pass changes nothing
    const second = await api('/accounting/bank/reconcile', { bankAccountId: bank.id });
    assert.equal(second.matched, 0, JSON.stringify(second));
    assert.equal((await api('/accounting/bank/lines?matched=0')).filter(l => l.reference === 'TRX100003').length, 1);
    assert.equal((await api('/accounting/bank/lines?matched=1')).some(l => l.reference === 'TRX100003'), false);
  });

  test('a manual journal must balance, and can be reversed', async () => {
    const accounts = await api('/accounting/accounts');
    const cash = accounts.find(a => a.code === '1100'), donation = accounts.find(a => a.code === '4300');
    await assert.rejects(() => api('/accounting/entries', { memo: 'Bad', lines: [{ accountId: cash.id, debit: 100 }, { accountId: donation.id, credit: 90 }] }), /does not balance/);
    const j = await api('/accounting/entries', { memo: 'Donation received', lines: [{ accountId: cash.id, debit: 5000 }, { accountId: donation.id, credit: 5000 }] });
    assert.ok(j.entryNo.startsWith('JV-'));
    const rev = await api(`/accounting/entries/${j.id}/reverse`, {});
    assert.ok(rev.entryNo);
    assert.equal((await api(`/accounting/entries/${j.id}`)).status, 'reversed');
    const tb = await api(`/accounting/trial-balance?from=${monthStart}&to=${monthEnd}`);
    assert.equal(tb.balanced, true, 'still balanced after a reversal');
  });

  test('guardian pay flow and SSR pages', async () => {
    guardianCookie = await otpLogin('01830000005');
    const fees = await api(`/portal/fees/${students[5].id}`, undefined, 'GET', { cookie: guardianCookie });
    assert.ok(fees.outstanding > 0);
    assert.ok(fees.invoices.length >= 1);
    assert.ok(fees.gateways.length >= 1, 'the guardian sees the configured gateway');
    const intent = await api(`/portal/fees/${students[5].id}/pay`, { gatewayId: fees.gateways[0].id, amount: fees.outstanding }, 'POST', { cookie: guardianCookie });
    assert.match(intent.txnId, /^PS/);
    assert.match(intent.ipnUrl, /\/api\/fees\/ipn\//);
    // the signature the gateway will echo back is the one the IPN endpoint accepts
    const paid = await (await fetch(`${baseUrl}/api/fees/ipn/${fees.gateways[0].id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txnId: intent.txnId, amount: intent.amount, status: 'success', sig: intent.signature, studentId: students[5].id }) })).json();
    assert.equal(paid.duplicate, false);
    assert.equal(money((await api(`/portal/fees/${students[5].id}`, undefined, 'GET', { cookie: guardianCookie })).outstanding), 0);
    // another guardian's child is refused
    assert.equal((await fetch(`${baseUrl}/api/portal/fees/${students[0].id}`, { headers: { cookie: guardianCookie } })).status, 403);
    // the reminder ladder, the till and the imported statement all reach the page, not only the API
    for (const [p, ck, needle] of [['/fees', cookie, 'Pupil1'], ['/fees', cookie, 'overdue_7'], ['/fees', cookie, 'cashier_name'], ['/accounts', cookie, 'Electricity'], ['/accounts', cookie, 'TRX100003']]) {
      const r = await fetch(`${baseUrl}${p}`, { headers: { cookie: ck } });
      const html = await r.text();
      assert.equal(r.status, 200, `${p} → ${r.status}`);
      assert.ok(html.includes(needle), `${p} should mention ${needle}`);
    }
  });
});
