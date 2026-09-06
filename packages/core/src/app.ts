import path from 'node:path';
import { connect, dbConfigFromEnv, nowSql, type Db } from '@pathshala/db';
import { createAdapters, type Adapters, type Logger, type SchedulerMode } from '@pathshala/adapters';
import { loadConfig, type AppConfig } from './config.js';
import { createLogger } from './logger.js';
import { AuditService } from './audit.js';
import { SettingsService } from './settings.js';
import { RbacService } from './rbac.js';
import { FileService } from './files.js';
import { CustomFieldService } from './customFields.js';
import { TaskService } from './tasks.js';
import { ApprovalService } from './approvals.js';
import { NotificationService } from './notifications.js';
import { AuthService } from './auth/service.js';
import { InstallerService } from './installer.js';
import { OutboxService } from './automation/outbox.js';
import { HandlerRegistry } from './automation/handlers.js';
import { RuleEngine } from './automation/rules.js';
import { Relay } from './automation/relay.js';
import { registerPlatformJobs } from './automation/jobs.js';
import { NumberingService } from './modules/numbering.js';
import { AcademicService } from './modules/academic.js';
import { PeopleService } from './modules/people.js';
import { ImportService } from './modules/importer.js';
import { TimetableService } from './modules/timetable.js';
import { CurriculumService } from './modules/curriculum.js';
import { CmsService } from './modules/cms.js';
import { PortalService } from './modules/portal.js';
import { AttendanceService } from './modules/attendance.js';
import { CommunicationService } from './modules/communication.js';
import { AccountingService } from './modules/accounting.js';
import { FeesService } from './modules/fees.js';
import { AssessmentService } from './modules/assessment.js';
import { HrService } from './modules/hr.js';
import { DocumentService } from './modules/documents.js';
import { AdmissionsService } from './modules/admissions.js';

export interface App {
  config: AppConfig; db: Db; log: Logger; adapters: Adapters & { mode: SchedulerMode };
  audit: AuditService; settings: SettingsService; rbac: RbacService; files: FileService; customFields: CustomFieldService;
  tasks: TaskService; approvals: ApprovalService; notifications: NotificationService; auth: AuthService; installer: InstallerService;
  outbox: OutboxService; handlers: HandlerRegistry; rules: RuleEngine; relay: Relay;
  numbering: NumberingService; academic: AcademicService; people: PeopleService; importer: ImportService; timetable: TimetableService; curriculum: CurriculumService; cms: CmsService; portal: PortalService;
  attendance: AttendanceService; communication: CommunicationService; accounting: AccountingService; fees: FeesService; assessment: AssessmentService; hr: HrService; documents: DocumentService; admissions: AdmissionsService;
  /** Boots background loops (relay, queue, scheduler) according to the adapter mode. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Request heartbeat: throttled scheduler tick + relay + queue drain (WordPress-cron pattern). */
  heartbeat(): void;
  /** Full tick for /cron/tick and tests. */
  tick(): Promise<{ scheduler: Awaited<ReturnType<Adapters['scheduler']['tick']>>; relay: { published: number; failed: number }; queue: { ran: number; failed: number } }>;
}

export interface CreateAppOptions { rootDir?: string; db?: Db; log?: Logger; env?: NodeJS.ProcessEnv }

