// Money that nobody clicked: the watchdog jobs in fees, accounting, commerce and giving.
// Every one of them is run twice — the relay and the scheduler both deliver at least once, so a job
// that acts on the second pass is a job that double-charges somebody — and every one is also run
// against a school where there is nothing to do, because a watchdog that invents work is worse than
// no watchdog at all.
//   node --test tests/auto-fees.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-auto');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'auto-key'.padEnd(64, 'x'), CRON_KEY: 'cron-auto', UPLOADS_DIR: 'tests/.tmp-auto/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-auto/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');

const t0 = Date.now();
const money = n => Math.round(Number(n) * 100) / 100;
const DAY = n => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const TODAY = DAY(0);

let app, schoolId, yearId, classId, adminId, headId;
const students = [];

/** The job runner the scheduler would use, so the tests drive exactly what a cron line drives. */
const runJob = (svc, key, payload = {}) => app[svc].jobs()[key]({ schoolId, jobKey: key, payload, deadline: Date.now() + 20_000 });
const openTasks = async (entityType, entityId) => app.db.query(`SELECT * FROM tasks WHERE school_id = ? AND entity_type = ? AND entity_id = ? AND status = 'open'`, [schoolId, entityType, entityId]);
const notified = async key => Number((await app.db.query(`SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND event_key = ?`, [schoolId, key]))[0].n);
const events = async type => Number((await app.db.query(`SELECT COUNT(*) AS n FROM outbox_events WHERE school_id = ? AND event_type = ?`, [schoolId, type]))[0].n);

