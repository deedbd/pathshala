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
import { AutomationService } from './automation/console.js';
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
import { LibraryService } from './modules/library.js';
import { TransportService } from './modules/transport.js';
import { HostelService } from './modules/hostel.js';
import { InventoryService } from './modules/inventory.js';
import { FrontOfficeService } from './modules/frontoffice.js';
import { WelfareService } from './modules/welfare.js';
import { LmsService } from './modules/lms.js';
import { EngagementService } from './modules/engagement.js';
import { CommerceService } from './modules/commerce.js';
import { GivingService } from './modules/giving.js';
import { AlumniService } from './modules/alumni.js';
import { FacilitiesService } from './modules/facilities.js';
import { GovernanceService } from './modules/governance.js';
import { ComplianceService } from './modules/compliance.js';
import { AnalyticsService } from './modules/analytics.js';
import { ForecastService } from './modules/forecast.js';
import { SaasService } from './modules/saas.js';
import { MarketplaceService } from './modules/marketplace.js';
import { AiService } from './modules/ai.js';
import { GroupsService } from './modules/groups.js';
import { IvrService } from './modules/ivr.js';
import { CollegeService } from './modules/college.js';
import { AdaptiveService } from './modules/adaptive.js';
import { PlatformService } from './modules/platform.js';
import { OwnerService } from './modules/owner.js';
import { OwnerAccessService } from './owner-access.js';