export function createApp(opts: CreateAppOptions = {}): App {
  const config = loadConfig(opts.rootDir);
  const log = opts.log ?? createLogger(path.join(config.uploadsDir, 'logs'), (config.env.LOG_LEVEL as 'debug') || 'info');
  const db = opts.db ?? connect(dbConfigFromEnv(config.env, config.rootDir));

  let relay: Relay;
  const outbox = new OutboxService(db, () => relay?.nudge());
  const audit = new AuditService(db);
  const settings = new SettingsService(db, outbox);
  const rbac = new RbacService(db);
  const tasks = new TaskService(db, outbox);
  const approvals = new ApprovalService(db, outbox);
  const handlers = new HandlerRegistry();

  const adapters = createAdapters(config.env, {
    db, rootDir: config.rootDir, log,
    afterTick: async () => { await relay.run(); await adapters.queue.drain(); },
    onJobFailed: async (job, err) => { await outbox.emitNow({ type: 'job.failed', schoolId: job.schoolId, aggregateType: 'platform.job', aggregateId: job.id, payload: { jobId: job.id, jobName: job.name, attempts: job.attempts, error: err.message.slice(0, 500) } }); },
  });
  const notifications = new NotificationService(db, adapters, settings, outbox, log);
  const files = new FileService(db, adapters.storage, outbox);
  const customFields = new CustomFieldService(db);
  const rules = new RuleEngine(db, adapters, { notifications, tasks, approvals, outbox, log, appKey: config.appKey });
  relay = new Relay(db, handlers, rules, log, config.appKey);
  const auth = new AuthService(db, { audit, outbox, notifications, rbac, log, appKey: config.appKey, sessionDays: config.sessionDays });

  // phase 1 modules
  const numbering = new NumberingService(db);
  const academic = new AcademicService(db, outbox, settings);
  const people = new PeopleService(db, outbox, numbering, auth);
  const importer = new ImportService(db, adapters, outbox, files, people);
  const timetable = new TimetableService(db, outbox, academic);
  const curriculum = new CurriculumService(db, outbox, notifications);
  const cms = new CmsService(db, outbox);
  const portal = new PortalService(db, timetable, cms);
  const attendance = new AttendanceService(db, outbox, notifications, academic, approvals, adapters);
  const communication = new CommunicationService(db, outbox, notifications, adapters);
  const accounting = new AccountingService(db, outbox, numbering, approvals);
  const fees = new FeesService(db, outbox, notifications, numbering, academic, accounting, adapters, config.appKey);
  const assessment = new AssessmentService(db, outbox, notifications, academic, files, adapters);
  const hr = new HrService(db, outbox, notifications, academic, accounting, approvals, tasks, files, people, adapters);
  const documents = new DocumentService(db, outbox, notifications, numbering, files, approvals, adapters);
  const admissions = new AdmissionsService(db, outbox, notifications, numbering, academic, people, fees, documents, adapters);

  const installer = new InstallerService(db, config, adapters, {
    auth, outbox, notifications, relay, log,
    /** A fresh school gets a current academic year, the institution preset, default periods and a website. */
    afterSchool: async (schoolId, input) => {
      const y = new Date().getFullYear();
      const yearId = await academic.createYear(schoolId, { name: String(y), startDate: `${y}-01-01`, endDate: `${y}-12-31`, setCurrent: true });
      await academic.applyPreset(schoolId, input.institutionType, yearId);
      await academic.ensureDefaultPeriods(schoolId);
      const campus = await academic.mainCampus(schoolId);
      if (campus && !(await db.count('rooms', { school_id: schoolId }))) for (let i = 1; i <= 6; i++) await academic.createRoom(schoolId, { campusId: String(campus.id), name: `Room ${100 + i}`, capacity: 40 });
      await cms.ensureDefaultSite(schoolId);
      await attendance.ensureDefaultPolicy(schoolId);
      await accounting.ensureBankAccounts(schoolId);
      await accounting.ensureExpenseCategories(schoolId);
      await fees.ensureFineRule(schoolId);
      await fees.ensureDefaultStructures(schoolId, yearId);
      await assessment.ensureExamTypes(schoolId);
      await hr.ensureSalaryComponents(schoolId);
      await hr.ensureTaxSlabs(schoolId);
      await documents.ensureTemplates(schoolId);
    },
  });

  registerPlatformJobs({ db, adapters, notifications, outbox, log });
  adapters.queue.register('people.import_students', (payload, ctx) => importer.runJob(payload, ctx));
  adapters.queue.register('attendance.notify_absent', (payload, ctx) => attendance.notifyAbsentBatch(payload, ctx as never) as never);
  adapters.queue.register('fees.generate_invoices', (payload, ctx) => fees.runBatch(payload, ctx));
  adapters.queue.register('assessment.report_cards', (payload, ctx) => assessment.renderReportCards(payload, ctx));
  adapters.queue.register('payroll.calculate', (payload, ctx) => hr.calculateRun(payload, ctx));
  adapters.queue.register('payroll.payslips', (payload, ctx) => hr.renderPayslips(payload, ctx));
  adapters.queue.register('documents.print_job', (payload, ctx) => documents.runPrintJob(payload, ctx));
  adapters.queue.register('admissions.merit', (payload, ctx) => admissions.runMeritJob(payload, ctx));
  adapters.scheduler.register('academic.syllabus_lag', async ({ schoolId }) => curriculum.syllabusLagCheck(schoolId));
  for (const [key, fn] of Object.entries(attendance.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(fees.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(assessment.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(hr.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(admissions.jobs())) adapters.scheduler.register(key, fn);
  registerSystemHandlers(handlers, { notifications, tasks, log, db, timetable, communication, academic, fees, hr, auth, admissions });

  let lastBeat = 0; let beating = false;
  const app: App = {
    config, db, log, adapters, audit, settings, rbac, files, customFields, tasks, approvals, notifications, auth, installer, outbox, handlers, rules, relay,
    numbering, academic, people, importer, timetable, curriculum, cms, portal, attendance, communication, accounting, fees, assessment, hr, documents, admissions,
    async start() {
      // background loops need the schema; before the installer has applied it they wait (fresh zip on cPanel)
      const loops = () => { relay.start(500); if (adapters.mode === 'inprocess') { adapters.queue.start(); adapters.scheduler.start(); } log.info('background loops running'); };
      if (await installer.hasSchema()) loops();
      else { const t = setInterval(async () => { if (await installer.hasSchema()) { clearInterval(t); loops(); } }, 3000); t.unref?.(); }
      log.info(`pathshala started · db=${db.engine} · adapters=${[adapters.queue.kind, adapters.scheduler.kind, adapters.storage.kind, adapters.pdf.kind, adapters.realtime.kind].join(',')} · mail=${adapters.mail.kind} sms=${adapters.sms.kind} push=${adapters.push.kind}`);
    },
    async stop() { await relay.stop(); await adapters.scheduler.stop(); await adapters.queue.stop(); await db.close(); },
    heartbeat() {
      const minGap = adapters.mode === 'inprocess' ? 60_000 : 20_000;
      if (beating || Date.now() - lastBeat < minGap) return;
      beating = true; lastBeat = Date.now();
      setImmediate(() => { app.tick().catch(e => log.error('heartbeat', e)).finally(() => { beating = false; }); });
    },
    async tick() {
      if (!(await installer.hasSchema())) return { scheduler: { ran: [], skipped: 0, errors: ['schema not installed yet'] }, relay: { published: 0, failed: 0 }, queue: { ran: 0, failed: 0 } };
      const scheduler = await adapters.scheduler.tick();
      const r = await relay.run();
      const q = await adapters.queue.drain();
      return { scheduler, relay: r, queue: q };
    },
  };
  return app;
}

/** 🔒 system handlers that belong to the platform itself (docs/AUTOMATION.md §14 N-rows) plus phase-1 reactions. */
function registerSystemHandlers(h: HandlerRegistry, d: { notifications: NotificationService; tasks: TaskService; log: Logger; db: Db; timetable: TimetableService; communication: CommunicationService; academic: AcademicService; fees: FeesService; hr: HrService; auth: AuthService; admissions: AdmissionsService }) {
  // B3: an approved staff leave proposes substitutes for every class that teacher has on those days
  h.on('leave.approved', 'suggest-substitutes', async e => {
    if (e.payload.applicantType !== 'staff' || !e.payload.staffId) return;
    const year = await d.academic.currentYear(e.schoolId); if (!year) return;
    const v = await d.timetable.publishedVersion(e.schoolId, String(year.id)); if (!v) return;
    for (const day of e.payload.dates) await d.timetable.suggestSubstitutes(e.schoolId, String(v.id), e.payload.staffId, day, e.payload.leaveId);
  });
  // a published timetable gives every section a chat channel teachers and guardians share
  h.on('timetable.published', 'section-channels', async e => {
    const secs = await d.db.query<{ id: string }>(`SELECT DISTINCT section_id AS id FROM timetable_slots WHERE version_id = ?`, [e.payload.versionId]);
    for (const s of secs) await d.communication.ensureSectionChannel(e.schoolId, s.id).catch(() => undefined);
  });
  h.on('rule.failed', 'alert-admins', async e => { await d.notifications.notifyRole(e.schoolId, 'admin', { channels: ['push', 'in_app', 'email'], eventKey: 'automation.rule_failed', data: { rule: e.payload.ruleCode, attempts: e.payload.attempts, error: e.payload.error }, entityType: 'platform.rule', entityId: e.payload.ruleId }); });
  h.on('job.failed', 'alert-admins', async e => { await d.notifications.notifyRole(e.schoolId, 'admin', { channels: ['push', 'in_app'], eventKey: 'automation.job_failed', title: 'Background job failed', body: `${e.payload.jobName} failed after ${e.payload.attempts} attempts: ${e.payload.error}`, entityType: 'platform.job', entityId: e.payload.jobId }); });
  h.on('notification.failed', 'alert-admins', async e => { await d.notifications.notifyRole(e.schoolId, 'admin', { channels: ['in_app'], eventKey: 'comms.delivery_failed', title: 'Message could not be delivered', body: `${e.payload.channel}: ${e.payload.error}`, entityType: 'communication.notification', entityId: e.payload.notificationId }); });
  h.on('task.created', 'notify-assignee', async e => {
    if (e.payload.assignedTo) await d.notifications.notify({ schoolId: e.schoolId, userId: e.payload.assignedTo, channels: ['push', 'in_app'], eventKey: 'task.assigned', data: { title: e.payload.title, due: e.payload.dueAt ?? '—' }, entityType: 'platform.task', entityId: e.payload.taskId });
    else if (e.payload.assignedRole) await d.notifications.notifyRole(e.schoolId, e.payload.assignedRole, { channels: ['push', 'in_app'], eventKey: 'task.assigned', data: { title: e.payload.title, due: e.payload.dueAt ?? '—' }, entityType: 'platform.task', entityId: e.payload.taskId });
  });
  h.on('approval.requested', 'notify-approvers', async e => { await d.notifications.notifyRole(e.schoolId, 'admin', { channels: ['push', 'in_app'], eventKey: 'approval.requested', data: { summary: e.payload.summary ?? `${e.payload.entityType} needs approval (step ${e.payload.step})` }, entityType: 'platform.approval', entityId: e.payload.requestId }); });
  h.on('user.locked', 'notify-user', async e => { await d.notifications.notify({ schoolId: e.schoolId, userId: e.payload.userId, channels: ['sms', 'email'], eventKey: 'auth.locked', title: 'Account locked', body: `Too many wrong passwords. Try again after ${e.payload.until} UTC.`, respectQuietHours: false }); });
  h.on('import.finished', 'notify-admins', async e => { await d.notifications.notifyRole(e.schoolId, 'admin', { channels: ['in_app', 'push', 'email'], eventKey: 'import.finished', title: 'Import finished', body: `${e.payload.entityType}: ${e.payload.successRows} imported, ${e.payload.errorRows} rows need fixing${e.payload.errorRows ? ' (see the error file)' : ''}.`, entityType: 'platform.import_job', entityId: e.payload.importJobId }); });
  h.on('notice.published', 'push-guardians', async e => {
    // audience {public:true} → every guardian with a portal account; section/class targeting comes with Phase 2 comms
    const users = await d.db.query<{ id: string }>(`SELECT u.id FROM users u WHERE u.school_id = ? AND u.user_type = 'guardian' AND u.is_active = TRUE LIMIT 5000`, [e.schoolId]);
    for (const u of users) await d.notifications.notify({ schoolId: e.schoolId, userId: u.id, channels: ['push', 'in_app'], eventKey: 'notice.published', title: e.payload.title, body: e.payload.title, entityType: 'communication.notice', entityId: e.payload.noticeId });
  });
  h.on('contact.received', 'notify-front-office', async e => { await d.notifications.notifyRole(e.schoolId, 'admin', { channels: ['in_app'], eventKey: 'cms.contact', title: 'New website message', body: `${e.payload.name}${e.payload.phone ? ' · ' + e.payload.phone : ''}`, entityType: 'cms.contact', entityId: e.payload.messageId }); });
  h.on('timetable.published', 'notify-teachers', async e => { await d.notifications.notifyRole(e.schoolId, 'teacher', { channels: ['push', 'in_app'], eventKey: 'timetable.published', title: 'New timetable published', body: `${e.payload.slots} periods scheduled. Check your classes in the portal.`, entityType: 'curriculum.timetable', entityId: e.payload.versionId }); });
  h.on('substitution.suggested', 'notify-substitute', async e => {
    if (!e.payload.substituteTeacherId) return;
    const st = await d.db.findOne<{ user_id: string | null }>('staff', { id: e.payload.substituteTeacherId });
    if (st?.user_id) await d.notifications.notify({ schoolId: e.schoolId, userId: st.user_id, channels: ['push', 'in_app'], eventKey: 'substitution.suggested', title: 'Substitution proposed', body: `You may be asked to cover a class on ${e.payload.onDate}. HOD will confirm.`, entityType: 'curriculum.substitution', entityId: e.payload.substitutionId });
  });
  // A9: a new student who shares a guardian phone with an active student gets a sibling discount proposed
  h.on('student.enrolled', 'propose-sibling-discount', async e => {
    const id = await d.fees.proposeSiblingDiscount(e.schoolId, e.payload.studentId, e.payload.academicYearId);
    if (id) await d.notifications.notifyRole(e.schoolId, 'accountant', { channels: ['in_app'], eventKey: 'fees.discount_proposed', title: 'Sibling discount proposed', body: 'A newly enrolled student has a sibling already in school. Approve or reject the discount.', entityType: 'fees.discount', entityId: id });
  });
  // H2: an approved payroll (or loan) request carries out what was approved
  h.on('approval.decided', 'hr-approvals', async e => {
    if (e.payload.decision === 'rejected') return;
    if (e.payload.entityType === 'hr.payroll') await d.hr.approveRun(e.schoolId, e.payload.entityId as string).catch(err => d.log.error(`payroll approval: ${(err as Error).message}`));
    if (e.payload.entityType === 'hr.loan') await d.hr.approveLoan(e.schoolId, e.payload.entityId as string).catch(err => d.log.error(`loan approval: ${(err as Error).message}`));
  });
  // H6: someone leaving loses their account and their sessions, and their classes need covering
  h.on('staff.left', 'close-account', async e => {
    const st = await d.db.findOne<{ user_id: string | null; first_name: string }>('staff', { id: e.payload.staffId });
    if (st?.user_id) { await d.db.update('users', { is_active: false, updated_at: nowSql() }, { id: st.user_id }); await d.auth.logoutEverywhere(st.user_id); }
    const slots = await d.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM timetable_slots WHERE school_id = ? AND teacher_id = ?`, [e.schoolId, e.payload.staffId]);
    if (Number(slots[0]?.n)) await d.tasks.create({ schoolId: e.schoolId, title: `Reassign ${Number(slots[0]!.n)} timetable periods of ${st?.first_name ?? 'a leaver'}`, taskType: 'hr.exit', assignedRole: 'admin', entityType: 'people.staff', entityId: e.payload.staffId, priority: 'high' });
  });
  h.on('application.received', 'notify-hr', async e => { await d.notifications.notifyRole(e.schoolId, 'admin', { channels: ['in_app'], eventKey: 'hr.application_received', title: 'New job application', body: `${e.payload.name} applied for ${e.payload.title}.`, entityType: 'hr.applicant', entityId: e.payload.applicantId }); });
  // A1: a website enquiry gets a counsellor, an acknowledgement and a follow-up task
  h.on('enquiry.created', 'assign-counsellor', async e => {
    const staffId = await d.admissions.assignCounsellor(e.schoolId, e.payload.enquiryId);
    await d.notifications.notify({ schoolId: e.schoolId, address: e.payload.phone, channels: ['sms'], eventKey: 'admissions.enquiry_ack', data: { student: e.payload.studentName }, title: 'Thank you', body: `We have your enquiry about ${e.payload.studentName}. Our admissions desk will call you within a day.`, entityType: 'admissions.enquiry', entityId: e.payload.enquiryId });
    const staff = staffId ? await d.db.findOne<{ user_id: string | null }>('staff', { id: staffId }) : null;
    await d.tasks.create({ schoolId: e.schoolId, title: `Call ${e.payload.guardianName} about ${e.payload.studentName}`, taskType: 'admissions.followup', assignedTo: staff?.user_id ?? null, assignedRole: staff?.user_id ? null : 'admin', entityType: 'admissions.enquiry', entityId: e.payload.enquiryId, dueAt: new Date(Date.now() + 48 * 3600_000) });
  });
  // A4 and A8: paying the form fee submits the application; paying the admission fee enrols the child
  h.on('payment.received', 'admissions-money', async e => {
    for (const invoiceId of e.payload.invoiceIds ?? []) await d.admissions.onPaymentReceived(e.schoolId, invoiceId).catch(err => d.log.error(`admissions payment: ${(err as Error).message}`));
  });
  // A5: once a class's results are in, the merit list follows if the campaign asks for it
  h.on('test.results_entered', 'compute-merit', async e => {
    const campaign = await d.db.findOne<{ auto_merit_list: unknown }>('admission_campaigns', { id: e.payload.campaignId });
    if (campaign && Number(campaign.auto_merit_list)) await d.admissions.computeMerit(e.schoolId, e.payload.campaignId, e.payload.classId);
  });
  h.on('test.ping', 'log', async e => { d.log.info(`test.ping from ${e.schoolId}: ${e.payload.note ?? ''}`); });
}
