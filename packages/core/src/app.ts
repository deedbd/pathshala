import path from 'node:path';
import { connect, dbConfigFromEnv, type Db } from '@pathshala/db';
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

export interface App {
  config: AppConfig; db: Db; log: Logger; adapters: Adapters & { mode: SchedulerMode };
  audit: AuditService; settings: SettingsService; rbac: RbacService; files: FileService; customFields: CustomFieldService;
  tasks: TaskService; approvals: ApprovalService; notifications: NotificationService; auth: AuthService; installer: InstallerService;
  outbox: OutboxService; handlers: HandlerRegistry; rules: RuleEngine; relay: Relay;
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
  const installer = new InstallerService(db, config, adapters, { auth, outbox, notifications, relay, log });

  registerPlatformJobs({ db, adapters, notifications, outbox, log });
  registerSystemHandlers(handlers, { notifications, tasks, log });

  let lastBeat = 0; let beating = false;
  const app: App = {
    config, db, log, adapters, audit, settings, rbac, files, customFields, tasks, approvals, notifications, auth, installer, outbox, handlers, rules, relay,
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

/** 🔒 system handlers that belong to the platform itself (docs/AUTOMATION.md §14 N-rows). */
function registerSystemHandlers(h: HandlerRegistry, d: { notifications: NotificationService; tasks: TaskService; log: Logger }) {
  h.on('rule.failed', 'alert-admins', async e => { await d.notifications.notifyRole(e.schoolId, 'admin', { channels: ['push', 'in_app', 'email'], eventKey: 'automation.rule_failed', data: { rule: e.payload.ruleCode, attempts: e.payload.attempts, error: e.payload.error }, entityType: 'platform.rule', entityId: e.payload.ruleId }); });
  h.on('job.failed', 'alert-admins', async e => { await d.notifications.notifyRole(e.schoolId, 'admin', { channels: ['push', 'in_app'], eventKey: 'automation.job_failed', title: 'Background job failed', body: `${e.payload.jobName} failed after ${e.payload.attempts} attempts: ${e.payload.error}`, entityType: 'platform.job', entityId: e.payload.jobId }); });
  h.on('notification.failed', 'alert-admins', async e => { await d.notifications.notifyRole(e.schoolId, 'admin', { channels: ['in_app'], eventKey: 'comms.delivery_failed', title: 'Message could not be delivered', body: `${e.payload.channel}: ${e.payload.error}`, entityType: 'communication.notification', entityId: e.payload.notificationId }); });
  h.on('task.created', 'notify-assignee', async e => {
    if (e.payload.assignedTo) await d.notifications.notify({ schoolId: e.schoolId, userId: e.payload.assignedTo, channels: ['push', 'in_app'], eventKey: 'task.assigned', data: { title: e.payload.title, due: e.payload.dueAt ?? '—' }, entityType: 'platform.task', entityId: e.payload.taskId });
    else if (e.payload.assignedRole) await d.notifications.notifyRole(e.schoolId, e.payload.assignedRole, { channels: ['push', 'in_app'], eventKey: 'task.assigned', data: { title: e.payload.title, due: e.payload.dueAt ?? '—' }, entityType: 'platform.task', entityId: e.payload.taskId });
  });
  h.on('approval.requested', 'notify-approvers', async e => { await d.notifications.notifyRole(e.schoolId, 'admin', { channels: ['push', 'in_app'], eventKey: 'approval.requested', data: { summary: e.payload.summary ?? `${e.payload.entityType} needs approval (step ${e.payload.step})` }, entityType: 'platform.approval', entityId: e.payload.requestId }); });
  h.on('user.locked', 'notify-user', async e => { await d.notifications.notify({ schoolId: e.schoolId, userId: e.payload.userId, channels: ['sms', 'email'], eventKey: 'auth.locked', title: 'Account locked', body: `Too many wrong passwords. Try again after ${e.payload.until} UTC.`, respectQuietHours: false }); });
  h.on('test.ping', 'log', async e => { d.log.info(`test.ping from ${e.schoolId}: ${e.payload.note ?? ''}`); });
}
