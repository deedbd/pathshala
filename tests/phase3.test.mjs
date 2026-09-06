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

  test('counter cash session reconciles what the cashier collected', async () => {
    const s = await api('/fees/cash/open', { openingCash: 500 });
    assert.equal(s.already, false);
    await api('/fees/payments', { studentId: students[3].id, amount: 300, method: 'cash' });
    await api('/fees/payments', { studentId: students[4].id, amount: 200, method: 'cash' });
    const closed = await api('/fees/cash/close', { sessionId: s.id, countedCash: 990 });
    assert.equal(money(closed.expected), 1000, 'opening 500 + 500 collected');
    assert.equal(money(closed.variance), -10, 'a ten-taka shortfall is reported, not hidden');
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
    for (const [p, ck, needle] of [['/fees', cookie, 'Pupil1'], ['/accounts', cookie, 'Electricity']]) {
      const r = await fetch(`${baseUrl}${p}`, { headers: { cookie: ck } });
      const html = await r.text();
      assert.equal(r.status, 200, `${p} → ${r.status}`);
      assert.ok(html.includes(needle), `${p} should mention ${needle}`);
    }
  });
});
