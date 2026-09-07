// Years 4 and 5: the three questions about next term that every other report in the system answers
// backwards. What the fees will bill and what this school — on its own collection record, not a rule
// of thumb — is likely to actually collect against payroll and the ordinary bills; which subjects
// will have periods with nobody to teach them once the leavers on record have gone; and which pupils
// the wellbeing signals say somebody should sit down with, without ever saying what is in a
// counselling note.
//   node --test tests/forecast.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-forecast');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'fcast-key'.padEnd(64, 'x'), CRON_KEY: 'cron-forecast', UPLOADS_DIR: 'tests/.tmp-forecast/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-forecast/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');
const serverMod = await import('../apps/server/dist/index.js');

let app, schoolId, yearId, classId, sectionId, classSubjectId, subjectName, http, baseUrl, cookie;
let leavingTeacher, stayingTeacher, versionId;
const students = [];
const t0 = Date.now();
const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);
const addMonths = (month, delta) => { const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)); const t = y * 12 + (m - 1) + delta; return `${String(Math.floor(t / 12)).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}`; };
const lastDayOf = month => `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;

describe('years 4 & 5: fee forecasting, cash flow, staffing and the wellbeing early warning', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Forecast Model School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01799999999', adminEmail: 'admin@forecast.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    yearId = String((await app.academic.currentYear(schoolId)).id);
    const classes = await app.academic.classes(schoolId);
    classId = String(classes[6].id);
    sectionId = String((await app.academic.sections(schoolId, yearId, classId))[0].id);
    const cs = await app.academic.classSubjects(schoolId, yearId, classId);
    classSubjectId = String(cs[0].id);
    subjectName = String((await app.db.query(`SELECT sub.name FROM class_subjects c JOIN subjects sub ON sub.id = c.subject_id WHERE c.id = ?`, [classSubjectId]))[0].name);
    for (let i = 0; i < 6; i++) students.push(await app.people.createStudent(schoolId, { firstName: `Pupil${i + 1}`, gender: i % 2 ? 'female' : 'male', dateOfBirth: '2012-03-03', classId, sectionId, admissionDate: '2021-01-05', guardians: [{ fullName: `Guardian ${i + 1}`, phone: `0194100000${i}`, relation: 'father', isPrimary: true, paysFees: true }] }));
    leavingTeacher = await app.people.createStaff(schoolId, { firstName: 'Kamrul', lastName: 'Hasan', phone: '01911550001', staffCategory: 'teaching', joinDate: '2020-01-01', gender: 'male' });
    stayingTeacher = await app.people.createStaff(schoolId, { firstName: 'Sabina', lastName: 'Yeasmin', phone: '01911550002', staffCategory: 'teaching', joinDate: '2020-01-01', gender: 'female' });
    const { server } = await serverMod.createServer(app);
    await new Promise(res => { http = server.listen(0, '127.0.0.1', res); });
    serverMod.tuneKeepAlive(http);
    baseUrl = `http://127.0.0.1:${http.address().port}`;
    cookie = (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin@forecast.test', password: 'secret-pass-1' }) })).headers.get('set-cookie').split(';')[0];
  });
  after(async () => { http?.close(); await app?.stop(); console.log(`forecast finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  const api = async (p, body, method = body ? 'POST' : 'GET') => { const r = await fetch(`${baseUrl}/api${p}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { throw new Error(`${method} ${p} → ${r.status} non-JSON: ${text.slice(0, 200)}`); } if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`); return j; };
  const notified = async key => Number((await app.db.query(`SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND event_key = ?`, [schoolId, key]))[0].n);

  // ------------------------------------------------------------------ money ----
  test('with no billing history the forecast says so rather than inventing a collection rate', async () => {
    const f = await api('/forecast/cash-flow');
    assert.equal(f.assumptions.collectionRate, null, 'no rate, not a made-up one');
    assert.equal(f.months.length, 3, 'three months by default');
    assert.ok(f.disclaimer.includes('not a promise'));
    assert.ok(f.blindSpots.some(b => /no collection rate to project with/.test(b)), JSON.stringify(f.blindSpots));
    assert.ok(f.blindSpots.some(b => /short record, not a habit/.test(b)));
    assert.ok(f.blindSpots.some(b => /no payroll run has been approved/.test(b) || /payroll is estimated from basic pay/.test(b)));
    assert.ok(f.blindSpots.some(b => /grants and MPO/.test(b)), 'it names the money it cannot see');
    // every month is still projected, so a head teacher sees the billing even before any is collected
    assert.ok(f.months.every(m => m.billing.recurring > 0), 'the seeded fee structures bill every month');
    assert.equal(f.months[0].inflow.fromBilling, 0, 'nothing is claimed as collectable without a rate');
  });

  test('the collection rate is this school’s own, worked out only from bills that have fallen due', async () => {
    // four months of tuition billed, and this school collects three quarters of it
    const head = (await api('/fees/overview')).heads[0];
    let billed = 0, paid = 0;
    for (let back = 4; back >= 1; back--) {
      const month = addMonths(thisMonth(), -back);
      for (const [i, s] of students.entries()) {
        const inv = await app.fees.createInvoice(schoolId, { studentId: s.id, academicYearId: yearId, issueDate: `${month}-01`, items: [{ feeHeadId: String(head.id), description: `Tuition ${month}`, amount: 1000 }] });
        billed += 1000;
        if (i < 4) { await app.fees.recordPayment(schoolId, { studentId: s.id, amount: 1000, method: 'cash', invoiceIds: [inv.id], paidAt: `${month}-12 10:00:00` }); paid += 1000; }
      }
    }
    // and one bill raised today, due next month, that nobody could possibly have paid yet
    await app.fees.createInvoice(schoolId, { studentId: students[0].id, academicYearId: yearId, issueDate: day(0), billingPeriod: `${addMonths(thisMonth(), 1)}-01`, items: [{ feeHeadId: String(head.id), description: 'Tuition next month', amount: 5000 }] });

    const f = await api('/forecast/cash-flow?historyMonths=6');
    assert.equal(f.assumptions.collectionRate, Math.round((paid / billed) * 10000) / 100, 'the school’s own figure, not a guess');
    assert.equal(f.assumptions.collectionRate, 66.67);
    assert.ok(!f.assumptions.collectionRateFrom.includes('5000'), 'a bill raised today has not had its chance and is left out');
    assert.match(f.assumptions.collectionRateFrom, /Tk \d+ paid against Tk \d+ billed and already due, over 6 months/);
    assert.equal(f.assumptions.historyMonthsWithBilling, 4);
    assert.ok(f.openingCash > 0, 'opening cash comes from the posted journal lines the payments wrote');
    assert.equal(f.openingCash, paid);
    assert.ok(f.openingReceivable > 0, 'the unpaid bills are on the books');

    // the projected inflow is billing × that rate, not billing
    const m = f.months[0];
    assert.equal(m.inflow.fromBilling, Math.round(m.billing.total * (f.assumptions.collectionRate / 100) * 100) / 100);
    assert.ok(m.inflow.fromBilling < m.billing.total, 'a forecast that assumes everyone pays is a wish');
    assert.ok(m.inflow.fromArrears > 0, 'and the arrears already on the books are worth something too');
  });

  test('an agreed instalment lands in the month it falls due, and only once', async () => {
    const head = (await api('/fees/overview')).heads.find(h => String(h.name).toLowerCase().includes('exam')) ?? (await api('/fees/overview')).heads[1];
    const nextMonth = addMonths(thisMonth(), 1);
    const plan = await api('/fees/instalments', { studentId: students[1].id, feeHeadId: String(head.id), totalAmount: 9000, instalments: [
      { due: `${nextMonth}-05`, amount: 3000 },
      { due: `${addMonths(thisMonth(), 2)}-05`, amount: 3000 },
      { due: `${addMonths(thisMonth(), 3)}-05`, amount: 3000 },
    ] });
    assert.equal(plan.instalments.length, 3);
    const f = await api('/forecast/cash-flow');
    assert.equal(f.assumptions.unbilledInstalments, 3);
    assert.equal(f.months[0].billing.instalments, 3000);
    assert.equal(f.months[1].billing.instalments, 3000);
    assert.equal(f.months[2].billing.instalments, 3000);
    // once the instalment becomes a real invoice it stops being a projection and becomes a receivable
    await api(`/fees/instalments/run?date=${nextMonth}-06`, {});
    const after = await api('/forecast/cash-flow');
    assert.equal(after.assumptions.unbilledInstalments, 2, 'a billed instalment is counted in arrears, never in both places');
    assert.equal(after.months[0].billing.instalments, 0);
  });

  test('payroll and expenses come out, and the forecast says which figure it used for each', async () => {
    const before = await api('/forecast/cash-flow');
    assert.match(String(before.assumptions.payrollBasis), /no payroll run has been approved/);

    // two approved payroll runs and a couple of months of bills give it real figures to work from
    for (const back of [2, 1]) {
      const month = addMonths(thisMonth(), -back);
      await app.db.insert('payroll_runs', { id: `PR${String(back).padStart(24, '0')}`, school_id: schoolId, period_month: `${month}-01`, campus_id: null, status: 'approved', staff_count: 2, total_gross: 60000, total_deductions: 5000, total_net: back === 1 ? 55000 : 45000, total_mpo: 0, created_by: null });
      const category = (await app.db.findMany('expense_categories', { school_id: schoolId }, { limit: 1 }))[0];
      await app.accounting.createExpense(schoolId, { categoryId: String(category.id), expenseDate: `${month}-15`, amount: 8000, description: 'Electricity and water' });
      const expenses = await app.accounting.expenses(schoolId, { from: `${month}-01`, to: lastDayOf(month) });
      for (const e of expenses) if (e.status === 'pending') await app.db.update('expenses', { status: 'approved' }, { id: String(e.id) });
    }

    const f = await api('/forecast/cash-flow');
    assert.match(String(f.assumptions.payrollBasis), /median net pay of 2 approved payroll run/);
    assert.equal(f.assumptions.payrollPerMonth, 50000, 'the median of 45,000 and 55,000 — one generous month does not set the budget');
    assert.equal(f.assumptions.otherExpensesPerMonth, 0, 'the median across six months, most of which had no bills at all');
    assert.equal(f.months[0].outflow.payroll, 50000);
    assert.equal(f.months[0].outflow.total, f.months[0].outflow.payroll + f.months[0].outflow.otherExpenses);
    assert.equal(f.months[0].net, Math.round((f.months[0].inflow.total - f.months[0].outflow.total) * 100) / 100);
    // the running balance is genuinely running: each month closes on the last one
    assert.equal(f.months[1].closingCash, Math.round((f.months[0].closingCash + f.months[1].net) * 100) / 100);
    assert.ok(f.shortfallMonths.length >= 1, 'a payroll of 50,000 against this billing runs the school dry, and it says so');
    assert.equal(f.worstMonth.month, f.months[f.months.length - 1].month);
    assert.equal(f.history.length, 6);
  });

  test('the horizon is bounded, and every projection still carries its working', async () => {
    const six = await api('/forecast/cash-flow?months=6&historyMonths=12');
    assert.equal(six.months.length, 6);
    assert.equal(six.horizonMonths, 6);
    assert.equal(six.from, addMonths(thisMonth(), 1), 'it starts next month: this month is half billed already');
    assert.equal(six.to, addMonths(thisMonth(), 6));
    for (const key of ['collectionRate', 'arrearsRecoveryRate', 'discountRate', 'payrollBasis', 'openingCashBasis', 'studentsOnRoll']) {
      assert.ok(key in six.assumptions, `${key} missing from the assumptions`);
    }
    // two of the blind spots are unconditional: they are things the data can never show, not gaps in it
    assert.ok(six.blindSpots.some(b => /roll is held at today/.test(b)), JSON.stringify(six.blindSpots));
    assert.ok(six.blindSpots.some(b => /grants and MPO/.test(b)));
    await assert.rejects(() => api('/forecast/cash-flow?months=24'), /400|Invalid/, 'a twelve-month projection from this data would be fiction');
  });

  // --------------------------------------------------------------- staffing ----
  test('the staffing forecast refuses to speak without a published timetable', async () => {
    const s = await api('/forecast/staffing');
    assert.equal(s.timetable, null);
    assert.equal(s.subjects.length, 0);
    assert.equal(s.totals.uncoveredPeriods, 0);
    assert.ok(s.blindSpots.some(b => /no timetable is published/.test(b)), JSON.stringify(s.blindSpots));
  });

  test('it counts the periods nobody is timetabled to teach, by subject, and names who is going', async () => {
    const periods = (await app.academic.periods(schoolId)).filter(p => !Number(p.is_break)).slice(0, 4);
    assert.ok(periods.length >= 4, 'the installer seeds enough periods to build a week from');
    versionId = await app.timetable.createVersion(schoolId, yearId, 'Forecast grid', day(0));
    // Sunday–Wednesday, one subject: two periods the leaver holds, one a stayer holds, one nobody holds
    const plan = [[0, 0, leavingTeacher.id], [1, 1, leavingTeacher.id], [2, 2, stayingTeacher.id], [3, 3, null]];
    for (const [dayOfWeek, periodIdx, teacherId] of plan) {
      await app.timetable.setSlot(schoolId, versionId, { sectionId, dayOfWeek, periodId: String(periods[periodIdx].id), classSubjectId, teacherId });
    }
    await app.timetable.publish(schoolId, versionId);

    // one of the two is leaving at the end of next month, on the record
    await app.hr.initiateExit(schoolId, { staffId: leavingTeacher.id, exitType: 'resignation', noticeDate: day(0), lastWorkingDay: day(45) });

    const s = await api('/forecast/staffing');
    assert.equal(s.timetable, 'Forecast grid');
    const subject = s.subjects.find(x => x.subject === subjectName);
    assert.ok(subject, JSON.stringify(s.subjects.map(x => x.subject)));
    assert.equal(subject.periodsPerWeek, 4);
    assert.equal(subject.uncoveredPeriods, 3, 'two the leaver holds plus the one nobody holds');
    assert.deepEqual(subject.reasons, { unstaffed: 1, leaving: 2 });
    assert.equal(subject.teachersRemaining, 1);
    assert.deepEqual(subject.leavers, ['Kamrul Hasan'], 'it says who, so somebody can go and ask them');
    assert.equal(s.leavers.length, 1);
    assert.equal(s.leavers[0].reason, 'resignation');
    assert.equal(s.totals.uncoveredPeriods, 3);
    // the one teacher left has plenty of the assumed 30-period week spare, so nobody needs hiring yet
    assert.equal(subject.sparePeriods, 29);
    assert.equal(subject.shortfallPeriods, 0);
    assert.equal(subject.teachersNeeded, 0);
    assert.equal(s.assumptions.maxPeriodsPerWeek, 30);
    assert.ok(s.blindSpots.some(b => /inferred from who already teaches it/.test(b)), 'it does not pretend to know anybody’s qualifications');
  });

  test('tighten the assumed week and the same grid needs a teacher — and it says which assumption moved', async () => {
    const s = await api('/forecast/staffing?maxPeriodsPerWeek=6');
    const subject = s.subjects.find(x => x.subject === subjectName);
    assert.equal(s.assumptions.maxPeriodsPerWeek, 6);
    assert.equal(subject.sparePeriods, 5, 'the remaining teacher already holds one of their six');
    assert.equal(subject.shortfallPeriods, 0);
    const tighter = await api('/forecast/staffing?maxPeriodsPerWeek=6&horizonDays=30');
    const later = tighter.subjects.find(x => x.subject === subjectName);
    assert.equal(later.uncoveredPeriods, 1, 'inside 30 days the leaver is still here — only the empty slot is uncovered');
    assert.equal(tighter.leavers.length, 0);
    assert.match(String(tighter.assumptions.horizon), /^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
    assert.ok(tighter.blindSpots.some(b => /a resignation that has only been spoken about/.test(b)));
  });

  test('a section over its capacity is reported as a staffing problem, not a furniture one', async () => {
    await app.db.execute(`UPDATE sections SET capacity = ? WHERE id = ?`, [3, sectionId]);
    const s = await api('/forecast/staffing');
    assert.equal(s.oversizedSections.length, 1);
    assert.equal(s.oversizedSections[0].enrolled, students.length);
    assert.equal(s.oversizedSections[0].capacity, 3);
    await app.db.execute(`UPDATE sections SET capacity = ? WHERE id = ?`, [60, sectionId]);
    assert.equal((await api('/forecast/staffing')).oversizedSections.length, 0);
  });

  // -------------------------------------------------------------- wellbeing ----
  test('counselling alone never puts a child on the watchlist', async () => {
    // a pupil who attends, behaves and is doing fine — and happens to be seeing the counsellor
    const settled = students[0];
    for (let i = 1; i <= 20; i++) await app.attendance.mark(schoolId, settled.id, day(-i), 'present', { notify: false });
    await api('/welfare/counselling', { studentId: settled.id, counsellorId: stayingTeacher.id, referralSource: 'self', notes: 'Family matter discussed in confidence.' });

    const r = await api('/forecast/wellbeing/compute', {});
    assert.equal(r.students, students.length);
    const list = await api('/forecast/wellbeing?minScore=1');
    assert.ok(!list.students.some(s => String(s.student_id) === settled.id), 'a pupil in counselling with nothing measurably wrong is not on any list');
    assert.equal((await app.db.count('risk_scores', { school_id: schoolId, student_id: settled.id, risk_type: 'wellbeing' })), 0);
    assert.ok(r.blindSpots.some(b => /never scores on its own/.test(b)), JSON.stringify(r.blindSpots));
  });

  test('attendance, behaviour and results build a score that says why — and welfare only adds weight', async () => {
    const struggling = students[2], comparable = students[3];
    for (const s of [struggling, comparable]) for (let i = 1; i <= 20; i++) await app.attendance.mark(schoolId, s.id, day(-i), i % 4 === 0 ? 'present' : 'absent', { notify: false });
    const category = (await api('/welfare/behaviour')).categories.find(c => String(c.polarity) === 'negative' && Number(c.default_points) <= -5);
    for (const s of [struggling, comparable]) for (let i = 0; i < 2; i++) await api('/welfare/incidents', { studentId: s.id, categoryId: String(category.id), description: 'Disrupted the lesson repeatedly.', reportedBy: stayingTeacher.id });
    // the two pupils are identical except that welfare is already working with one of them
    await api('/welfare/counselling', { studentId: struggling.id, counsellorId: stayingTeacher.id, referralSource: 'teacher', notes: 'Ongoing support.' });

    const r = await api('/forecast/wellbeing/compute', {});
    assert.ok(r.flagged >= 1, JSON.stringify(r));
    const list = await api('/forecast/wellbeing?minScore=1');
    const a = list.students.find(s => String(s.student_id) === struggling.id);
    const b = list.students.find(s => String(s.student_id) === comparable.id);
    assert.ok(a && b, JSON.stringify(list.students.map(s => s.student_id)));
    assert.equal(Number(a.score) - Number(b.score), 20, 'welfare involvement is worth a fixed 20 on top of something measurable');
    assert.equal(a.factors.confidential, true);
    assert.equal(b.factors.confidential, false);

    // the reasons a class teacher can act on are there…
    const why = a.factors.why.join(' | ');
    assert.match(why, /present [\d.]+% of \d+ days/);
    assert.match(why, /behaviour incidents? in \d+ days/);
    // …and nothing about what is in the welfare record is, anywhere in the row
    const row = JSON.stringify(a);
    for (const leak of ['counselling', 'safeguarding', 'Ongoing support', 'sessions', 'abuse', 'neglect']) {
      assert.ok(!row.toLowerCase().includes(leak.toLowerCase()), `the watchlist row leaks "${leak}"`);
    }
    assert.match(a.factors.note, /speak to the welfare lead/);
    assert.equal(b.factors.note, null, 'a pupil welfare is not involved with carries no such note');
    assert.equal(a.factors.signals.behaviourPoints, Number(category.default_points) * 2);

    assert.ok(await notified('forecast.wellbeing') >= 1, 'somebody is told');
    const message = (await app.db.query(`SELECT title, body FROM notifications WHERE school_id = ? AND event_key = ? ORDER BY created_at DESC`, [schoolId, 'forecast.wellbeing']))[0];
    assert.match(String(message.body), /deliberately does not/, 'the alert says a concern exists and nothing else');
    for (const leak of ['counselling', 'absent', 'behaviour', 'incident']) assert.ok(!String(message.body).toLowerCase().includes(leak), `the alert leaks "${leak}"`);
  });

  test('an open safeguarding case adds the same weight as counselling and reads the same from outside', async () => {
    const comparable = students[3];
    await api('/welfare/safeguarding', { studentId: comparable.id, category: 'neglect', details: 'Confidential account of the concern.', riskLevel: 'high' });
    await api('/forecast/wellbeing/compute', {});
    const list = await api('/forecast/wellbeing?minScore=1');
    const a = list.students.find(s => String(s.student_id) === students[2].id);
    const b = list.students.find(s => String(s.student_id) === comparable.id);
    assert.equal(Number(a.score), Number(b.score), 'a safeguarding case and a counselling session weigh the same, so the score cannot be read backwards to tell them apart');
    assert.equal(b.factors.confidential, true);
    assert.ok(!JSON.stringify(b).toLowerCase().includes('neglect'), 'the category never leaves the welfare module');
  });

  test('the score is refreshed, not piled up, and a warning is given once', async () => {
    const before = await notified('forecast.wellbeing');
    const again = await api('/forecast/wellbeing/compute', {});
    assert.equal(await notified('forecast.wellbeing'), before, 'a warning repeated weekly becomes wallpaper');
    assert.equal(again.flagged, 0);
    const rows = await app.db.findMany('risk_scores', { school_id: schoolId, student_id: students[2].id, risk_type: 'wellbeing' });
    assert.equal(rows.length, 1, 'one row per pupil per risk, updated in place');
    // and a pupil who comes good drops off the list entirely rather than lingering on it
    await app.db.execute(`UPDATE student_attendance SET status = 'present' WHERE school_id = ? AND student_id = ?`, [schoolId, students[3].id]);
    await app.db.execute(`DELETE FROM behaviour_incidents WHERE school_id = ? AND student_id = ?`, [schoolId, students[3].id]);
    const cleared = await api('/forecast/wellbeing/compute', {});
    assert.ok(cleared.cleared >= 1, JSON.stringify(cleared));
    assert.equal(await app.db.count('risk_scores', { school_id: schoolId, student_id: students[3].id, risk_type: 'wellbeing' }), 0, 'a stale score is read as a current one');
  });

  test('the analytics risk scores and the wellbeing score live in the same table without disturbing each other', async () => {
    await api('/analytics/risks/compute', {});
    const types = (await api(`/analytics/risks?studentId=${students[2].id}`)).map(r => String(r.risk_type)).sort();
    assert.ok(types.includes('wellbeing'), JSON.stringify(types));
    assert.ok(types.includes('attendance'), 'the year-2 scores are untouched by the year-4 pass');
    assert.equal(new Set(types).size, types.length, 'no duplicated risk types');
  });

  // ------------------------------------------------------------- scheduled ----
  test('the monthly pass reports and never acts', async () => {
    const invoicesBefore = await app.db.count('invoices', { school_id: schoolId });
    const jobs = app.forecast.jobs();
    const out = await jobs['forecast.monthly']({ schoolId, jobKey: 'forecast.monthly', payload: {}, deadline: Date.now() + 30_000 });
    assert.equal(out.months, 3);
    assert.ok(out.shortfallMonths >= 1);
    assert.equal(out.uncoveredPeriods, 3);
    assert.equal(await app.db.count('invoices', { school_id: schoolId }), invoicesBefore, 'a projected shortfall raises a message, never an invoice');
    assert.ok(await notified('forecast.cash_shortfall') >= 1);
    assert.ok(await notified('forecast.staffing_gap') >= 1);
    const events = await app.db.query(`SELECT event_type FROM outbox_events WHERE school_id = ? AND event_type LIKE 'forecast.%'`, [schoolId]);
    const kinds = new Set(events.map(e => String(e.event_type)));
    assert.ok(kinds.has('forecast.cash_projected'), JSON.stringify([...kinds]));
    assert.ok(kinds.has('forecast.staffing_gap'));
  });

  test('the seeded cron rows carry both forecast jobs', async () => {
    const rows = await app.db.query(`SELECT job_key, cron_expr FROM scheduled_jobs WHERE school_id = ? AND job_key LIKE 'forecast.%' ORDER BY job_key`, [schoolId]);
    assert.deepEqual(rows.map(r => String(r.job_key)), ['forecast.monthly', 'forecast.wellbeing']);
    assert.ok(rows.every(r => String(r.cron_expr).split(' ').length === 5));
  });
});
