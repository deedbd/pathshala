// Phase 7 (operations): the library lends and fines, the bus tells guardians where it is and refuses
// to end a trip quietly with a child still on board, the hostel needs a guardian's consent before a
// resident leaves, the store reorders itself and turns a delivery into stock, an expense and a tagged
// asset, and the helpdesk escalates a ticket that misses its deadline.
//   node --test tests/phase7.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-p7');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'p7-key-'.padEnd(64, 'x'), CRON_KEY: 'cron-p7', UPLOADS_DIR: 'tests/.tmp-p7/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-p7/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, schoolId, yearId, http, baseUrl, cookie, classId, students = [], staffId, guardianCookie, guardianStudentId;
let bookId, memberId, accession, routeId, stopId, vehicleId, tripId, hostelId, bedId, itemId, storeId, vendorId, poId, ticketId, outpassId;
const t0 = Date.now();

describe('phase 7', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Phase Seven School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01777777777', adminEmail: 'admin@p7.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    await app.settings.set(schoolId, 'notifications.channels', { push: true, sms: true, email: true, in_app: true });
    yearId = String((await app.academic.currentYear(schoolId)).id);
    classId = String((await app.academic.classes(schoolId))[4].id);
    for (let i = 0; i < 6; i++) {
      students.push(await app.people.createStudent(schoolId, { firstName: `Rider${i + 1}`, gender: 'male', dateOfBirth: '2014-02-02', classId, guardians: [{ fullName: `Guardian ${i + 1}`, phone: `0196000000${i}`, relation: 'father', isPrimary: true }] }));
    }
    guardianStudentId = students[0].id;
    staffId = (await app.people.createStaff(schoolId, { firstName: 'Librarian', phone: '01966111111', staffCategory: 'non_teaching', joinDate: '2024-01-01' })).id;
    const vendor = { id: (await app.db.query(`SELECT id FROM vendors WHERE school_id = ? LIMIT 1`, [schoolId]))[0]?.id };
    if (!vendor.id) { const { ulid } = await import('../packages/db/dist/index.js'); vendorId = ulid(); await app.db.insert('vendors', { id: vendorId, school_id: schoolId, name: 'Karim Traders', phone: '01900000000', email: null, address: null, tax_id: null, bank_details: null, payable_gl_account_id: null, status: 'active' }); }
    else vendorId = String(vendor.id);
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@p7.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`phase 7 finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET', extra = {}) => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie: extra.cookie ?? cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 200)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const drain = async () => { let guard = 0; while (++guard < 200) { const { ran } = await app.adapters.queue.drain(10); const { published } = await app.relay.run(); if (!ran && !published) break; } };
  const notified = async eventKey => app.db.count('notifications', { school_id: schoolId, event_key: eventKey });
  // one notify writes a row per channel, so count the people reached, not the rows
  const told = async eventKey => Number((await app.db.query(`SELECT COUNT(DISTINCT COALESCE(recipient_user_id, recipient_address)) AS n FROM notifications WHERE school_id = ? AND event_key = ?`, [schoolId, eventKey]))[0].n);

  // ---------------- library ----------------
  test('a book is catalogued with its copies and lent to a member', async () => {
    const b = await api('/library/books', { title: 'Bangla Grammar', authors: ['Rafiq Hasan'], price: 250, copies: 2 });
    bookId = b.id;
    assert.equal(b.copies, 2);
    const copies = await app.library.copies(schoolId, bookId);
    accession = String(copies[0].accession_no);
    assert.match(accession, /^ACC-\d{6}$/);
    memberId = (await api('/library/members', { memberType: 'student', studentId: students[0].id, maxBooks: 1, loanDays: 7, finePerDay: 5 })).id;
    const issued = await api('/library/issues', { accessionNo: accession, memberId });
    assert.ok(issued.dueAt > new Date().toISOString().slice(0, 10));
    const book = await app.db.findOne('library_books', { id: bookId });
    assert.equal(Number(book.available_copies), 1, 'the shelf count went down');
    // the same copy cannot go out twice, and this member may only hold one book
    await assert.rejects(() => api('/library/issues', { accessionNo: accession, memberId }), /issued/);
    await assert.rejects(() => api('/library/issues', { accessionNo: String(copies[1].accession_no), memberId }), /the limit is 1/);
  });

  test('an overdue book is chased, fined at the daily rate, and billed on return', async () => {
    const issue = (await api(`/library/issues?memberId=${memberId}`))[0];
    // pretend it went out three weeks ago
    await app.db.execute(`UPDATE library_issues SET due_at = ?, issued_at = ? WHERE id = ?`, [daysAgo(4), `${daysAgo(11)} 09:00:00`, String(issue.id)]);
    const r = await app.library.jobs()['library.due_and_fines']({ schoolId, jobKey: 'library.due_and_fines', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(r.overdue, 1);
    assert.equal(r.reminded, 1, 'the guardian was told once');
    const after = await app.db.findOne('library_issues', { id: String(issue.id) });
    assert.equal(after.status, 'overdue');
    assert.equal(Number(after.fine_amount), 20, 'four days at five a day');
    // running the job again does not send the same reminder twice
    const again = await app.library.jobs()['library.due_and_fines']({ schoolId, jobKey: 'library.due_and_fines', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(again.reminded, 0);
    const back = await api('/library/return', { issueId: String(issue.id) });
    assert.equal(back.fine, 20);
    assert.ok(back.invoiceId, 'the fine went onto an invoice, not into the till');
    const invoice = await app.db.findOne('invoices', { id: back.invoiceId });
    assert.equal(Number(invoice.total), 20);
    const item = await app.db.findOne('invoice_items', { invoice_id: back.invoiceId });
    assert.equal(item.item_kind, 'fine');
    const book = await app.db.findOne('library_books', { id: bookId });
    assert.equal(Number(book.available_copies), 2, 'and the copy is back on the shelf');
  });

  test('the fine never exceeds the price of the book, and a hold is offered to the next reader', async () => {
    const copies = await app.library.copies(schoolId, bookId);
    const second = await api('/library/issues', { accessionNo: String(copies[1].accession_no), memberId });
    await app.db.execute(`UPDATE library_issues SET due_at = ? WHERE id = ?`, [daysAgo(100), second.id]);
    const otherMember = (await api('/library/members', { memberType: 'staff', staffId })).id;
    await api('/library/reservations', { bookId, memberId: otherMember });
    const back = await api('/library/return', { issueId: second.id });
    assert.equal(back.fine, 250, 'a hundred days at five a day is capped at the price');
    const hold = (await app.db.findMany('library_reservations', { book_id: bookId }))[0];
    assert.equal(hold.status, 'ready', 'the next member in the queue was offered the copy');
    assert.ok(hold.expires_at, 'and it is held for them');
  });

  // ---------------- transport ----------------
  test('a route with stops, riders paying the route fee, and today’s trips', async () => {
    vehicleId = (await api('/transport/vehicles', { registrationNo: 'DHAKA-METRO-GA-11-2233', capacity: 40, insuranceExpiry: daysAhead(20) })).id;
    routeId = (await api('/transport/routes', { name: 'Mirpur route', vehicleId, monthlyFee: 1500, stops: [{ name: 'Mirpur 10', sequence: 1, latitude: 23.8069, longitude: 90.3687, geofenceM: 300, pickupTime: '07:00:00' }, { name: 'Kazipara', sequence: 2, latitude: 23.7985, longitude: 90.3705, pickupTime: '07:15:00' }] })).id;
    const stops = await api(`/transport/routes/${routeId}/stops`);
    assert.equal(stops.length, 2);
    stopId = String(stops[0].id);
    for (const s of students.slice(0, 3)) {
      const a = await api('/transport/assign', { studentId: s.id, routeId, stopId });
      assert.equal(a.monthlyFee, 1500, 'the fee is snapshotted onto the rider');
    }
    assert.equal((await api(`/transport/routes/${routeId}/riders`)).length, 3);
    const made = await api('/transport/trips', { date: new Date().toISOString().slice(0, 10) });
    assert.equal(made.trips, 2, 'a pickup and a drop');
    const trips = await api('/transport/trips');
    tripId = String(trips.find(t => t.trip_type === 'pickup').id);
    assert.equal(trips.length, 2);
    // running it twice does not double the day
    assert.equal((await api('/transport/trips', { date: new Date().toISOString().slice(0, 10) })).trips, 0);
  });

  test('GPS inside the geofence warns the waiting guardians once, and speeding raises an incident', async () => {
    await api(`/transport/trips/${tripId}/start`, {});
    const before = await told('transport.bus_approaching');
    const r = await api('/transport/gps', { vehicleId, packets: [{ latitude: 23.8069, longitude: 90.3687, speedKmh: 30 }] });
    assert.equal(r.alerts, 1, 'one alert for the stop it reached');
    assert.equal(await told('transport.bus_approaching') - before, 3, 'the three guardians of that stop');
    // the same stop on the same trip is not announced twice
    assert.equal((await api('/transport/gps', { vehicleId, packets: [{ latitude: 23.8069, longitude: 90.3687, speedKmh: 25 }] })).alerts, 0);
    const fast = await api('/transport/gps', { vehicleId, packets: [{ latitude: 23.8069, longitude: 90.3687, speedKmh: 95 }] });
    assert.equal(fast.overspeed, 1);
    const incident = (await app.db.findMany('driver_incidents', { school_id: schoolId }))[0];
    assert.equal(incident.kind, 'overspeed');
    assert.equal(incident.severity, 'high');
  });

  test('boarding the morning bus marks the child present; ending a drop with a child aboard alerts everyone', async () => {
    await api('/transport/board', { tripId, studentId: students[0].id, stopId, source: 'rfid' });
    const attendance = await app.db.findOne('student_attendance', { student_id: students[0].id, on_date: new Date().toISOString().slice(0, 10) });
    assert.equal(attendance.status, 'present');
    assert.equal(attendance.source, 'bus', 'the bus is the register in the morning');
    const drop = String((await api('/transport/trips')).find(t => t.trip_type === 'drop').id);
    await api(`/transport/trips/${drop}/start`, {});
    await api('/transport/board', { tripId: drop, studentId: students[1].id, stopId, source: 'helper_app' });
    await api('/transport/board', { tripId: drop, studentId: students[2].id, stopId, source: 'helper_app' });
    await api('/transport/board', { tripId: drop, studentId: students[2].id, stopId, direction: 'alight' });
    const ended = await api(`/transport/trips/${drop}/end`, {});
    assert.equal(ended.stillOnBoard, 1, 'one child boarded and never got off');
    assert.ok(await notified('transport.not_alighted') >= 1);
    await drain();
    const task = await app.db.count('tasks', { school_id: schoolId, task_type: 'transport.safety' });
    assert.equal(task, 1, 'and somebody has to account for it');
  });

  test('papers expiring inside a month become tasks', async () => {
    const r = await app.transport.jobs()['transport.document_expiry']({ schoolId, jobKey: 'transport.document_expiry', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(r.tasks, 1, 'the insurance');
    const tasks = await app.db.findMany('tasks', { school_id: schoolId, task_type: 'transport.compliance' });
    assert.match(String(tasks[0].title), /insurance/);
  });

  // ---------------- hostel ----------------
  test('a hostel with beds, an allocation, and no double-booking', async () => {
    hostelId = (await api('/hostel', { name: 'Boys hostel', hostelType: 'boys', curfewTime: '21:00:00', rooms: [{ roomNo: '101', capacity: 2, monthlyFee: 3000 }] })).id;
    const { vacantBeds } = await api(`/hostel/${hostelId}/rooms`);
    assert.equal(vacantBeds.length, 2);
    bedId = String(vacantBeds[0].id);
    const a = await api('/hostel/allocations', { studentId: students[0].id, bedId });
    assert.equal(a.monthlyFee, 3000);
    await assert.rejects(() => api('/hostel/allocations', { studentId: students[1].id, bedId }), /occupied/);
    await assert.rejects(() => api('/hostel/allocations', { studentId: students[0].id, bedId: String(vacantBeds[1].id) }), /already has a bed/);
    const hostels = await api('/hostel');
    assert.equal(Number(hostels.hostels[0].occupied), 1);
    assert.equal(hostels.residents.length, 1);
  });

  test('an out-pass waits for the guardian, then the warden, then the gate', async () => {
    outpassId = (await api('/hostel/outpasses', { studentId: students[0].id, leaveFrom: `${new Date().toISOString().slice(0, 10)} 14:00:00`, expectedReturn: `${new Date().toISOString().slice(0, 10)} 18:00:00`, reason: 'family visit' })).id;
    assert.ok(await notified('hostel.consent_needed') >= 1);
    await assert.rejects(() => api(`/hostel/outpasses/${outpassId}/approve`, {}), /guardian has not consented/);
    // the guardian consents from the parent app
    const g = (await app.db.query(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ?`, [students[0].id]))[0];
    const session = await app.auth.createSession(await app.db.findOne('users', { id: g.user_id }));
    guardianCookie = `ps_session=${session.token}`;
    await api(`/portal/outpasses/${outpassId}/consent`, {}, 'POST', { cookie: guardianCookie });
    const approved = await api(`/hostel/outpasses/${outpassId}/approve`, {});
    assert.ok(approved.qr, 'the gate gets a code to scan');
    const out = await api('/hostel/outpasses/scan', { qr: approved.qr });
    assert.equal(out.direction, 'out');
    const back = await api('/hostel/outpasses/scan', { qr: approved.qr });
    assert.equal(back.direction, 'in');
    const row = await app.db.findOne('hostel_outpasses', { id: outpassId });
    assert.equal(row.status, 'returned');
    // another guardian cannot consent for somebody else's child
    const other = (await app.db.query(`SELECT g.* FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ?`, [students[3].id]))[0];
    const otherSession = await app.auth.createSession(await app.db.findOne('users', { id: other.user_id }));
    const second = (await api('/hostel/outpasses', { studentId: students[0].id, leaveFrom: `${new Date().toISOString().slice(0, 10)} 20:00:00`, expectedReturn: `${new Date().toISOString().slice(0, 10)} 21:00:00`, reason: 'dinner' })).id;
    assert.equal((await fetch(`${baseUrl}/api/portal/outpasses/${second}/consent`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: `ps_session=${otherSession.token}` }, body: '{}' })).status, 403);
  });

  test('somebody who is late back is chased, and the night roll call catches an unexplained absence', async () => {
    const pass = (await api('/hostel/outpasses', { studentId: students[0].id, leaveFrom: `${new Date().toISOString().slice(0, 10)} 06:00:00`, expectedReturn: `${new Date().toISOString().slice(0, 10)} 07:00:00`, reason: 'clinic' })).id;
    await app.db.execute(`UPDATE hostel_outpasses SET guardian_consent_at = ?, status = 'out', expected_return = ? WHERE id = ?`, [nowSql(), '2020-01-01 07:00:00', pass]);
    const late = await app.hostel.jobs()['hostel.curfew_watch']({ schoolId, jobKey: 'hostel.curfew_watch', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(late.late, 1);
    assert.ok(await notified('hostel.late_return') >= 1);
    const rc = await api('/hostel/roll-call', { hostelId, onDate: new Date().toISOString().slice(0, 10), call: 'night', marks: [{ studentId: students[0].id, status: 'absent' }] });
    assert.equal(rc.saved, 1);
    assert.ok(await notified('hostel.missing_at_rollcall') >= 1, 'the warden and the guardian both hear about it');
  });

  test('a mess that charges by the meal bills what was actually eaten, once', async () => {
    // a second resident, so the bill is not a single row that happens to work
    const { vacantBeds } = await api(`/hostel/${hostelId}/rooms`);
    await api('/hostel/allocations', { studentId: students[1].id, bedId: String(vacantBeds[0].id) });
    await app.settings.set(schoolId, 'hostel.meal_rates', { breakfast: 30, lunch: 70, snack: 20, dinner: 60 });
    const month = '2026-04';
    for (const day of ['01', '02', '03']) {
      await api(`/hostel/${hostelId}/meals`, { onDate: `${month}-${day}`, meal: 'lunch', rows: [{ studentId: students[0].id }, { studentId: students[1].id, taken: day !== '03' }] });
      await api(`/hostel/${hostelId}/meals`, { onDate: `${month}-${day}`, meal: 'dinner', rows: [{ studentId: students[0].id }] });
    }
    const summary = await api(`/hostel/mess/summary?studentId=${students[0].id}&month=${month}`);
    assert.equal(summary.meals.length, 2, 'lunches and dinners, counted apart');

    const billed = await api('/hostel/mess/bill', { month });
    assert.equal(billed.billed, 2, 'one invoice each, not one per meal');
    assert.equal(billed.total, (3 * 70 + 3 * 60) + (2 * 70), 'three lunches and three dinners for one, two lunches for the other');
    const invoices = await app.fees.invoices(schoolId, { studentId: students[0].id });
    const mess = invoices.find(i => String(i.notes) === `mess:${month}`);
    assert.ok(mess, 'the invoice says which month it settles');
    assert.equal(Math.round(Number(mess.total)), 3 * 70 + 3 * 60);
    const items = (await app.fees.invoice(schoolId, String(mess.id))).items;
    assert.equal(items.length, 2);
    assert.ok(items.every(i => /Mess (lunch|dinner) × 3/.test(String(i.description))), JSON.stringify(items.map(i => i.description)));
    // the price each meal was charged at is kept on the meal itself
    const meal = await app.db.findOne('meal_records', { student_id: students[0].id, on_date: `${month}-01`, meal: 'lunch' });
    assert.equal(Number(meal.cost), 70);
    // running the month again bills nobody twice, even after a rate change
    await app.settings.set(schoolId, 'hostel.meal_rates', { breakfast: 30, lunch: 999, snack: 20, dinner: 60 });
    const again = await api('/hostel/mess/bill', { month });
    assert.equal(again.billed, 0);
    assert.equal(again.skipped, 2);
    assert.equal(Math.round(Number((await app.db.findOne('invoices', { id: String(mess.id) })).total)), 3 * 70 + 3 * 60, 'the old bill kept its old prices');
  });

  // ---------------- inventory ----------------
  test('stock only moves through the ledger, and cannot go negative', async () => {
    const { stores, categories } = await api('/inventory/items');
    storeId = String(stores[0].id);
    const category = categories.find(c => c.name === 'Stationery');
    itemId = (await api('/inventory/items', { categoryId: String(category.id), name: 'A4 paper (ream)', unit: 'ream', reorderLevel: 10, reorderQty: 50, preferredVendorId: vendorId, lastCost: 400 })).id;
    await api('/inventory/movements', { itemId, storeId, moveType: 'in', quantity: 40, unitCost: 400 });
    await api('/inventory/movements', { itemId, storeId, moveType: 'out', quantity: 5 });
    const stock = await api(`/inventory/stock?storeId=${storeId}`);
    assert.equal(Number(stock.find(s => String(s.item_id) === itemId).quantity), 35);
    await assert.rejects(() => api('/inventory/movements', { itemId, storeId, moveType: 'out', quantity: 999 }), /only 35 in stock/);
    const ledger = await app.inventory.movements(schoolId, itemId);
    assert.equal(ledger.length, 2, 'every change is a row nobody edits');
  });

  test('falling below the reorder level drafts a purchase order by itself', async () => {
    await api('/inventory/movements', { itemId, storeId, moveType: 'consume', quantity: 30, note: 'exam printing' });
    await drain();
    const orders = await api('/inventory/purchase-orders');
    const auto = orders.find(o => Number(o.is_auto));
    assert.ok(auto, 'the system raised the order');
    assert.equal(Number(auto.total), 50 * 400);
    poId = String(auto.id);
    assert.ok(await notified('inventory.reorder_drafted') >= 1);
    // it does not keep drafting the same order every time stock moves
    await api('/inventory/movements', { itemId, storeId, moveType: 'consume', quantity: 1 });
    await drain();
    assert.equal((await api('/inventory/purchase-orders')).filter(o => Number(o.is_auto)).length, 1);
  });

  test('receiving the delivery adds stock, posts the expense, and tags any asset', async () => {
    const before = await api(`/inventory/stock?storeId=${storeId}`);
    const beforeQty = Number(before.find(s => String(s.item_id) === itemId).quantity);
    const r = await api(`/inventory/purchase-orders/${poId}/receive`, { items: [{ itemId, quantity: 20 }] });
    assert.equal(r.value, 20 * 400);
    assert.ok(r.expenseId, 'the money side was posted too');
    const after = await api(`/inventory/stock?storeId=${storeId}`);
    assert.equal(Number(after.find(s => String(s.item_id) === itemId).quantity), beforeQty + 20);
    const po = await api(`/inventory/purchase-orders/${poId}`);
    assert.equal(po.po.status, 'partially_received');
    await assert.rejects(() => api(`/inventory/purchase-orders/${poId}/receive`, { items: [{ itemId, quantity: 999 }] }), /still outstanding/);
    await api(`/inventory/purchase-orders/${poId}/receive`, { items: [{ itemId, quantity: 30 }] });
    assert.equal((await api(`/inventory/purchase-orders/${poId}`)).po.status, 'received');
    // an asset category creates one tagged asset per unit received
    const { categories } = await api('/inventory/items');
    const assetCategory = categories.find(c => Number(c.is_asset));
    const chairId = (await api('/inventory/items', { categoryId: String(assetCategory.id), name: 'Classroom chair', unit: 'pcs' })).id;
    const assetPo = await api('/inventory/purchase-orders', { vendorId, storeId, lines: [{ itemId: chairId, quantity: 3, unitCost: 1200 }] });
    const got = await api(`/inventory/purchase-orders/${assetPo.id}/receive`, { items: [{ itemId: chairId, quantity: 3 }] });
    assert.equal(got.assets, 3);
    const assets = await api('/inventory/assets');
    assert.equal(assets.length, 3);
    assert.match(String(assets[0].asset_tag), /^AST-\d{5}$/);
    assert.equal(Number(assets[0].purchase_cost), 1200);
    // the books still balance after all that buying
    const tb = await api(`/accounting/trial-balance?from=2020-01-01&to=2099-12-31`);
    assert.equal(tb.balanced, true, `${tb.totalDebit} vs ${tb.totalCredit}`);
  });

  test('a physical count writes the difference into the ledger', async () => {
    const stock = await api(`/inventory/stock?storeId=${storeId}`);
    const system = Number(stock.find(s => String(s.item_id) === itemId).quantity);
    const r = await api('/inventory/audit', { storeId, counted: [{ itemId, quantity: system - 2 }] });
    assert.equal(r.discrepancies, 1);
    const after = await api(`/inventory/stock?storeId=${storeId}`);
    assert.equal(Number(after.find(s => String(s.item_id) === itemId).quantity), system - 2, 'the shelf now agrees with the count');
    const adjust = (await app.inventory.movements(schoolId, itemId)).find(m => m.move_type === 'adjust');
    assert.ok(adjust, 'and the difference is a movement anyone can see');
  });

  // ---------------- front office ----------------
  test('a visitor gets a badge and the host is told', async () => {
    const v = await api('/frontoffice/visitors', { visitorName: 'Salma Begum', phone: '01912345678', purpose: 'meeting', toMeetStaffId: staffId });
    assert.match(v.badgeNo, /^V-\d{4}$/);
    assert.equal(await told('frontoffice.visitor_waiting'), 1);
    const row = (await api('/frontoffice/visitors'))[0];
    assert.ok(row.host_notified_at);
    await api(`/frontoffice/visitors/${v.id}/out`, {});
    assert.ok((await api('/frontoffice/visitors'))[0].out_at);
  });

  test('a child is only released to somebody the guardians authorised', async () => {
    await assert.rejects(() => api('/frontoffice/gate-passes', { personType: 'student', studentId: students[0].id, reason: 'dentist', pickedBy: 'A stranger', pickerPhone: '01999999999' }), /not authorised/);
    const g = (await app.db.query(`SELECT g.phone FROM guardians g JOIN student_guardians sg ON sg.guardian_id = g.id WHERE sg.student_id = ?`, [students[0].id]))[0];
    const pass = await api('/frontoffice/gate-passes', { personType: 'student', studentId: students[0].id, reason: 'dentist', pickedBy: 'Father', pickerPhone: String(g.phone) });
    assert.ok(pass.qr);
    assert.ok(await notified('frontoffice.gate_pass') >= 1, 'the guardians are told the child left');
    await api(`/frontoffice/gate-passes/${pass.id}/return`, {});
    assert.equal((await api('/frontoffice/gate-passes'))[0].status, 'returned');
  });

  test('a ticket gets a number, an owner and a deadline, and is escalated when it passes', async () => {
    const t = await api('/frontoffice/complaints', { category: 'transport', subject: 'Bus is always late at Kazipara', description: 'Three days running.', priority: 'high' });
    ticketId = t.id;
    assert.match(t.ticketNo, /^TKT-\d{4}-\d{5}$/);
    assert.ok(t.slaDueAt > new Date().toISOString().slice(0, 10));
    assert.equal(await told('frontoffice.complaint_raised'), 1);
    // let the deadline pass
    await app.db.execute(`UPDATE complaints SET sla_due_at = ? WHERE id = ?`, ['2020-01-01 00:00:00', ticketId]);
    const r = await app.frontOffice.jobs()['frontoffice.sla_escalation']({ schoolId, jobKey: 'frontoffice.sla_escalation', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(r.escalated, 1);
    await drain();
    assert.equal(await app.db.count('tasks', { school_id: schoolId, task_type: 'frontoffice.sla' }), 1);
    // it is only escalated once
    assert.equal((await app.frontOffice.jobs()['frontoffice.sla_escalation']({ schoolId, jobKey: 'frontoffice.sla_escalation', payload: {}, deadline: Date.now() + 20_000 })).escalated, 0);
    const resolved = await api(`/frontoffice/complaints/${ticketId}`, { status: 'resolved', resolution: 'Route timing changed.', note: 'Spoke to the driver.' });
    assert.equal(resolved.status, 'resolved');
    const detail = await api(`/frontoffice/complaints/${ticketId}`);
    assert.equal(detail.updates.length, 1);
    assert.ok(await notified('frontoffice.complaint_resolved') >= 1);
  });

  test('a guardian sees their own child’s library, bus and hostel, and nobody else’s', async () => {
    const mine = await api(`/portal/operations/${guardianStudentId}`, undefined, 'GET', { cookie: guardianCookie });
    assert.ok(mine.books.length >= 1);
    assert.equal(mine.transport.length, 1);
    assert.equal(mine.hostel.length, 1);
    assert.ok(mine.outpasses.length >= 2);
    assert.equal((await fetch(`${baseUrl}/api/portal/operations/${students[4].id}`, { headers: { cookie: guardianCookie } })).status, 403);
    // and a guardian never reaches the console side of it
    assert.equal((await fetch(`${baseUrl}/api/inventory/stock`, { headers: { cookie: guardianCookie } })).status, 403);
    const html = await fetch(`${baseUrl}/operations`, { headers: { cookie } });
    assert.equal(html.status, 200);
    assert.ok((await html.text()).includes('Mirpur route'));
  });
});

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const daysAgo = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const daysAhead = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
