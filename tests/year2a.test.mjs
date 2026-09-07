// Year 2, first batch: the money a child carries, the money somebody gives, and the people who left.
// Wallet and canteen, the shop a guardian orders from, scholarship funds and the donations that fill
// them, alumni written the day a class graduates, mentorship, the job board, competitions and the
// crew that runs an event.
//   node --test tests/year2a.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-y2a');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'y2a-key'.padEnd(64, 'x'), CRON_KEY: 'cron-y2a', UPLOADS_DIR: 'tests/.tmp-y2a/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-y2a/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, schoolId, yearId, classId, http, baseUrl, cookie, guardianCookie;
let outletId, samosa, juice, fundId, campaignId, donorId, alumniId, competitionId, eventId;
const students = [];
const t0 = Date.now();
const money = n => Math.round(Number(n) * 100) / 100;

describe('year 2: wallet & shop, giving, alumni, co-curricular', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Year Two School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01766666666', adminEmail: 'admin@y2a.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    await app.settings.set(schoolId, 'notifications.channels', { push: true, sms: true, email: true, in_app: true });
    yearId = String((await app.academic.currentYear(schoolId)).id);
    const classes = await app.academic.classes(schoolId);
    classId = String(classes[9].id);
    for (let i = 0; i < 4; i++) students.push(await app.people.createStudent(schoolId, { firstName: `Pupil${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2010-04-04', classId, admissionDate: '2020-01-05', guardians: [{ fullName: `Parent ${i + 1}`, phone: `0199000000${i}`, relation: 'mother', isPrimary: true, paysFees: true }] }));
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@y2a.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
    const g = (await app.db.query(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ?`, [students[0].id]))[0];
    const uid = g.user_id ?? await app.people.ensureGuardianAccount(schoolId, String(g.id));
    guardianCookie = `ps_session=${(await app.auth.createSession(await app.db.findOne('users', { id: uid }))).token}`;
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`year 2a finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 160)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const notified = async key => Number((await app.db.query(`SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND event_key = ?`, [schoolId, key]))[0].n);
  const balanceOf = async code => Number((await app.accounting.trialBalance(schoolId, '2020-01-01', '2099-12-31')).rows.find(r => String(r.code) === code)?.balance ?? 0);

  // ---------------- wallet and the canteen ----------------
  test('a top-up is money the school is holding, not money it has earned', async () => {
    const before = await api(`/commerce/wallets/${students[0].id}`);
    assert.equal(before.wallet, null, 'no wallet until there is a reason for one');
    const top = await api(`/commerce/wallets/${students[0].id}/topup`, { amount: 500, method: 'cash' });
    assert.equal(top.balanceAfter, 500);
    assert.ok(top.journalEntryId);
    const lines = await app.db.query(`SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.entry_id = ?`, [top.journalEntryId]);
    assert.equal(money(lines.find(l => l.code === '1100').debit), 500, 'cash in');
    assert.equal(money(lines.find(l => l.code === '2500').credit), 500, 'and a liability, not income');
    assert.ok(await notified('commerce.wallet_topped_up') >= 1, 'the guardian is told');
    const statement = await api(`/commerce/wallets/${students[0].id}`);
    assert.equal(statement.entries.length, 1);
    assert.equal(String(statement.entries[0].kind), 'topup');
    assert.equal(money(statement.entries[0].balance_after), 500);
  });

  test('the canteen sells against the card, and the wallet is a ledger not a number', async () => {
    outletId = (await api('/commerce/outlets', { name: 'Canteen', kind: 'canteen' })).id;
    samosa = (await api('/commerce/products', { outletId, name: 'Samosa', price: 15, category: 'Snacks' })).id;
    juice = (await api('/commerce/products', { outletId, name: 'Mango juice', price: 35, category: 'Drinks' })).id;
    const card = await api(`/commerce/wallets/${students[0].id}/card`);
    assert.match(card.code, /^[0-9A-F]{12}$/);

    const sale = await api('/commerce/sales', { outletId, cardCode: card.code, lines: [{ productId: samosa, quantity: 2 }, { productId: juice }] });
    assert.equal(money(sale.total), 65);
    assert.match(sale.saleNo, /^POS-/);
    assert.equal(sale.paidBy, 'wallet');
    const after = await api(`/commerce/wallets/${students[0].id}`);
    assert.equal(money(after.wallet.balance), 435);
    assert.equal(money(after.entries[0].balance_after), 435, 'every movement carries the balance it left behind');
    // the sale turns the liability into income; it does not take cash a second time
    const lines = await app.db.query(`SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.entry_id = ?`, [sale.journalEntryId]);
    assert.equal(money(lines.find(l => l.code === '2500').debit), 65);
    assert.equal(money(lines.find(l => l.code === '4180').credit), 65);
    assert.ok(await notified('commerce.sale') >= 1, 'the guardian sees what was bought');

    // an unknown card is refused, and so is a product from another outlet
    await assert.rejects(() => api('/commerce/sales', { outletId, cardCode: 'FFFFFFFFFFFF', lines: [{ productId: samosa }] }), /card/);
    const other = (await api('/commerce/outlets', { name: 'Bookshop', kind: 'bookshop' })).id;
    await assert.rejects(() => api('/commerce/sales', { outletId: other, cardCode: card.code, lines: [{ productId: samosa }] }), /not sold at this outlet/);
  });

  test('the daily limit is a refusal at the till, not a report afterwards', async () => {
    await api(`/commerce/wallets/${students[0].id}`, { dailyLimit: 100 }, 'PATCH');
    // 65 is already spent today: two more juices would be 135
    await assert.rejects(() => api('/commerce/sales', { outletId, studentId: students[0].id, lines: [{ productId: juice, quantity: 2 }] }), /daily limit/);
    const small = await api('/commerce/sales', { outletId, studentId: students[0].id, lines: [{ productId: samosa }] });
    assert.equal(money(small.total), 15);
    assert.equal(money((await api(`/commerce/wallets/${students[0].id}`)).wallet.balance), 420);
    // a frozen wallet buys nothing at all
    await api(`/commerce/wallets/${students[0].id}`, { status: 'frozen', dailyLimit: null }, 'PATCH');
    await assert.rejects(() => api('/commerce/sales', { outletId, studentId: students[0].id, lines: [{ productId: samosa }] }), /frozen/);
    await api(`/commerce/wallets/${students[0].id}`, { status: 'active' }, 'PATCH');
    // and a wallet cannot go below zero
    await assert.rejects(() => api('/commerce/sales', { outletId, studentId: students[1].id, lines: [{ productId: juice }] }), /the wallet holds only 0/);
  });

  test('a refund goes back to the wallet and reverses the entry rather than editing it', async () => {
    const sale = await api('/commerce/sales', { outletId, studentId: students[0].id, lines: [{ productId: juice }] });
    const before = money((await api(`/commerce/wallets/${students[0].id}`)).wallet.balance);
    const refund = await api(`/commerce/sales/${sale.id}/refund`, { reason: 'the juice was warm' });
    assert.equal(money(refund.amount), 35);
    assert.equal(money((await api(`/commerce/wallets/${students[0].id}`)).wallet.balance), money(before + 35));
    assert.equal(String((await app.db.findOne('pos_sales', { id: sale.id })).status), 'refunded');
    const tb = await api('/accounting/trial-balance?from=2020-01-01&to=2099-12-31');
    assert.equal(tb.balanced, true, `${tb.totalDebit} vs ${tb.totalCredit}`);
    // refunding twice is refused, not silently repeated
    await assert.rejects(() => api(`/commerce/sales/${sale.id}/refund`, { reason: 'again' }), /already refunded/);
  });

  test('the day book is what the counter is counted against', async () => {
    await api('/commerce/sales', { outletId, lines: [{ productId: samosa, quantity: 3 }], paidBy: 'cash' });
    const book = await api(`/commerce/daybook?outletId=${outletId}`);
    const cash = book.byMethod.find(m => m.paid_by === 'cash');
    assert.equal(money(cash.total), 45);
    assert.ok(book.byMethod.find(m => m.paid_by === 'wallet'));
    assert.ok(book.bestSellers.length >= 2);
    assert.equal(String(book.bestSellers[0].name), 'Samosa');
  });

  test('a guardian orders uniform from the app and collects it when the invoice is paid', async () => {
    const bookshop = (await api('/commerce/outlets')).outlets.find(o => String(o.name) === 'Bookshop');
    const shirt = (await api('/commerce/products', { outletId: String(bookshop.id), name: 'School shirt', price: 450 })).id;
    const order = await api('/portal/shop/orders', { studentId: students[0].id, outletId: String(bookshop.id), lines: [{ productId: shirt, quantity: 2 }] }, 'POST', { cookie: guardianCookie });
    assert.equal(money(order.total), 900);
    assert.match(order.orderNo, /^ORD-/);
    assert.ok(order.invoiceId, 'the money is asked for through the fee ledger, not a second system');
    assert.ok(await notified('commerce.order_placed') >= 1);
    // paying the invoice moves the order on by itself
    await api('/fees/payments', { studentId: students[0].id, amount: 900, method: 'cash', invoiceIds: [order.invoiceId] });
    await app.adapters.queue.drain(20);
    for (let i = 0; i < 10 && String((await app.db.findOne('shop_orders', { id: order.id })).status) === 'placed'; i++) { await app.tick({ budgetMs: 500 }); await app.adapters.queue.drain(10); }
    assert.equal(String((await app.db.findOne('shop_orders', { id: order.id })).status), 'paid');
    await api(`/commerce/orders/${order.id}/status`, { status: 'ready' });
    assert.ok(await notified('commerce.order_ready') >= 1, 'somebody has to be told it is on the counter');
    // another guardian cannot order for a child that is not theirs
    assert.equal((await fetch(`${baseUrl}/api/portal/shop/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: guardianCookie }, body: JSON.stringify({ studentId: students[3].id, outletId: String(bookshop.id), lines: [{ productId: shirt }] }) })).status, 403);
  });

  // ---------------- scholarships and giving ----------------
  test('a fund cannot promise more than it holds, and a zakat fund only pays need', async () => {
    fundId = (await api('/giving/funds', { name: 'Head teacher’s fund', kind: 'internal', opening: 20_000 })).id;
    const zakat = (await api('/giving/funds', { name: 'Zakat fund', kind: 'zakat', opening: 50_000 })).id;
    await assert.rejects(() => api('/giving/awards', { fundId, studentId: students[1].id, amount: 3000, frequency: 'monthly' }), /commits 36000/);
    await assert.rejects(() => api('/giving/awards', { fundId: zakat, studentId: students[1].id, amount: 5000 }), /need-based/);

    const award = await api('/giving/awards', { fundId, studentId: students[1].id, amount: 12_000, frequency: 'yearly' });
    assert.equal(award.status, 'proposed');
    assert.ok(award.discountId, 'a scholarship is a discount the invoice engine already understands');
    assert.equal(money((await app.db.findOne('scholarship_funds', { id: fundId })).balance), 20_000, 'nothing is committed until it is approved');
    const decided = await api(`/giving/awards/${award.id}/decide`, { decision: 'approved' });
    assert.equal(decided.status, 'active');
    assert.equal(money((await app.db.findOne('scholarship_funds', { id: fundId })).balance), 8_000);
    assert.equal(String((await app.db.findOne('student_discounts', { id: award.discountId })).status), 'approved');
    assert.ok(await notified('giving.scholarship_awarded') >= 1, 'the family is told they owe less');
    // the same fund cannot award the same student twice in a year
    await assert.rejects(() => api('/giving/awards', { fundId, studentId: students[1].id, amount: 1000 }), /already holds an award/);
  });

  test('the discount a scholarship creates comes off the invoice, once approved', async () => {
    const head = (await api('/fees/overview')).heads[0];
    const invoice = await api('/fees/invoices', { studentId: students[1].id, items: [{ feeHeadId: String(head.id), description: 'Session fee', amount: 20_000 }] });
    const full = await api(`/fees/invoices/${invoice.id}`);
    assert.equal(money(full.discount_total), 12_000, 'the scholarship paid its part');
    assert.equal(money(full.total), 8_000);
  });

  test('ending an award hands the rest back so it can help somebody else', async () => {
    const award = (await api(`/giving/awards?fundId=${fundId}`))[0];
    const ended = await api(`/giving/awards/${award.id}/end`, { reason: 'the family moved away', monthsUsed: 0 });
    assert.equal(money(ended.returnedToFund), 12_000);
    assert.equal(money((await app.db.findOne('scholarship_funds', { id: fundId })).balance), 20_000);
    assert.equal(String((await app.db.findOne('student_discounts', { id: String(award.discount_id) })).status), 'expired');
  });

  test('a donation is income the day it arrives, and comes with a receipt somebody can verify', async () => {
    donorId = (await api('/giving/donors', { name: 'Rahim Uddin', phone: '01712345678' })).id;
    const c = await api('/giving/campaigns', { title: 'New science lab', goalAmount: 500_000, description: 'Benches, gas lines and a fume hood.' });
    campaignId = c.id;
    assert.equal(c.slug, 'new-science-lab');
    await api(`/giving/campaigns/${campaignId}/status`, { status: 'live' });

    const pledge = await api('/giving/donations', { donorId, amount: 50_000, campaignId, kind: 'pledge' });
    assert.equal(pledge.journalEntryId, null, 'a promise is not money');
    assert.equal(money((await app.db.findOne('fundraising_campaigns', { id: campaignId })).raised_amount), 0);

    const received = await api('/giving/donations', { donorId, amount: 25_000, campaignId, fundId, method: 'bkash', message: 'For the children.' });
    assert.ok(received.journalEntryId);
    const lines = await app.db.query(`SELECT a.code, l.debit, l.credit FROM journal_lines l JOIN gl_accounts a ON a.id = l.account_id WHERE l.entry_id = ?`, [received.journalEntryId]);
    assert.equal(money(lines.find(l => l.code === '1220').debit), 25_000);
    assert.equal(money(lines.find(l => l.code === '4300').credit), 25_000);
    assert.equal(money((await app.db.findOne('fundraising_campaigns', { id: campaignId })).raised_amount), 25_000);
    assert.equal(money((await app.db.findOne('scholarship_funds', { id: fundId })).balance), 45_000, 'the gift reached the fund it was meant for');
    assert.equal(money((await app.db.findOne('donors', { id: donorId })).total_donated), 25_000);
    const receipt = await api(`/giving/donations/${received.id}/receipt`, {});
    assert.equal(receipt.alreadyIssued, true, 'the receipt was written when the money arrived');
    const doc = await app.db.findOne('issued_documents', { id: receipt.documentId });
    assert.equal(String(doc.doc_type), 'donation_receipt');
    assert.equal((await app.documents.verify(String(doc.verification_code))).valid, true);
    assert.ok(await notified('giving.thank_you') >= 1);

    // a pledge that is honoured takes the same path as any other donation
    const honoured = await api(`/giving/donations/${pledge.id}/receive`, { method: 'cash' });
    assert.ok(honoured.journalEntryId);
    assert.equal(money((await app.db.findOne('fundraising_campaigns', { id: campaignId })).raised_amount), 75_000);
    const tb = await api('/accounting/trial-balance?from=2020-01-01&to=2099-12-31');
    assert.equal(tb.balanced, true);
  });

  test('the appeal page shows how far it has come, and never names a donor who asked not to be', async () => {
    const shy = (await api('/giving/donors', { name: 'A quiet neighbour', phone: '01712345679', isAnonymous: true })).id;
    await api('/giving/donations', { donorId: shy, amount: 5_000, campaignId, method: 'cash' });
    const page = await (await fetch(`${baseUrl}/api/public/site/appeals/new-science-lab`)).json();
    assert.equal(page.goal, 500_000);
    assert.equal(page.raised, 80_000);
    assert.equal(page.percent, 16);
    assert.equal(page.recent.length, 3);
    assert.ok(page.recent.some(r => r.name === 'A well-wisher'), JSON.stringify(page.recent.map(r => r.name)));
    assert.ok(!JSON.stringify(page).includes('01712345679'), 'a public page carries no phone numbers');
    // a draft appeal is not public at all
    const draft = await api('/giving/campaigns', { title: 'Roof repair', goalAmount: 100_000 });
    assert.equal((await fetch(`${baseUrl}/api/public/site/appeals/${draft.slug}`)).status, 404);
  });

  // ---------------- alumni ----------------
  test('graduating a class writes the alumni directory, and running it twice changes nothing', async () => {
    const r = await api('/alumni/graduate', { classId, graduationYear: 2026 });
    assert.equal(r.added, students.length);
    assert.equal(r.students, students.length);
    const again = await api('/alumni/graduate', { classId, graduationYear: 2026 });
    assert.equal(again.added, 0);
    assert.equal(again.alreadyThere, students.length);
    assert.equal(String((await app.db.findOne('students', { id: students[0].id })).status), 'alumni');
    const { directory, batches } = await api('/alumni');
    assert.equal(directory.length, students.length);
    assert.equal(Number(batches[0].graduation_year), 2026);
    assert.equal(Number(batches[0].members), students.length);
    alumniId = String(directory[0].id);
  });

  test('the public directory holds only those who asked to be in it, and never a phone number', async () => {
    assert.equal((await (await fetch(`${baseUrl}/api/public/site/alumni`)).json()).length, 0, 'nobody is public by default');
    await api(`/alumni/${alumniId}`, { isPublic: true, isMentor: true, currentOrganisation: 'Grameenphone', currentPosition: 'Engineer', city: 'Dhaka', phone: '01812345678' }, 'PATCH');
    const listed = await (await fetch(`${baseUrl}/api/public/site/alumni`)).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].organisation, 'Grameenphone');
    assert.ok(!JSON.stringify(listed).includes('01812345678'), 'the school passes messages on, it does not hand out numbers');
  });

  test('a mentor takes three students and no more, and both sides are told', async () => {
    const more = [];
    for (let i = 0; i < 4; i++) more.push(await app.people.createStudent(schoolId, { firstName: `Junior${i + 1}`, gender: 'male', dateOfBirth: '2013-01-01', classId: String((await app.academic.classes(schoolId))[5].id), guardians: [{ fullName: `Parent J${i}`, phone: `0198800000${i}`, relation: 'father', isPrimary: true }] }));
    const notMentor = (await api('/alumni')).directory.find(a => String(a.id) !== alumniId);
    await assert.rejects(() => api('/alumni/mentorships', { mentorId: String(notMentor.id), studentId: more[0].id }), /has not offered to mentor/);
    for (let i = 0; i < 3; i++) await api('/alumni/mentorships', { mentorId: alumniId, studentId: more[i].id, topic: 'engineering' });
    await assert.rejects(() => api('/alumni/mentorships', { mentorId: alumniId, studentId: more[3].id }), /already mentors 3/);
    assert.ok(await notified('alumni.mentorship_started') >= 3);
    const pairs = await api('/alumni/mentorships?active=1');
    assert.equal(pairs.length, 3);
    await api(`/alumni/mentorships/${String(pairs[0].id)}/end`, {});
    assert.equal((await api('/alumni/mentorships?active=1')).length, 2);
    await api('/alumni/mentorships', { mentorId: alumniId, studentId: more[3].id, topic: 'engineering' });
  });

  test('a job post that has expired is closed rather than left to mislead somebody', async () => {
    await api('/alumni/jobs', { title: 'Junior developer', company: 'Grameenphone', location: 'Dhaka', postedByAlumniId: alumniId, expiresAt: '2099-12-31' });
    const stale = await api('/alumni/jobs', { title: 'Summer internship', company: 'BRAC', expiresAt: '2020-01-01' });
    const open = await api('/alumni/jobs');
    assert.equal(open.length, 1);
    assert.equal(String(open[0].title), 'Junior developer');
    assert.equal(String(open[0].posted_by), (await api('/alumni')).directory.find(a => String(a.id) === alumniId).full_name);
    assert.equal(String((await app.db.findOne('job_board_posts', { id: stale.id })).status), 'closed');
  });

  // ---------------- competitions and the crew that runs an event ----------------
  test('a competition result reaches the portfolio, the house table and a certificate at once', async () => {
    const houses = [];
    for (const [name, color] of [['Padma', '#1f7a4d'], ['Meghna', '#8a1c1c']]) {
      const id = `HOUSE${name.toUpperCase()}`.padEnd(26, '0').slice(0, 26);
      await app.db.insert('houses', { id, school_id: schoolId, name, color, points: 0 });
      houses.push({ id });
    }
    const contenders = (await app.people.students(schoolId, { limit: 10 })).rows.filter(s => String(s.status) === 'active').slice(0, 3);
    for (const [i, s] of contenders.entries()) await app.db.update('students', { house_id: String(houses[i % houses.length].id) }, { id: String(s.id) });
    competitionId = (await api('/engagement/competitions', { name: 'Inter-house debate', kind: 'debate', level: 'intra', heldOn: '2026-08-01' })).id;
    const r = await api(`/engagement/competitions/${competitionId}/results`, {
      certificates: true,
      results: contenders.map((s, i) => ({ studentId: String(s.id), position: i + 1, award: i === 0 ? 'Champion' : null })),
    });
    assert.equal(r.saved, 3);
    assert.equal(r.certificates, 3);
    const results = (await api(`/engagement/competitions?id=${competitionId}`)).results;
    assert.equal(results.length, 3);
    assert.equal(Number(results[0].position), 1);
    assert.ok(results[0].certificate_doc_id);
    const portfolio = await app.engagement.portfolio(schoolId, String(contenders[0].id));
    assert.ok(portfolio.achievements.some(a => String(a.title).includes('Champion')), 'it is on the child’s record');
    const table = await app.engagement.houseTable(schoolId);
    assert.equal(Number(table.reduce((a, h) => a + Number(h.points), 0)), 10 + 6 + 3);
    // correcting a result does not add the points a second time
    await api(`/engagement/competitions/${competitionId}/results`, { results: [{ studentId: String(contenders[2].id), position: 2 }] });
    const after = await app.engagement.houseTable(schoolId);
    assert.equal(Number(after.reduce((a, h) => a + Number(h.points), 0)), 19, 'the house ledger is written once per result');
  });

  test('an event has a programme and a crew, and only a confirmed volunteer is told to turn up', async () => {
    eventId = (await api('/engagement/events', { title: 'Annual sports day', eventType: 'sports', startsAt: '2026-12-10 08:00:00', venue: 'School field' })).id;
    await api(`/engagement/events/${eventId}/programme`, { items: [
      { startsAt: '2026-12-10 09:30:00', title: 'Track events', presenter: 'PE department' },
      { startsAt: '2026-12-10 08:15:00', title: 'March past' },
      { startsAt: '2026-12-10 12:00:00', title: 'Prize giving', presenter: 'Head teacher' },
    ] }, 'PUT');
    const programme = await api(`/engagement/events/${eventId}/programme`);
    assert.equal(programme.schedule.length, 3);
    assert.equal(String(programme.schedule[0].title), 'March past', 'the programme is in time order whatever order it was typed in');

    const before = await notified('engagement.volunteer_confirmed');
    const v = await api(`/engagement/events/${eventId}/volunteers`, { role: 'Refreshments' }, 'POST', { cookie: guardianCookie });
    assert.equal(v.status, 'applied');
    assert.equal(await notified('engagement.volunteer_confirmed'), before, 'offering to help is not the same as being told to turn up');
    const confirmed = await api(`/engagement/volunteers/${v.id}/decide`, { status: 'confirmed' });
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(await notified('engagement.volunteer_confirmed') > before, 'a confirmed volunteer is told');
    const crew = (await api(`/engagement/events/${eventId}/programme`)).volunteers;
    assert.equal(crew.length, 1);
    assert.equal(String(crew[0].status), 'confirmed');
  });
});
