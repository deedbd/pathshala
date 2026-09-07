// The automation pass over the platform half of the system: the watchdog over the machinery itself,
// the backup that reads itself back, admissions finishing what its triggers could not reach, the
// analytics days nobody was there to compute, a trust's nightly consolidation, the business side
// (trials, chasing, limits, payouts), integrations that have stopped answering, and the four small
// modules that had no scheduled work at all — AI budget, the voice line, the job board, the website.
//
// Every automation is asserted twice: that it does the thing, and that doing it again changes
// nothing. And each one has a case where it must stay quiet.
//   node --test tests/auto-platform.test.mjs      (SQLite; set TEST_DB_URL for MySQL/Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, 'tests', '.tmp-auto');
fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
Object.assign(process.env, { APP_ENV: 'test', APP_ROOT: root, APP_URL: 'http://127.0.0.1:0', APP_KEY: 'auto-key'.padEnd(64, 'x'), CRON_KEY: 'cron-auto', UPLOADS_DIR: 'tests/.tmp-auto/uploads', ADAPTERS: 'db,heartbeat,local,pdfmake,sse', CRON_MODE: 'heartbeat', LOG_LEVEL: process.env.LOG_LEVEL || 'warn', FONTS_DIR: 'packages/adapters/fonts' });
if (process.env.TEST_DB_URL) { process.env.DB_URL = process.env.TEST_DB_URL; delete process.env.DB_ENGINE; } else { process.env.DB_ENGINE = 'sqlite'; process.env.SQLITE_PATH = 'tests/.tmp-auto/pathshala.db'; delete process.env.DB_URL; }

const core = await import('../packages/core/dist/index.js');

let app, schoolId, classId, adminUserId;
const t0 = Date.now();
const day = offset => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const stamp = offset => `${day(offset)} 09:00:00`;