export interface App {
  config: AppConfig; db: Db; log: Logger; adapters: Adapters & { mode: SchedulerMode };
  audit: AuditService; settings: SettingsService; rbac: RbacService; files: FileService; customFields: CustomFieldService;
  tasks: TaskService; approvals: ApprovalService; notifications: NotificationService; auth: AuthService; installer: InstallerService;
  automation: AutomationService;
  outbox: OutboxService; handlers: HandlerRegistry; rules: RuleEngine; relay: Relay;
  numbering: NumberingService; academic: AcademicService; people: PeopleService; importer: ImportService; timetable: TimetableService; curriculum: CurriculumService; cms: CmsService; portal: PortalService;
  attendance: AttendanceService; communication: CommunicationService; accounting: AccountingService; fees: FeesService; assessment: AssessmentService; hr: HrService; documents: DocumentService; admissions: AdmissionsService; library: LibraryService; transport: TransportService; hostel: HostelService; inventory: InventoryService; frontOffice: FrontOfficeService; welfare: WelfareService; lms: LmsService; engagement: EngagementService; commerce: CommerceService; giving: GivingService; alumni: AlumniService; facilities: FacilitiesService; governance: GovernanceService; compliance: ComplianceService; analytics: AnalyticsService; saas: SaasService; marketplace: MarketplaceService; ai: AiService; groups: GroupsService; forecast: ForecastService; ivr: IvrService; college: CollegeService; adaptive: AdaptiveService; platform: PlatformService; owner: OwnerService; ownerAccess: OwnerAccessService;
  /** Boots background loops (relay, queue, scheduler) according to the adapter mode. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Request heartbeat: throttled scheduler tick + relay + queue drain (WordPress-cron pattern). */
  heartbeat(): void;
  /** Full tick for /cron/tick and tests; `budgetMs` bounds the relay when a request triggered it. */
  tick(opts?: { budgetMs?: number; maxJobs?: number }): Promise<{ scheduler: Awaited<ReturnType<Adapters['scheduler']['tick']>>; relay: { published: number; failed: number }; queue: { ran: number; failed: number } }>;
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
  const timetable = new TimetableService(db, outbox, academic, notifications, tasks);
  const curriculum = new CurriculumService(db, outbox, notifications);
  const cms = new CmsService(db, outbox, notifications);
  const portal = new PortalService(db, timetable, cms, files);
  const attendance = new AttendanceService(db, outbox, notifications, academic, approvals, adapters);
  const communication = new CommunicationService(db, outbox, notifications, adapters);
  const accounting = new AccountingService(db, outbox, notifications, tasks, numbering, approvals);
  const documents = new DocumentService(db, outbox, notifications, numbering, files, approvals, adapters);
  const fees = new FeesService(db, outbox, notifications, tasks, numbering, academic, accounting, documents, adapters, config.appKey);
  const assessment = new AssessmentService(db, outbox, notifications, academic, files, adapters, documents, tasks, fees, timetable);
  const hr = new HrService(db, outbox, notifications, academic, accounting, approvals, tasks, files, people, settings, adapters);
  const importer = new ImportService(db, adapters, outbox, files, people, attendance, hr);
  const admissions = new AdmissionsService(db, outbox, notifications, numbering, academic, people, fees, documents, files, settings, adapters);
  const library = new LibraryService(db, outbox, notifications, numbering, fees);
  const transport = new TransportService(db, outbox, notifications, tasks, attendance);
  const hostel = new HostelService(db, outbox, notifications, tasks, approvals, fees, settings);
  const inventory = new InventoryService(db, outbox, notifications, numbering, tasks, approvals, accounting);
  const frontOffice = new FrontOfficeService(db, outbox, notifications, numbering, tasks);
  const welfare = new WelfareService(db, outbox, notifications, tasks, approvals, inventory, config.appKey);
  const lms = new LmsService(db, outbox, notifications, academic, documents, tasks);
  const engagement = new EngagementService(db, outbox, notifications, documents);
  const commerce = new CommerceService(db, outbox, notifications, tasks, numbering, accounting, fees, settings);
  const giving = new GivingService(db, outbox, notifications, tasks, accounting, fees, academic, documents);
  const alumni = new AlumniService(db, outbox, notifications, academic);
  const facilities = new FacilitiesService(db, outbox, notifications, tasks, accounting, adapters);
  const governance = new GovernanceService(db, outbox, notifications, tasks, config.appKey);
  const compliance = new ComplianceService(db, outbox, notifications, academic, files, hr, tasks, settings, adapters);
  const analytics = new AnalyticsService(db, outbox, notifications);
  const forecast = new ForecastService(db, outbox, notifications, academic, analytics);
  const saas = new SaasService(db, outbox, notifications, numbering, adapters);
  const marketplace = new MarketplaceService(db, outbox, log, notifications);
  const ai = new AiService(db, outbox, settings, adapters, notifications);
  // year 4: the only service that reads across tenants, and every crossing is gated inside it
  const groups = new GroupsService(db, outbox, notifications, people, analytics);
  // the voice line: an inbound IVR gateway drives it, so it needs the modules that hold the answers
  const ivr = new IvrService(db, settings, outbox, people, frontOffice, attendance, assessment, ai, notifications, config.appKey, config.env);
  const college = new CollegeService(db, outbox, notifications, academic, people, fees, lms, assessment, documents, tasks);
  const adaptive = new AdaptiveService(db, outbox, notifications, academic, assessment, lms);
  const platform = new PlatformService(db, outbox, notifications, settings, adapters, config.rootDir, log);

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
      await fees.ensureEarlyPaymentDiscount(schoolId);
      await fees.ensureDefaultStructures(schoolId, yearId);
      await assessment.ensureExamTypes(schoolId);
      await hr.ensureSalaryComponents(schoolId);
      await hr.ensureTaxSlabs(schoolId);
      await documents.ensureTemplates(schoolId);
      await library.ensureCategories(schoolId);
      await inventory.ensureSetup(schoolId);
      await welfare.ensureCategories(schoolId);
    },
  });

  // the vendor's own console: the second service that crosses the tenant boundary, gated inside itself
  const owner = new OwnerService(db, config, audit, rbac, auth, installer, notifications, saas, platform);
  // who may even see the vendor's door: a trusted device, an allowed address, or a MAC on our own LAN
  const ownerAccess = new OwnerAccessService(db, config);

  registerPlatformJobs({ db, adapters, notifications, outbox, log });
  adapters.queue.register('people.import_students', (payload, ctx) => importer.runJob(payload, ctx));
  adapters.queue.register('attendance.notify_absent', (payload, ctx) => attendance.notifyAbsentBatch(payload, ctx as never) as never);
  adapters.queue.register('fees.generate_invoices', (payload, ctx) => fees.runBatch(payload, ctx));
  adapters.queue.register('assessment.report_cards', (payload, ctx) => assessment.renderReportCards(payload, ctx));
  adapters.queue.register('assessment.admit_cards', (payload, ctx) => assessment.renderAdmitCards(payload, ctx));
  adapters.queue.register('payroll.calculate', (payload, ctx) => hr.calculateRun(payload, ctx));
  adapters.queue.register('payroll.payslips', (payload, ctx) => hr.renderPayslips(payload, ctx));
  adapters.queue.register('documents.print_job', (payload, ctx) => documents.runPrintJob(payload, ctx));
  adapters.queue.register('admissions.merit', (payload, ctx) => admissions.runMeritJob(payload, ctx));
  for (const [key, fn] of Object.entries(academic.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(curriculum.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(timetable.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(attendance.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(fees.jobs())) adapters.scheduler.register(key, fn);
  // accounting, commerce and giving had no jobs of their own until the money watchdogs were added
  for (const [key, fn] of Object.entries(accounting.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(commerce.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(giving.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(assessment.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(hr.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(admissions.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(library.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(transport.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(hostel.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(inventory.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(frontOffice.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(welfare.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(lms.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(adaptive.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(engagement.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(facilities.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(governance.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(compliance.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(analytics.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(forecast.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(saas.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(college.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(platform.jobs())) adapters.scheduler.register(key, fn);
  // year-2+ services that had no scheduled work until the automation pass gave them some
  for (const [key, fn] of Object.entries(cms.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(alumni.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(marketplace.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(ai.jobs())) adapters.scheduler.register(key, fn);
  for (const [key, fn] of Object.entries(ivr.jobs())) adapters.scheduler.register(key, fn);
  // groups is the only cross-tenant service: its nightly pass runs per head school, through its own gate
  for (const [key, fn] of Object.entries(groups.jobs())) adapters.scheduler.register(key, fn);
  // a plugin's webhook is somebody else's server: the relay posts to it and gives up quickly
  marketplace.registerHooks(handlers, ['student.enrolled', 'payment.received', 'attendance.absent', 'result.published', 'invoice.created', 'staff.joined']);
  registerSystemHandlers(handlers, { notifications, tasks, log, db, timetable, communication, academic, fees, accounting, hr, auth, admissions, inventory, welfare, commerce, college, attendance, people, settings });

  // the console's half of the automation engine: the inbox, the tasks, the rules and their preview
  const automation = new AutomationService(db, approvals, tasks, o => app.tick(o));

  let lastBeat = 0; let beating = false;
  const app: App = {
    config, db, log, adapters, audit, settings, rbac, files, customFields, tasks, approvals, notifications, auth, installer, outbox, handlers, rules, relay, automation,
    numbering, academic, people, importer, timetable, curriculum, cms, portal, attendance, communication, accounting, fees, assessment, hr, documents, admissions, library, transport, hostel, inventory, frontOffice, welfare, lms, engagement, commerce, giving, alumni, facilities, governance, compliance, analytics, saas, marketplace, ai, groups, forecast, ivr, college, adaptive, platform, owner, ownerAccess,
    async start() {
      // background loops need the schema; before the installer has applied it they wait (fresh zip on cPanel)
      const loops = () => {
        // an update ships jobs the database has never heard of; the schools already installed get
        // their rows here, before the scheduler goes looking for something to run
        installer.ensureAutomationCatalogue().catch(e => log.error('automation catalogue', e));
        relay.start(500);
        if (adapters.mode === 'inprocess') { adapters.queue.start(); adapters.scheduler.start(); }
        log.info('background loops running');
      };
      if (await installer.hasSchema()) loops();
      else { const t = setInterval(async () => { if (await installer.hasSchema()) { clearInterval(t); loops(); } }, 3000); t.unref?.(); }
      log.info(`pathshala started · db=${db.engine} · adapters=${[adapters.queue.kind, adapters.scheduler.kind, adapters.storage.kind, adapters.pdf.kind, adapters.realtime.kind].join(',')} · mail=${adapters.mail.kind} sms=${adapters.sms.kind} push=${adapters.push.kind}`);
    },
    async stop() { await relay.stop(); await adapters.scheduler.stop(); await adapters.queue.stop(); await db.close(); },
    heartbeat() {
      const minGap = adapters.mode === 'inprocess' ? 60_000 : 20_000;
      if (beating || Date.now() - lastBeat < minGap) return;
      beating = true; lastBeat = Date.now();
      // a request-driven tick is strictly bounded: whoever browses next must not pay for the backlog
      setImmediate(() => { app.tick({ budgetMs: 2000, maxJobs: 3 }).catch(e => log.error('heartbeat', e)).finally(() => { beating = false; }); });
    },
    async tick(opts = {}) {
      if (!(await installer.hasSchema())) return { scheduler: { ran: [], skipped: 0, errors: ['schema not installed yet'] }, relay: { published: 0, failed: 0 }, queue: { ran: 0, failed: 0 } };
      const scheduler = await adapters.scheduler.tick();
      const r = await relay.run(100, opts.budgetMs ?? 0);
      const q = await adapters.queue.drain(opts.maxJobs);
      return { scheduler, relay: r, queue: q };
    },
  };
  return app;
}

/** 🔒 system handlers that belong to the platform itself (docs/AUTOMATION.md §14 N-rows) plus phase-1 reactions. */
function registerSystemHandlers(h: HandlerRegistry, d: { notifications: NotificationService; tasks: TaskService; log: Logger; db: Db; timetable: TimetableService; communication: CommunicationService; academic: AcademicService; fees: FeesService; accounting: AccountingService; hr: HrService; auth: AuthService; admissions: AdmissionsService; inventory: InventoryService; welfare: WelfareService; commerce: CommerceService; college: CollegeService; attendance: AttendanceService; people: PeopleService; settings: SettingsService }) {
  // B5: a holiday declared after the register was already marked. Only the rows the system wrote
  // itself become `holiday` — a mark a teacher made by hand stands, because they saw the children.
  h.on('calendar.holiday_added', 'clear-attendance', async e => {
    await d.attendance.applyHoliday(e.schoolId, e.payload.startDate, e.payload.endDate);
  });
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
  /**
   * N6: a lost card was replaced. Two modules own the consequences and neither is `documents`.
   *
   * `people` owns the tag on the person, which is what the gate actually reads — a cancelled card
   * whose tag still opens the door has cancelled nothing. `fees` owns the money: the replacement
   * costs what `documents.id_card_replacement_fee` says it costs (Tk 200 unless the school has said
   * otherwise), and a school that sets it to 0 is choosing to absorb it and gets no invoice.
   */
  h.on('id_card.reissued', 'revoke-tag-and-charge', async e => {
    if (e.payload.revokedTag) await d.people.revokeRfid(e.schoolId, e.payload.personType, e.payload.personId, e.payload.revokedTag);
    if (e.payload.personType !== 'student') return;
    const fee = Number((await d.settings.get<number>(e.schoolId, 'documents.id_card_replacement_fee')) ?? 200);
    if (!(fee > 0)) return;
    const headId = await d.fees.ensureHead(e.schoolId, { name: 'ID card replacement', code: 'ID_CARD', kind: 'misc', glCode: '4900' });
    await d.fees.createInvoice(e.schoolId, { studentId: e.payload.personId, items: [{ feeHeadId: headId, description: `Replacement ID card ${e.payload.cardNo} (${e.payload.oldCardNo} ${e.payload.reason})`, amount: fee }], notes: `id_card:${e.payload.newCardId}` });
    await d.notifications.notifyRoleOnce(e.schoolId, 'accountant', 24 * 30, { channels: ['in_app'], eventKey: 'documents.card_reissued', title: 'ID card replaced', body: `${e.payload.oldCardNo} was ${e.payload.reason}; ${e.payload.cardNo} is queued for printing and Tk ${fee} has been invoiced.`, entityType: 'documents.id_card', entityId: e.payload.newCardId });
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
  // a coaching place is handed over by the money, not by the plan: the first instalment confirms the seat
  h.on('payment.received', 'course-places', async e => {
    for (const invoiceId of e.payload.invoiceIds ?? []) await d.college.onPaymentReceived(e.schoolId, invoiceId).catch(err => d.log.error(`course place: ${(err as Error).message}`));
  });
  // a paid shop invoice is an order the counter can hand over
  h.on('payment.received', 'shop-orders', async e => {
    for (const invoiceId of e.payload.invoiceIds ?? []) await d.commerce.onInvoicePaid(e.schoolId, invoiceId).catch(err => d.log.error(`shop order: ${(err as Error).message}`));
  });
  // A5: once a class's results are in, the merit list follows if the campaign asks for it
  h.on('test.results_entered', 'compute-merit', async e => {
    const campaign = await d.db.findOne<{ auto_merit_list: unknown }>('admission_campaigns', { id: e.payload.campaignId });
    if (!campaign || !Number(campaign.auto_merit_list)) return;
    // wait for the last mark of the class: ranking half a cohort would hand out the wrong seats
    if (!(await d.admissions.readyForMerit(e.schoolId, e.payload.campaignId, e.payload.classId))) return;
    await d.admissions.computeMerit(e.schoolId, e.payload.campaignId, e.payload.classId);
  });
  // G2: an approved expense pays itself. The approval was the human step — leaving the journal for
  // somebody to post by hand is how an approved bill ends up unpaid and off the books.
  h.on('approval.decided', 'accounting-approvals', async e => {
    // only a decision that actually approves pays: an escalation is still somebody's to make
    if (e.payload.decision !== 'approved' && e.payload.decision !== 'auto_approved') return;
    if (e.payload.entityType !== 'expense') return;
    await d.db.update('expenses', { status: 'approved', updated_at: nowSql() }, { id: e.payload.entityId as string, school_id: e.schoolId, status: 'pending' });
    await d.accounting.payExpense(e.schoolId, e.payload.entityId as string).catch(err => d.log.error(`expense approval: ${(err as Error).message}`));
  });
  // L3: an approved issue request empties the shelf onto somebody's name
  h.on('approval.decided', 'inventory-approvals', async e => {
    if (e.payload.decision === 'rejected') return;
    if (e.payload.entityType === 'inventory.issue_request') await d.inventory.issueApproved(e.schoolId, e.payload.entityId as string).catch(err => d.log.error(`issue request: ${(err as Error).message}`));
  });
  // an approved disciplinary action is carried out (guardian told, incident closed)
  h.on('approval.decided', 'welfare-approvals', async e => {
    if (e.payload.decision === 'rejected') return;
    if (e.payload.entityType === 'welfare.disciplinary_action') await d.welfare.approveAction(e.schoolId, e.payload.entityId as string).catch(err => d.log.error(`disciplinary action: ${(err as Error).message}`));
  });
  h.on('test.ping', 'log', async e => { d.log.info(`test.ping from ${e.schoolId}: ${e.payload.note ?? ''}`); });
}