describe('automation: the money nobody clicked', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Watchdog High School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01799000001', adminEmail: 'admin@auto.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    yearId = String((await app.academic.currentYear(schoolId)).id);
    classId = String((await app.academic.classes(schoolId))[5].id);
    adminId = String((await app.db.findOne('users', { school_id: schoolId, email: 'admin@auto.test' })).id);
    headId = String((await app.fees.heads(schoolId)).find(h => h.code === 'TUITION').id);
    for (let i = 0; i < 4; i++) {
      students.push(await app.people.createStudent(schoolId, { firstName: `Child${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2012-02-02', classId, admissionDate: '2021-01-05', guardians: [{ fullName: `Parent ${i + 1}`, phone: `0198800000${i}`, relation: 'father', isPrimary: true, paysFees: true }] }));
    }
  });
  after(async () => { await app?.stop(); console.log(`auto-fees finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const invoice = (studentId, on, amount) => app.fees.createInvoice(schoolId, { studentId, academicYearId: yearId, issueDate: on, dueDay: Number(on.slice(8, 10)), items: [{ feeHeadId: headId, description: `Tuition ${on}`, amount }] });

  // ---------------- fees ----------------
  test('a receipt is printed by the system, and only ever once', async () => {
    const inv = await invoice(students[0].id, DAY(-3), 1000);
    const pay = await app.fees.recordPayment(schoolId, { studentId: students[0].id, amount: 600, method: 'cash', invoiceIds: [inv.id] });
    assert.equal((await app.db.findOne('payments', { id: pay.id })).receipt_file_id, null, 'nothing is printed at the counter');

    const first = await runJob('fees', 'fees.money_watch');
    assert.ok(first.receipts >= 1, 'the receipt is issued without anybody asking');
    const fileId = (await app.db.findOne('payments', { id: pay.id })).receipt_file_id;
    assert.ok(fileId, 'and it is kept on the payment');

    const again = await runJob('fees', 'fees.money_watch');
    assert.equal(again.receipts, 0, 'a second pass prints nothing');
    assert.equal(String((await app.db.findOne('payments', { id: pay.id })).receipt_file_id), fileId, 'one payment, one receipt');
  });

  test('a cheque past its clearing window becomes one task, and the office decides', async () => {
    const old = await app.fees.recordPayment(schoolId, { studentId: students[1].id, amount: 2000, method: 'cheque', reference: 'CHQ-77001', paidAt: `${DAY(-10)} 10:00:00` });
    assert.equal(old.pending, true, 'a cheque is not money yet');
    const fresh = await app.fees.recordPayment(schoolId, { studentId: students[1].id, amount: 500, method: 'cheque', reference: 'CHQ-77002', paidAt: `${TODAY} 10:00:00` });

    const first = await runJob('fees', 'fees.money_watch');
    assert.equal(first.cheques, 1, 'the old one is chased, the fresh one is not');
    const tasks = await openTasks('fees.payment', old.id);
    assert.equal(tasks.length, 1);
    assert.equal(String(tasks[0].assigned_role), 'accountant');
    assert.match(String(tasks[0].title), /CHQ-77001/, 'the task carries the cheque number, so nobody has to search');
    assert.equal((await openTasks('fees.payment', fresh.id)).length, 0, 'a cheque handed in today is nobody\'s problem yet');
    assert.equal(await events('cheque.overdue'), 1);

    assert.equal((await runJob('fees', 'fees.money_watch')).cheques, 0, 'it is not asked for twice');
    assert.equal((await openTasks('fees.payment', old.id)).length, 1);
    assert.equal(await events('cheque.overdue'), 1);

    // clearing it is still a person's decision, and it is the same receipt number that clears
    const cleared = await app.fees.clearCheque(schoolId, old.id);
    assert.equal(cleared.id, old.id);
    assert.equal(String((await app.db.findOne('payments', { id: old.id })).status), 'success');
  });

  test('a till left open overnight asks its own cashier to count it', async () => {
    const session = await app.fees.openCashSession(schoolId, adminId, 500);
    await app.db.update('cash_sessions', { opened_at: `${DAY(-1)} 09:00:00` }, { id: session.id });

    const first = await runJob('fees', 'fees.money_watch');
    assert.equal(first.cashSessions, 1);
    const tasks = await openTasks('fees.cash_session', session.id);
    assert.equal(tasks.length, 1);
    assert.equal(String(tasks[0].assigned_to), adminId, 'the person who opened it is the person asked');
    assert.equal((await runJob('fees', 'fees.money_watch')).cashSessions, 0);
    assert.equal((await openTasks('fees.cash_session', session.id)).length, 1);

    // the counted cash is the one thing the database cannot know — but a difference is said out loud
    const closed = await app.fees.closeCashSession(schoolId, session.id, 400);
    assert.equal(money(closed.variance), -100);
    assert.ok(await notified('fees.cash_variance') >= 1, 'a till that does not add up is reported at once');
    assert.equal((await runJob('fees', 'fees.money_watch')).cashSessions, 0, 'a closed till is not chased');
  });

  test('a discount whose end date has passed stops being a discount', async () => {
    const scheme = await app.fees.createDiscountScheme(schoolId, { name: 'Winter offer', kind: 'custom', valueType: 'percent', value: 20 });
    const gone = await app.fees.grantDiscount(schoolId, students[2].id, scheme, yearId, { status: 'approved' });
    await app.db.update('student_discounts', { valid_to: DAY(-1) }, { id: gone });
    const live = await app.fees.createDiscountScheme(schoolId, { name: 'Summer offer', kind: 'custom', valueType: 'percent', value: 10 });
    const keep = await app.fees.grantDiscount(schoolId, students[3].id, live, yearId, { status: 'approved' });
    await app.db.update('student_discounts', { valid_to: DAY(30) }, { id: keep });

    const first = await runJob('fees', 'fees.money_watch');
    assert.equal(first.discountsExpired, 1);
    assert.equal(String((await app.db.findOne('student_discounts', { id: gone })).status), 'expired');
    assert.equal(String((await app.db.findOne('student_discounts', { id: keep })).status), 'approved', 'a discount still inside its dates is left alone');
    assert.equal(await events('discount.expired'), 1);
    assert.equal((await runJob('fees', 'fees.money_watch')).discountsExpired, 0);
    assert.equal(await events('discount.expired'), 1);
  });

  test('an instalment plan that has gone quiet is put in front of accounts once', async () => {
    const quiet = await app.fees.createInstalmentPlan(schoolId, { studentId: students[2].id, feeHeadId: headId, totalAmount: 9000, count: 3, firstDue: DAY(-40) });
    const recent = await app.fees.createInstalmentPlan(schoolId, { studentId: students[3].id, feeHeadId: headId, totalAmount: 6000, count: 3, firstDue: DAY(-2) });
    await app.fees.billDueInstalments(schoolId, TODAY);

    const first = await runJob('fees', 'fees.money_watch');
    assert.equal(first.quietPlans, 1, 'forty days late is quiet; two days late is the reminder ladder\'s job');
    const tasks = await openTasks('fees.instalment_plan', quiet.id);
    assert.equal(tasks.length, 1);
    assert.equal((await openTasks('fees.instalment_plan', recent.id)).length, 0);
    assert.equal((await runJob('fees', 'fees.money_watch')).quietPlans, 0);
    assert.equal((await openTasks('fees.instalment_plan', quiet.id)).length, 1);
  });

  test('what the school is owed, by how long — and said once a month, not once a day', async () => {
    // a child of its own: a discount or a part payment somewhere else would blur the buckets
    const child = await app.people.createStudent(schoolId, { firstName: 'Child5', gender: 'male', dateOfBirth: '2012-02-02', classId, admissionDate: '2021-01-05', guardians: [{ fullName: 'Parent 5', phone: '01988000055', relation: 'father', isPrimary: true, paysFees: true }] });
    await invoice(child.id, DAY(-45), 700);
    await invoice(child.id, DAY(-100), 900);
    const a = await app.fees.ageing(schoolId, TODAY);
    assert.ok(a.days31to60 >= 700, 'a month and a half late lands in the 31–60 bucket');
    assert.ok(a.over90 >= 900, 'and a hundred days late is older than ninety');
    assert.equal(money(a.total), money(a.notDue + a.days1to30 + a.days31to60 + a.days61to90 + a.over90), 'the buckets add up to the total');

    const first = await runJob('fees', 'fees.receivables_ageing');
    assert.equal(first.notified, true);
    assert.ok(await notified('fees.ageing') >= 1);
    const before = await notified('fees.ageing');
    const again = await runJob('fees', 'fees.receivables_ageing');
    assert.equal(again.already, true, 'the same month is not reported twice');
    assert.equal(await notified('fees.ageing'), before);
  });

  test('a month nobody billed gets billed, and a batch nobody finished is picked up again', async () => {
    const period = `${TODAY.slice(0, 7)}-01`;
    const prev = new Date(Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)) - 2, 1)).toISOString().slice(0, 10);
    // a school that has billed before: the previous month runs to success
    await app.fees.generateBatch(schoolId, { billingPeriod: prev });
    for (let i = 0; i < 20; i++) await app.adapters.queue.drain(10);
    assert.equal(String((await app.db.findOne('invoice_batches', { school_id: schoolId, billing_period: prev })).status), 'success');
    assert.ok(await events('invoice.batch_finished') >= 1, 'the batch says so itself');

    const day15 = `${TODAY.slice(0, 7)}-15`;
    assert.equal(await app.db.findOne('invoice_batches', { school_id: schoolId, billing_period: period }), null);
    const first = await runJob('fees', 'fees.money_watch', { onDate: day15 });
    assert.equal(first.batches, 1, 'the month the cron slept through is billed anyway');
    const batch = await app.db.findOne('invoice_batches', { school_id: schoolId, billing_period: period });
    assert.ok(batch);

    const again = await runJob('fees', 'fees.money_watch', { onDate: day15 });
    assert.equal(again.batches, 0, 'a month already billed is not billed twice');
    assert.equal((await app.db.query(`SELECT COUNT(*) AS n FROM invoice_batches WHERE school_id = ? AND billing_period = ?`, [schoolId, period]))[0].n, 1);

    // a batch interrupted an hour ago is pushed back onto the queue instead of sitting there for ever
    await app.db.update('invoice_batches', { status: 'running', started_at: `${DAY(-1)} 06:00:00` }, { id: String(batch.id) });
    assert.equal((await runJob('fees', 'fees.money_watch', { onDate: day15 })).batches, 1);
    for (let i = 0; i < 20; i++) await app.adapters.queue.drain(10);
    assert.equal(String((await app.db.findOne('invoice_batches', { id: String(batch.id) })).status), 'success', 'and it finishes');
  });

  // ---------------- accounting ----------------
  test('an approved expense posts itself, both on approval and on the catch-up pass', async () => {
    await app.db.insert('approval_workflows', { id: randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase(), school_id: schoolId, entity_type: 'expense', name: 'Expense approval', conditions: null, steps: [{ role: 'admin' }], auto_approve_after_hours: 0, escalate_after_hours: null, is_active: true });
    const category = (await app.db.findMany('expense_categories', { school_id: schoolId }))[0];

    // the approval is the human step: deciding it posts the journal, nobody has to remember
    const decided = await app.accounting.createExpense(schoolId, { categoryId: String(category.id), amount: 1500, description: 'Printer repair', expenseDate: TODAY });
    assert.equal(decided.status, 'pending');
    const request = await app.db.findOne('approval_requests', { school_id: schoolId, entity_type: 'expense', entity_id: decided.id });
    await app.approvals.decide(String(request.id), schoolId, 'approved');
    await app.relay.run();
    const paid = await app.db.findOne('expenses', { id: decided.id });
    assert.equal(String(paid.status), 'paid');
    assert.ok(paid.journal_entry_id, 'Dr expense, Cr cash — without a person opening the ledger');

    // and an approval that never reached the ledger (a process that died mid-way) is caught next morning
    const stranded = await app.accounting.createExpense(schoolId, { categoryId: String(category.id), amount: 800, description: 'Fan', expenseDate: TODAY });
    await app.db.update('expenses', { status: 'approved' }, { id: stranded.id });
    const first = await runJob('accounting', 'accounting.daily_watch');
    assert.equal(first.expensesPosted, 1);
    assert.ok((await app.db.findOne('expenses', { id: stranded.id })).journal_entry_id);
    assert.equal((await runJob('accounting', 'accounting.daily_watch')).expensesPosted, 0, 'and never posted a second time');
  });

  test('a budget over its threshold, a bank line that matches nothing, an entry that does not balance', async () => {
    const category = (await app.db.findMany('expense_categories', { school_id: schoolId }))[0];
    const fy = await app.accounting.fiscalYear(schoolId, TODAY);
    const budgetId = await app.accounting.setBudget(schoolId, String(fy.id), String(category.gl_account_id), 1000, 90);

    const bank = (await app.accounting.bankAccounts(schoolId))[0];
    await app.accounting.importStatement(schoolId, String(bank.id), [{ txnDate: DAY(-10), description: 'Unknown transfer', credit: 12345.67 }]);

    const entry = await app.accounting.post(schoolId, { entryDate: TODAY, memo: 'Hand entry', lines: [{ accountCode: '1100', debit: 100 }, { accountCode: '4100', credit: 100 }] });
    await app.db.execute(`UPDATE journal_lines SET debit = 250 WHERE entry_id = ? AND debit > 0`, [entry.id]);

    const first = await runJob('accounting', 'accounting.daily_watch');
    assert.equal(first.budgetAlerts, 1, 'spending past the alert line is named');
    assert.equal(first.unmatchedTasks, 1, 'a transfer nobody recognises is a person\'s job, not a guess');
    assert.equal(first.unbalanced, 1, 'post() cannot make one of these, so it came from outside');
    assert.equal((await openTasks('accounting.budget', budgetId)).length, 1);
    assert.equal((await openTasks('accounting.journal_entry', entry.id)).length, 1);
    assert.equal(String((await openTasks('accounting.journal_entry', entry.id))[0].priority), 'urgent');

    const again = await runJob('accounting', 'accounting.daily_watch');
    assert.deepEqual({ b: again.budgetAlerts, u: again.unmatchedTasks, j: again.unbalanced }, { b: 0, u: 0, j: 0 }, 'nothing is asked for twice');
    assert.equal((await openTasks('accounting.budget', budgetId)).length, 1);

    // put it back the way it was so the month-end statements are honest
    await app.db.execute(`UPDATE journal_lines SET debit = 100 WHERE entry_id = ? AND debit > 0`, [entry.id]);
  });

  test('the month that ended closes itself off, and the year that ended asks a person', async () => {
    const old = randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase();
    await app.db.insert('fiscal_years', { id: old, school_id: schoolId, name: '2024', start_date: '2024-01-01', end_date: '2024-12-31', is_closed: false });

    const month = TODAY.slice(0, 7);
    const first = await app.accounting.monthEnd(schoolId, month);
    assert.equal(first.already, false);
    assert.equal(first.notified, true);
    assert.equal(first.balanced, true, 'the trial balance the school\'s own rows produce');
    assert.ok(await notified('accounting.month_end') >= 1);
    const snapshots = await app.db.query(`SELECT * FROM report_snapshots WHERE school_id = ?`, [schoolId]);
    assert.equal(snapshots.length, 1, 'one snapshot for the month');
    assert.equal((await openTasks('accounting.fiscal_year', old)).length, 1, 'closing a year is final, so it is only ever proposed');
    assert.ok(!Number((await app.db.findOne('fiscal_years', { id: old })).is_closed), 'and the year itself is untouched');

    const again = await app.accounting.monthEnd(schoolId, month);
    assert.equal(again.already, true);
    assert.equal((await app.db.query(`SELECT COUNT(*) AS n FROM report_snapshots WHERE school_id = ?`, [schoolId]))[0].n, 1);
    assert.equal((await openTasks('accounting.fiscal_year', old)).length, 1);
  });

  // ---------------- commerce ----------------
  test('the till closes its own day, warns a wallet running dry, and chases goods nobody handed over', async () => {
    const outletId = await app.commerce.createOutlet(schoolId, { name: 'Canteen', kind: 'canteen' });
    const samosa = await app.commerce.addProduct(schoolId, { outletId, name: 'Samosa', price: 20 });
    await app.commerce.topUp(schoolId, students[0].id, 500, { method: 'cash' });
    await app.commerce.sell(schoolId, { outletId, studentId: students[0].id, paidBy: 'wallet', lines: [{ productId: samosa, quantity: 2 }] });
    // a wallet that has been used and is nearly empty
    await app.commerce.topUp(schoolId, students[1].id, 60, { method: 'cash' });
    await app.commerce.sell(schoolId, { outletId, studentId: students[1].id, paidBy: 'wallet', lines: [{ productId: samosa, quantity: 1 }] });

    const first = await runJob('commerce', 'commerce.day_close');
    assert.equal(first.outlets, 1, 'the day book goes to accounts by itself');
    assert.equal(first.lowBalance, 1, 'the wallet under the mark, and only that one');
    assert.ok(await notified('commerce.day_book') >= 1);
    const lowBefore = await notified('commerce.low_balance');

    const again = await runJob('commerce', 'commerce.day_close');
    assert.equal(again.outlets, 0, 'the same day is not reported twice');
    assert.equal(again.lowBalance, 0, 'and a family is not told the same thing every night');
    assert.equal(await notified('commerce.low_balance'), lowBefore);

    const order = await app.commerce.placeOrder(schoolId, { studentId: students[2].id, outletId, lines: [{ productId: samosa, quantity: 5 }] });
    await app.commerce.setOrderStatus(schoolId, order.id, 'paid');
    await app.db.update('shop_orders', { updated_at: `${DAY(-5)} 12:00:00` }, { id: order.id });
    const third = await runJob('commerce', 'commerce.day_close');
    assert.equal(third.staleOrders, 1);
    assert.equal((await openTasks('commerce.order', order.id)).length, 1);
    assert.equal((await runJob('commerce', 'commerce.day_close')).staleOrders, 0);
    assert.equal((await openTasks('commerce.order', order.id)).length, 1);
    assert.equal(money((await app.db.findOne('wallets', { school_id: schoolId, student_id: students[1].id })).balance), 40, 'and nothing topped the wallet up on the family\'s behalf');
  });

  // ---------------- giving ----------------
  test('an appeal closes on the date it said, and a pledge or an ending award asks a person', async () => {
    const fundId = await app.giving.createFund(schoolId, { name: 'Zakat fund', kind: 'zakat', opening: 50_000 });
    const donorId = await app.giving.donor(schoolId, { name: 'Rahim Uddin', phone: '01711000111' });
    const ending = await app.giving.createCampaign(schoolId, { title: 'Roof repair', goalAmount: 100_000, endsAt: DAY(-1) });
    const running = await app.giving.createCampaign(schoolId, { title: 'Science lab', goalAmount: 200_000, endsAt: DAY(30) });
    await app.giving.setCampaignStatus(schoolId, ending.id, 'live');
    await app.giving.setCampaignStatus(schoolId, running.id, 'live');

    // money already received but whose receipt never rendered
    const gift = await app.giving.donate(schoolId, { donorId, amount: 5000, method: 'cash', fundId });
    await app.db.update('donations', { receipt_doc_id: null }, { id: gift.id });
    // a promise that has sat there for six weeks
    const pledge = await app.giving.donate(schoolId, { donorId, amount: 20_000, kind: 'pledge', campaignId: running.id });
    await app.db.update('donations', { created_at: `${DAY(-42)} 09:00:00` }, { id: pledge.id });
    // an award that ran to the end of a year now over
    const oldYear = await app.academic.createYear(schoolId, { name: '2024', startDate: '2024-01-01', endDate: '2024-12-31', setCurrent: false });
    const award = await app.giving.award(schoolId, { fundId, studentId: students[0].id, amount: 3000, academicYearId: String(oldYear), frequency: 'yearly', needBased: true, approvedBy: adminId });

    const first = await runJob('giving', 'giving.daily');
    assert.equal(first.campaignsClosed, 1, 'the appeal whose date passed, and not the one still running');
    assert.equal(String((await app.db.findOne('fundraising_campaigns', { id: ending.id })).status), 'closed');
    assert.equal(String((await app.db.findOne('fundraising_campaigns', { id: running.id })).status), 'live');
    assert.equal(first.receipts, 1, 'a donor who cannot prove they gave stops giving');
    assert.equal(first.pledgeTasks, 1);
    assert.equal(first.awardsToReview, 1);
    assert.equal(await events('campaign.closed'), 1);
    assert.equal((await openTasks('giving.donation', pledge.id)).length, 1);
    assert.equal((await openTasks('giving.award', award.id)).length, 1);
    assert.equal(String((await app.db.findOne('scholarship_awards', { id: award.id })).status), 'active', 'the child keeps the discount until somebody decides otherwise');

    const again = await runJob('giving', 'giving.daily');
    assert.deepEqual({ c: again.campaignsClosed, r: again.receipts, p: again.pledgeTasks, a: again.awardsToReview }, { c: 0, r: 0, p: 0, a: 0 }, 'a second pass on the same day changes nothing');
    assert.equal(await events('campaign.closed'), 1);
    assert.equal((await openTasks('giving.donation', pledge.id)).length, 1);
  });

  test('a school with nothing wrong is left entirely alone', async () => {
    const quiet = await app.installer.addTenant({ schoolName: 'Quiet School', institutionType: 'school', locale: 'bn', adminName: 'Admin Two', adminPhone: '01799000002', adminEmail: 'admin@quiet.test', adminPassword: 'secret-pass-2' });
    const sid = quiet.schoolId;
    const run = (svc, key) => app[svc].jobs()[key]({ schoolId: sid, jobKey: key, payload: {}, deadline: Date.now() + 20_000 });

    const fees = await run('fees', 'fees.money_watch');
    assert.deepEqual(fees, { receipts: 0, cheques: 0, cashSessions: 0, quietPlans: 0, discountsExpired: 0, batches: 0, headsWithoutAccount: 0 }, 'a school that has never billed is not billed by a watchdog');
    const ageing = await run('fees', 'fees.receivables_ageing');
    assert.equal(ageing.notified, false, 'nothing owed, nothing to report');
    const acc = await run('accounting', 'accounting.daily_watch');
    assert.deepEqual({ e: acc.expensesPosted, b: acc.budgetAlerts, u: acc.unmatchedTasks, j: acc.unbalanced }, { e: 0, b: 0, u: 0, j: 0 });
    const shop = await run('commerce', 'commerce.day_close');
    assert.deepEqual({ o: shop.outlets, l: shop.lowBalance, s: shop.staleOrders }, { o: 0, l: 0, s: 0 });
    const give = await run('giving', 'giving.daily');
    assert.deepEqual({ c: give.campaignsClosed, r: give.receipts, p: give.pledgeTasks, a: give.awardsToReview }, { c: 0, r: 0, p: 0, a: 0 });
    assert.equal((await app.db.query(`SELECT COUNT(*) AS n FROM tasks WHERE school_id = ?`, [sid]))[0].n, 0, 'and nobody is given anything to do');
  });
});