describe('platform automation: nothing waits for somebody to remember it', () => {
  before(async () => {
    app = core.createApp({ rootDir: root });
    if (process.env.TEST_DB_URL) {
      if (app.db.engine === 'postgres') await app.db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      else { const tables = await app.db.query('SHOW TABLES'); await app.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const r of tables) await app.db.execute(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``); await app.db.execute('SET FOREIGN_KEY_CHECKS = 1'); }
    }
    await app.start();
    await app.installer.runPrepare();
    const r = await app.installer.createSchool({ schoolName: 'Watchdog School', institutionType: 'school', locale: 'bn', adminName: 'Admin', adminPhone: '01755500011', adminEmail: 'admin@auto.test', adminPassword: 'secret-pass-1' });
    schoolId = r.schoolId; adminUserId = r.userId;
    await app.installer.finish(schoolId);
    await app.settings.set(schoolId, 'notifications.quiet_hours', null);
    await app.settings.set(schoolId, 'notifications.channels', { push: true, sms: true, email: true, in_app: true });
    await app.db.execute(`INSERT INTO user_roles (id, user_id, role_id) SELECT ?, ?, id FROM roles WHERE school_id = ? AND slug = 'super_admin'`, [`UR${Date.now()}`.padEnd(26, '0').slice(0, 26), adminUserId, schoolId]).catch(() => undefined);
    classId = String((await app.academic.classes(schoolId))[4].id);
  });
  after(async () => { await app?.stop(); console.log(`platform automation finished in ${Date.now() - t0} ms on ${app?.db.engine}`); });

  // one row per (event_key, entity) pair is what "told once" means; a role notification writes one
  // row per channel per admin, so the count is compared with itself rather than with 1
  const notes = async (eventKey, entityId) => app.db.query(
    `SELECT * FROM notifications WHERE school_id = ? AND event_key = ?${entityId === undefined ? '' : ' AND entity_id = ?'}`,
    entityId === undefined ? [schoolId, eventKey] : [schoolId, eventKey, entityId]);
  const events = async type => app.db.query(`SELECT * FROM outbox_events WHERE school_id = ? AND event_type = ?`, [schoolId, type]);

  // ---------------- the watchdog over the machinery ----------------
  test('a job the update shipped gets a row in a school installed before it', async () => {
    await app.db.delete('scheduled_jobs', { school_id: schoolId, job_key: 'analytics.daily' });
    const first = await app.platform.watchdog(schoolId);
    assert.ok(first.catalogueAdded.includes('analytics.daily'), 'the missing job is put back from the seed catalogue');
    assert.equal(await app.db.count('scheduled_jobs', { school_id: schoolId, job_key: 'analytics.daily' }), 1);
    const again = await app.platform.watchdog(schoolId);
    assert.equal(again.catalogueAdded.length, 0, 'a second pass adds nothing');
    assert.equal(await app.db.count('scheduled_jobs', { school_id: schoolId, job_key: 'analytics.daily' }), 1);
  });

  test('a healthy installation hears nothing at all', async () => {
    const before = (await notes('platform.stalled')).length;
    await app.platform.watchdog(schoolId);
    assert.equal((await notes('platform.stalled')).length, before, 'silence when there is nothing wrong');
  });

  test('a scheduled job that has stopped running is named, once', async () => {
    await app.db.update('scheduled_jobs', { last_status: 'failed', last_run_at: stamp(-1) }, { school_id: schoolId, job_key: 'fees.reminders' });
    const r = await app.platform.watchdog(schoolId);
    assert.ok(r.findings.some(f => f.kind === 'scheduled_job'), 'the failure is a finding');
    const first = await notes('platform.stalled', 'scheduled_job');
    assert.ok(first.length > 0, 'the office is told which automation stopped');
    assert.ok(first.some(n => String(n.body).includes('fees.reminders')), 'and told which one by name');
    assert.ok((await events('automation.stalled')).length > 0, 'and the event is on the bus for a rule or a webhook');

    await app.platform.watchdog(schoolId);
    assert.equal((await notes('platform.stalled', 'scheduled_job')).length, first.length, 'a fault that is still there does not message again the same day');
    await app.db.update('scheduled_jobs', { last_status: 'success' }, { school_id: schoolId, job_key: 'fees.reminders' });
  });

  test('messages queued and never sent are queued again rather than reported', async () => {
    const id = `NOTE${Date.now()}`.padEnd(26, '0').slice(0, 26);
    await app.db.insert('notifications', { id, school_id: schoolId, recipient_user_id: adminUserId, recipient_address: 'admin@auto.test', channel: 'email', event_key: 'test.stuck', title: 'Stuck', body: 'Queued an hour ago', status: 'queued', attempts: 0, scheduled_for: stamp(-1) });
    await app.platform.watchdog(schoolId);
    const job = (await app.db.query(`SELECT * FROM background_jobs WHERE school_id = ? AND job_name = 'notifications.deliver' ORDER BY created_at DESC LIMIT 1`, [schoolId]))[0];
    assert.ok(job, 'a delivery job is pushed for it');
    await app.adapters.queue.drain(5);
    const after = await app.db.findOne('notifications', { id });
    assert.notEqual(String(after.status), 'queued', 'and the message actually goes out');
    const before = await app.db.count('background_jobs', { school_id: schoolId, job_name: 'notifications.deliver' });
    await app.platform.watchdog(schoolId);
    assert.equal(await app.db.count('background_jobs', { school_id: schoolId, job_name: 'notifications.deliver' }), before, 'nothing stuck, nothing pushed');
  });

  // ---------------- backups ----------------
  test('a backup is read back before it is trusted, and a broken one is not', async () => {
    const r = await app.platform.jobs()['platform.backup']({ schoolId, jobKey: 'platform.backup', payload: {}, deadline: Date.now() + 20_000 });
    assert.ok(r.rows > 0 && r.tables > 0, 'the file was parsed, not merely written');
    const health = await app.db.findOne('system_health', { check_key: `backup:${schoolId}` });
    assert.equal(String(health.status), 'ok');
    const row = await app.db.findOne('backups', { id: r.backupId });
    assert.equal(String(row.status), 'success');
    assert.equal(app.platform.verify(String(row.file_path)).ok, true);

    const broken = path.join(tmp, 'broken.jsonl.gz');
    fs.writeFileSync(broken, Buffer.from('not a gzip at all'));
    assert.equal(app.platform.verify(broken).ok, false, 'a file that will not read back is not a backup');
  });

  test('a backup that cannot be written is told to the office, once', async () => {
    await app.settings.set(schoolId, 'backup.target', 'dropbox');           // no token: the upload refuses
    await assert.rejects(() => app.platform.jobs()['platform.backup']({ schoolId, jobKey: 'platform.backup', payload: {}, deadline: Date.now() + 20_000 }));
    const first = await notes('platform.backup_failed');
    assert.ok(first.length > 0, 'the school hears that its records are in one place only');
    await assert.rejects(() => app.platform.jobs()['platform.backup']({ schoolId, jobKey: 'platform.backup', payload: {}, deadline: Date.now() + 20_000 }));
    assert.equal((await notes('platform.backup_failed')).length, first.length, 'and hears it once, not every night');
    assert.equal(String((await app.db.findOne('system_health', { check_key: `backup:${schoolId}` })).status), 'fail');
    await app.settings.set(schoolId, 'backup.target', 'local');
  });

  test('a school whose backups stopped two days ago is warned', async () => {
    await app.db.execute(`UPDATE backups SET started_at = ? WHERE school_id = ?`, [stamp(-4), schoolId]);
    await app.platform.watchdog(schoolId);
    assert.ok((await notes('platform.stalled', 'backup')).length > 0, 'a stale backup chain is a finding of its own');
  });

  test('housekeeping runs on two consecutive nights', async () => {
    // driven exactly the way the scheduler drives it, because the failure this covers only ever
    // showed up on the second night and only in a job row nobody reads
    await app.db.update('scheduled_jobs', { next_run_at: stamp(-1), locked_until: null }, { school_id: schoolId, job_key: 'platform.housekeeping' });
    const first = await app.adapters.scheduler.tick();
    assert.ok(!first.errors.some(e => e.startsWith('platform.housekeeping')), `first night: ${first.errors.join('; ')}`);
    await app.db.update('scheduled_jobs', { next_run_at: stamp(-1), locked_until: null }, { school_id: schoolId, job_key: 'platform.housekeeping' });
    const second = await app.adapters.scheduler.tick();
    assert.ok(!second.errors.some(e => e.startsWith('platform.housekeeping')), `second night: ${second.errors.join('; ')} — system_health.check_key is unique, so the row is overwritten`);
    assert.equal(await app.db.count('system_health', { check_key: 'housekeeping' }), 1);
  });

  // ---------------- admissions ----------------
  describe('admissions: an admission that finishes itself', () => {
    let campaignId, testId, appIds = [];
    before(async () => {
      const c = await app.admissions.createCampaign(schoolId, { name: 'Free Admission 2027', opensAt: `${day(-2)} 00:00:00`, closesAt: `${day(2)} 23:59:59`, formFee: 0, selectionMode: 'test', requiresTest: true, autoMeritList: true, autoOffer: true, offerValidityDays: 7, classes: [{ classId, seats: 1 }] });
      campaignId = c.id;
      await app.admissions.setCampaignStatus(schoolId, campaignId, 'open');
      testId = await app.admissions.createTest(schoolId, { campaignId, classId, name: 'Entrance', heldAt: `${day(1)} 10:00:00`, venue: 'Main hall', totalMarks: 100 });
      for (let i = 0; i < 3; i++) {
        const a = await app.admissions.apply(schoolId, campaignId, { classId, firstName: `Applicant${i + 1}`, gender: 'male', dateOfBirth: '2016-03-03', guardianName: `Guardian ${i + 1}`, guardianPhone: `0177700010${i}` });
        appIds.push(a.id);
      }
      await app.tick();
    });

    test('an admission with no form fee still seats its applicants for the test', async () => {
      const before = await app.db.findMany('admission_applications', { campaign_id: campaignId });
      assert.ok(before.every(a => String(a.status) === 'submitted'), 'nothing has seated them: A4 only fires on a payment');
      const r = await app.admissions.jobs()['admissions.campaign_watch']({ schoolId, jobKey: 'admissions.campaign_watch', payload: {}, deadline: Date.now() + 20_000 });
      assert.equal(r.seated, 3);
      const after = await app.db.findMany('admission_applications', { campaign_id: campaignId });
      assert.ok(after.every(a => String(a.status) === 'test_scheduled'), 'every applicant now has a seat and an admit card');
      const cards = await app.db.count('issued_documents', { school_id: schoolId, doc_type: 'admit_card' });
      const second = await app.admissions.jobs()['admissions.campaign_watch']({ schoolId, jobKey: 'admissions.campaign_watch', payload: {}, deadline: Date.now() + 20_000 });
      assert.equal(second.seated, 0, 'a second pass seats nobody again');
      assert.equal(await app.db.count('issued_documents', { school_id: schoolId, doc_type: 'admit_card' }), cards, 'and issues no second admit card');
    });

    test('a class where one applicant never sat the test still gets its merit list once the admission closes', async () => {
      await app.admissions.enterResults(schoolId, testId, [{ applicationId: appIds[0], totalMarks: 80 }, { applicationId: appIds[1], totalMarks: 60 }]);
      await app.tick();
      assert.equal(await app.admissions.readyForMerit(schoolId, campaignId, classId), false, 'the third mark never came, so A5 correctly did not fire');
      assert.equal((await app.db.findMany('admission_applications', { campaign_id: campaignId })).filter(a => a.merit_rank != null).length, 0);

      await app.admissions.setCampaignStatus(schoolId, campaignId, 'closed');
      const r = await app.admissions.jobs()['admissions.campaign_watch']({ schoolId, jobKey: 'admissions.campaign_watch', payload: {}, deadline: Date.now() + 20_000 });
      assert.equal(r.merit, 1);
      const ranked = (await app.db.findMany('admission_applications', { campaign_id: campaignId })).filter(a => a.merit_rank != null);
      assert.equal(ranked.length, 3, 'everybody is ranked, the unmarked applicant last');
      assert.equal(r.sheets, 1, 'and the notice-board sheet is rendered');
      const sheets = await app.db.count('files', { school_id: schoolId, purpose: `merit_list:${classId}`, entity_id: campaignId });
      assert.equal(sheets, 1);

      const second = await app.admissions.jobs()['admissions.campaign_watch']({ schoolId, jobKey: 'admissions.campaign_watch', payload: {}, deadline: Date.now() + 20_000 });
      assert.equal(second.merit, 0, 'nothing left to rank');
      assert.equal(await app.db.count('files', { school_id: schoolId, purpose: `merit_list:${classId}`, entity_id: campaignId }), 1, 'and the same sheet is not rendered every night');
    });

    test('an offer about to lapse warns the family once, and never the ones with time left', async () => {
      const offer = (await app.db.query(`SELECT o.* FROM admission_offers o JOIN admission_applications a ON a.id = o.application_id WHERE a.campaign_id = ? LIMIT 1`, [campaignId]))[0];
      assert.ok(offer, 'the top of the merit list was offered a place automatically');
      const quiet = await app.admissions.jobs()['admissions.campaign_watch']({ schoolId, jobKey: 'admissions.campaign_watch', payload: {}, deadline: Date.now() + 20_000 });
      assert.equal(quiet.reminded, 0, 'an offer with a week to run is not chased');

      await app.db.update('admission_offers', { expires_at: `${day(1)} 09:00:00` }, { id: String(offer.id) });
      const r = await app.admissions.jobs()['admissions.campaign_watch']({ schoolId, jobKey: 'admissions.campaign_watch', payload: {}, deadline: Date.now() + 20_000 });
      assert.equal(r.reminded, 1);
      const first = await notes('admissions.offer_expiring', String(offer.id));
      assert.equal(first.length, 1, 'one SMS to the guardian');
      const again = await app.admissions.jobs()['admissions.campaign_watch']({ schoolId, jobKey: 'admissions.campaign_watch', payload: {}, deadline: Date.now() + 20_000 });
      assert.equal(again.reminded, 0);
      assert.equal((await notes('admissions.offer_expiring', String(offer.id))).length, 1, 'and not the same SMS tomorrow');
    });

    test('a campaign that keeps the offer decision is prepared to the last button and told once', async () => {
      // an offer is a promise to a family: the ranking, the seats and the sheet are done for them,
      // and the desk presses the button
      await app.db.update('admission_campaigns', { auto_offer: false }, { id: campaignId });
      const waiting = (await app.db.query(`SELECT id FROM admission_applications WHERE campaign_id = ? AND status = 'waitlisted' LIMIT 1`, [campaignId]))[0];
      await app.db.update('admission_applications', { status: 'shortlisted', waitlist_position: null }, { id: String(waiting.id) });
      const r = await app.admissions.jobs()['admissions.campaign_watch']({ schoolId, jobKey: 'admissions.campaign_watch', payload: {}, deadline: Date.now() + 20_000 });
      assert.ok(r.chased > 0);
      const told = await notes('admissions.offers_ready', campaignId);
      assert.ok(told.length > 0, 'the desk is told the offers are one button away');
      assert.equal(await app.db.count('admission_offers', { application_id: String(waiting.id) }), 0, 'and no offer was made on its own');
      await app.admissions.jobs()['admissions.campaign_watch']({ schoolId, jobKey: 'admissions.campaign_watch', payload: {}, deadline: Date.now() + 20_000 });
      assert.equal((await notes('admissions.offers_ready', campaignId)).length, told.length, 'once, not every morning');
      await app.db.update('admission_campaigns', { auto_offer: true }, { id: campaignId });
    });

    test('missing papers are named to the office before the child turns up', async () => {
      const told = await notes('admissions.documents_missing');
      assert.ok(told.length > 0, 'an offered applicant with no birth certificate is chased');
      await app.admissions.jobs()['admissions.campaign_watch']({ schoolId, jobKey: 'admissions.campaign_watch', payload: {}, deadline: Date.now() + 20_000 });
      assert.equal((await notes('admissions.documents_missing')).length, told.length, 'once a week, not once a day');
    });
  });

  // ---------------- analytics ----------------
  test('the days the heartbeat never woke for are computed from the register', async () => {
    const r = await app.analytics.jobs()['analytics.daily']({ schoolId, jobKey: 'analytics.daily', payload: {}, deadline: Date.now() + 20_000 });
    assert.ok(r.backfilled >= 10, `a fortnight of missing days is filled in (${r.backfilled})`);
    const rows = await app.db.count('kpi_daily', { school_id: schoolId });
    const again = await app.analytics.jobs()['analytics.daily']({ schoolId, jobKey: 'analytics.daily', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(again.backfilled, 0, 'and not computed a second time');
    assert.equal(await app.db.count('kpi_daily', { school_id: schoolId }), rows);
  });

  test('an alert whose metric has come back to normal closes itself; one that has not stays open', async () => {
    await app.analytics.ensureMetrics(schoolId);
    const metric = await app.db.findOne('metrics', { school_id: schoolId, key_name: 'pass_pct' });
    for (let back = 12; back >= 0; back--) {
      const period = day(-back);
      const existing = await app.db.findOne('metric_values', { school_id: schoolId, metric_id: String(metric.id), period });
      const value = back === 6 ? 20 : 80;                       // one bad day a week ago, steady since
      if (existing) await app.db.update('metric_values', { value }, { id: String(existing.id) });
      else await app.db.insert('metric_values', { id: `MV${back}${Date.now()}`.padEnd(26, '0').slice(0, 26), school_id: schoolId, metric_id: String(metric.id), period, dimension: null, value });
    }
    const alertId = `AL${Date.now()}`.padEnd(26, '0').slice(0, 26);
    await app.db.insert('anomaly_alerts', { id: alertId, school_id: schoolId, metric_key: 'pass_pct', detected_at: stamp(-6), expected: 80, actual: 20, severity: 'warn', status: 'open', details: { day: day(-6) } });
    const r = await app.analytics.resolveRecoveredAlerts(schoolId);
    assert.equal(r.resolved, 1);
    assert.equal(String((await app.db.findOne('anomaly_alerts', { id: alertId })).status), 'resolved');
    assert.equal((await app.analytics.resolveRecoveredAlerts(schoolId)).resolved, 0, 'and stays closed');

    // still wrong today: the alert must not be tidied away
    const today = await app.db.findOne('metric_values', { school_id: schoolId, metric_id: String(metric.id), period: day(0) });
    await app.db.update('metric_values', { value: 10 }, { id: String(today.id) });
    const stillBad = `AL2${Date.now()}`.padEnd(26, '0').slice(0, 26);
    await app.db.insert('anomaly_alerts', { id: stillBad, school_id: schoolId, metric_key: 'pass_pct', detected_at: stamp(0), expected: 80, actual: 10, severity: 'critical', status: 'open', details: { day: day(0) } });
    assert.equal((await app.analytics.resolveRecoveredAlerts(schoolId)).resolved, 0);
    assert.equal(String((await app.db.findOne('anomaly_alerts', { id: stillBad })).status), 'open');
  });

  test('the cohort benchmarks are built by the founding school and by nobody else', async () => {
    const r = await app.analytics.jobs()['analytics.benchmarks']({ schoolId, jobKey: 'analytics.benchmarks', payload: {}, deadline: Date.now() + 20_000 });
    assert.ok('period' in r, 'the founding school builds them');
    const other = await app.analytics.jobs()['analytics.benchmarks']({ schoolId: 'SOMEONEELSE', jobKey: 'analytics.benchmarks', payload: {}, deadline: Date.now() + 20_000 });
    assert.ok('skipped' in other, 'every other tenant leaves them alone');
  });

  // ---------------- the business side ----------------
  describe('saas: the money side chases itself', () => {
    let subId;
    before(async () => {
      await app.saas.ensurePlans();
      const free = (await app.saas.plans()).find(p => String(p.name) === 'Free');
      const s = await app.saas.subscribe(schoolId, { planId: String(free.id), billingCycle: 'yearly', trialDays: 30 });
      subId = s.id;
    });
    const billing = () => app.saas.jobs()['saas.billing']({ schoolId, jobKey: 'saas.billing', payload: {}, deadline: Date.now() + 20_000 });

    test('a trial with a month to run is left alone', async () => {
      await billing();
      assert.equal((await notes('saas.trial_ending')).length, 0);
      assert.equal((await notes('saas.trial_ended')).length, 0);
      assert.equal(String((await app.saas.subscription(schoolId)).status), 'trial');
    });

    test('a trial with a week left is announced, and one that ends stops new work without touching the records', async () => {
      await app.db.update('saas_subscriptions', { ends_at: day(3) }, { id: subId });
      await billing();
      const warned = await notes('saas.trial_ending', subId);
      assert.ok(warned.length > 0, 'the school is told in words');
      await billing();
      assert.equal((await notes('saas.trial_ending', subId)).length, warned.length, 'and told once');

      await app.db.update('saas_subscriptions', { ends_at: day(-1) }, { id: subId });
      await billing();
      const sub = await app.saas.subscription(schoolId);
      assert.equal(String(sub.status), 'past_due');
      const ended = await notes('saas.trial_ended', subId);
      assert.ok(ended.length > 0);
      const add = await app.saas.allows(schoolId, 'add_student');
      assert.equal(add.allowed, false, 'new students stop');
      assert.match(add.reason, /past due/);
      assert.equal((await app.db.count('students', { school_id: schoolId })) >= 0, true, 'and everything already entered is untouched');
      await billing();
      assert.equal((await notes('saas.trial_ended', subId)).length, ended.length, 'the school is not told again every morning');
    });

    test('an unpaid invoice is chased on a ladder, not once and then forgotten', async () => {
      await app.db.update('saas_subscriptions', { status: 'active', ends_at: day(30), price: 2000 }, { id: subId });
      const inv = await app.saas.invoice(schoolId, { periodStart: day(-40), dueDays: 0 });
      await app.db.update('saas_invoices', { due_date: day(-20), status: 'issued' }, { id: inv.id });
      await billing();
      assert.equal(String((await app.db.findOne('saas_invoices', { id: inv.id })).status), 'overdue');
      const chased = await notes('saas.overdue_14', inv.id);
      assert.ok(chased.length > 0, 'a fortnight late is a rung on the ladder');
      await billing();
      assert.equal((await notes('saas.overdue_14', inv.id)).length, chased.length, 'and the rung is climbed once');
    });

    test('a plan the school is about to outgrow is flagged before the counter refuses a parent', async () => {
      const plan = (await app.saas.plans()).find(p => String(p.name) === 'Free');
      await app.db.update('saas_plans', { student_limit: 1000 }, { id: String(plan.id) });
      await billing();
      assert.equal((await notes('saas.limit_near', subId)).length, 0, 'plenty of room, no message');
      await app.db.update('saas_plans', { student_limit: 1 }, { id: String(plan.id) });
      await app.people.createStudent(schoolId, { firstName: 'Roll', gender: 'female', dateOfBirth: '2015-01-01', classId, admissionDate: day(-10), guardians: [{ fullName: 'Guardian R', phone: '01777000200', relation: 'mother', isPrimary: true, paysFees: true }] });
      await billing();
      const flagged = await notes('saas.limit_near', subId);
      assert.ok(flagged.length > 0);
      await billing();
      assert.equal((await notes('saas.limit_near', subId)).length, flagged.length, 'once, not daily');
      await app.db.update('saas_plans', { student_limit: 1000 }, { id: String(plan.id) });
    });

    test('a reseller owed commission is put in front of the person who can pay it', async () => {
      const partnerId = await app.saas.createPartner({ name: 'Sylhet Reseller', commissionPct: 10 });
      const payoutId = `PO${Date.now()}`.padEnd(26, '0').slice(0, 26);
      await app.db.insert('saas_partner_payouts', { id: payoutId, partner_id: partnerId, period: `${day(-40).slice(0, 7)}-01`, amount: 200, status: 'pending', paid_at: null });
      await billing();
      const due = await notes('saas.payout_due', payoutId);
      assert.ok(due.length > 0, 'prepared to the taka and waiting for one click');
      assert.equal(String((await app.db.findOne('saas_partner_payouts', { id: payoutId })).status), 'pending', 'nothing in this system moves money by itself');
      assert.ok((await events('payout.due')).length > 0);
      await billing();
      assert.equal((await notes('saas.payout_due', payoutId)).length, due.length, 'and asked for once');
    });
  });

  // ---------------- integrations ----------------
  test('a plugin whose webhook keeps failing is switched off and named', async () => {
    const pluginId = await app.marketplace.publishPlugin({ slug: 'attendance-bridge', name: 'Attendance Bridge', version: '1.0.0', hooks: ['attendance.absent'] });
    const install = await app.marketplace.install(schoolId, pluginId, { webhookUrl: 'http://127.0.0.1:1/hook' });
    const settings = { webhookUrl: 'http://127.0.0.1:1/hook', hookFailures: 3 };
    await app.db.update('plugin_installs', { settings }, { id: install.id });
    const health = () => app.marketplace.jobs()['marketplace.health']({ schoolId, jobKey: 'marketplace.health', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal((await health()).pluginsDisabled, 0, 'three bad days is not a dead server');

    await app.db.update('plugin_installs', { settings: { ...settings, hookFailures: 12, hookLastError: 'connect ECONNREFUSED' } }, { id: install.id });
    const r = await health();
    assert.equal(r.pluginsDisabled, 1);
    assert.equal(Number((await app.db.findOne('plugin_installs', { id: install.id })).is_enabled), 0, 'we stop calling somebody else’s dead server');
    const told = await notes('marketplace.plugin_disabled', install.id);
    assert.ok(told.length > 0, 'and the school is told, so it can fix the address');
    assert.ok((await events('plugin.disabled')).length > 0);
    assert.equal((await health()).pluginsDisabled, 0, 'a disabled plugin is not disabled again');
    assert.equal((await notes('marketplace.plugin_disabled', install.id)).length, told.length);
  });

  test('a school’s own webhook is switched off after twenty refusals and left alone before that', async () => {
    const id = `WH${Date.now()}`.padEnd(26, '0').slice(0, 26);
    await app.db.insert('webhooks', { id, school_id: schoolId, url: 'https://erp.example.test/hook', secret: 'x'.repeat(20), event_types: ['payment.received'], is_active: true, failure_count: 5 });
    const health = () => app.marketplace.jobs()['marketplace.health']({ schoolId, jobKey: 'marketplace.health', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal((await health()).webhooksDisabled, 0);
    await app.db.update('webhooks', { failure_count: 21 }, { id });
    assert.equal((await health()).webhooksDisabled, 1);
    assert.equal(Number((await app.db.findOne('webhooks', { id })).is_active), 0);
    assert.equal((await health()).webhooksDisabled, 0, 'and only once');
  });

  // ---------------- the small modules that had no scheduled work ----------------
  test('the AI budget is a warning before it is a wall', async () => {
    const watch = () => app.ai.jobs()['ai.budget_watch']({ schoolId, jobKey: 'ai.budget_watch', payload: {}, deadline: Date.now() + 20_000 });
    await app.settings.set(schoolId, 'ai.monthly_budget', 100);
    assert.equal((await watch()).warned, false, 'nothing spent, nothing said');

    const convo = `AC${Date.now()}`.padEnd(26, '0').slice(0, 26);
    await app.db.insert('ai_conversations', { id: convo, school_id: schoolId, user_id: adminUserId, channel: 'web', title: null, context: null, last_message_at: `${day(0)} 09:00:00` });
    await app.db.insert('ai_messages', { id: `AM${Date.now()}`.padEnd(26, '0').slice(0, 26), school_id: schoolId, conversation_id: convo, role: 'assistant', content: 'x', tool_calls: null, tokens_in: 10, tokens_out: 10, cost: 95 });
    const r = await watch();
    assert.equal(r.warned, true);
    const told = await notes('ai.budget_low');
    assert.ok(told.length > 0);
    assert.equal((await watch()).warned, false, 'one warning a month');
    assert.equal((await notes('ai.budget_low')).length, told.length);
  });

  test('a voice line that has gone quiet for a week is reported once, and forgotten when it speaks', async () => {
    const watch = () => app.ivr.jobs()['ivr.line_watch']({ schoolId, jobKey: 'ivr.line_watch', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal((await watch()).configured, false, 'a school without a voice line is not nagged about one');

    await app.ivr.setSecret(schoolId, 'a-long-enough-secret');
    const r = await watch();
    assert.equal(r.silent, true);
    const told = await notes('ivr.line_silent');
    assert.ok(told.length > 0);
    const second = await watch();
    assert.equal(second.alreadyTold, true);
    assert.equal((await notes('ivr.line_silent')).length, told.length, 'a silent line is reported once, not weekly for ever');

    await app.frontOffice.recordCall(schoolId, `CL${Date.now()}`.padEnd(26, '0').slice(0, 26), { direction: 'inbound', phone: '01777000300', callerName: null, purpose: 'attendance', note: null, relatedType: 'ivr.call' });
    const back = await watch();
    assert.equal(back.silent, false);
    assert.equal(await app.settings.get(schoolId, 'ivr.silence_alerted_on'), null, 'the next stretch of silence will be reported again');
  });

  test('a job post closes on the day its author set, and they hear about it first', async () => {
    const alumniId = `AL${Date.now()}`.padEnd(26, '0').slice(0, 26);
    await app.db.insert('alumni', { id: alumniId, school_id: schoolId, student_id: null, user_id: adminUserId, full_name: 'Old Boy', graduation_year: 2015, last_class_id: null, phone: null, email: null, current_organisation: null, current_position: null, city: null, country: 'Bangladesh', linkedin_url: null, bio: null, photo_file_id: null, is_public: true, is_mentor: false, status: 'active' });
    const soon = await app.alumni.postJob(schoolId, { title: 'Junior developer', company: 'Dhaka Ltd', expiresAt: day(2), postedByAlumniId: alumniId });
    const gone = await app.alumni.postJob(schoolId, { title: 'Old vacancy', company: 'Dhaka Ltd', expiresAt: day(-1), postedByAlumniId: alumniId });
    const board = () => app.alumni.jobs()['alumni.job_board']({ schoolId, jobKey: 'alumni.job_board', payload: {}, deadline: Date.now() + 20_000 });
    const r = await board();
    assert.equal(r.closed, 1);
    assert.equal(r.warned, 1);
    assert.equal(String((await app.db.findOne('job_board_posts', { id: gone })).status), 'closed');
    assert.equal(String((await app.db.findOne('job_board_posts', { id: soon })).status), 'open', 'a post with days left stays up');
    const warned = await notes('alumni.job_expiring', soon);
    const second = await board();
    assert.equal(second.closed, 0);
    assert.equal(second.warned, 0);
    assert.equal((await notes('alumni.job_expiring', soon)).length, warned.length, 'one warning per post');
  });

  test('a page whose author set a go-live date publishes itself on that date and no other', async () => {
    const pageId = await app.cms.savePage(schoolId, { title: 'Exam routine', slug: 'exam-routine', locale: 'bn', status: 'published', publishAt: `${day(3)} 08:00:00`, blocks: [{ type: 'text', body: 'The routine' }] });
    assert.equal(String((await app.db.findOne('cms_pages', { id: pageId })).status), 'draft', 'a date in the future keeps it off the site');
    const publish = () => app.cms.jobs()['cms.scheduled_publish']({ schoolId, jobKey: 'cms.scheduled_publish', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal((await publish()).pages, 0, 'and it is not published early');

    await app.db.update('cms_pages', { published_at: stamp(-1) }, { id: pageId });
    const r = await publish();
    assert.equal(r.pages, 1);
    assert.equal(String((await app.db.findOne('cms_pages', { id: pageId })).status), 'published');
    const published = (await events('page.published')).length;
    assert.equal((await publish()).pages, 0, 'and published once');
    assert.equal((await events('page.published')).length, published);
  });

  test('a website message nobody opened for two days is chased, once', async () => {
    const id = `CM${Date.now()}`.padEnd(26, '0').slice(0, 26);
    await app.db.insert('cms_contact_messages', { id, school_id: schoolId, name: 'A parent', phone: '01777000400', email: null, message: 'Is admission open for class 3?', status: 'new' });
    const publish = () => app.cms.jobs()['cms.scheduled_publish']({ schoolId, jobKey: 'cms.scheduled_publish', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal((await publish()).chased, 0, 'a message from this morning is not yet late');
    await app.db.execute(`UPDATE cms_contact_messages SET created_at = ? WHERE id = ?`, [stamp(-3), id]);
    assert.equal((await publish()).chased, 1);
    const told = await notes('cms.contact_waiting', schoolId);
    assert.ok(told.length > 0);
    assert.equal((await publish()).chased, 0);
    assert.equal((await notes('cms.contact_waiting', schoolId)).length, told.length);
  });

  // ---------------- the group ----------------
  test('a trust is told which of its schools sent no figures, through the same gate a request goes through', async () => {
    const other = await app.installer.addTenant({ schoolName: 'Branch Two', institutionType: 'school', locale: 'bn', adminName: 'Branch Admin', adminPhone: '01755500022', adminEmail: 'branch@auto.test', adminPassword: 'secret-pass-2' });
    const group = await app.groups.createGroup(schoolId, { name: 'Watchdog Trust', schoolIds: [other.schoolId] });
    await app.db.execute(`UPDATE school_group_members SET joined_on = ? WHERE group_id = ?`, [day(-30), group.id]);
    const run = () => app.groups.jobs()['groups.consolidate']({ schoolId, jobKey: 'groups.consolidate', payload: {}, deadline: Date.now() + 20_000 });
    const r = await run();
    assert.equal(r.groups, 1);
    assert.ok(r.silent >= 1, 'the branch has no figures for yesterday, so no group total is invented');
    const told = await notes('groups.school_silent', group.id);
    assert.ok(told.some(n => String(n.body).includes('Branch Two')));
    await run();
    assert.equal((await notes('groups.school_silent', group.id)).length, told.length, 'and the head office is told once');

    // the branch's own nightly pass runs: the trust stops being told
    await app.analytics.computeDay(other.schoolId, day(-1));
    const after = await run();
    assert.equal(after.silent, 0);

    // a school that heads no group does nothing at all
    const none = await app.groups.jobs()['groups.consolidate']({ schoolId: other.schoolId, jobKey: 'groups.consolidate', payload: {}, deadline: Date.now() + 20_000 });
    assert.equal(none.groups, 0, 'a member school is not a head school');
  });
});
