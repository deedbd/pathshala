import type { Db, Row } from '@pathshala/db';
import { json, nowSql } from '@pathshala/db';
import type { ApprovalService } from '../approvals.js';
import type { TaskService } from '../tasks.js';
import { HttpError, notFound } from '../context.js';

/** How long a rule that has just been switched on watches before it is allowed to act. */
export const PREVIEW_HOURS = 48;

export interface ApprovalRow {
  id: string; entityType: string; entityId: string; status: string; currentStep: number;
  dueAt: string | null; createdAt: string; requester: string | null; workflow: string | null;
  /** What the decision is worth, out of the summary the module that asked put there. */
  worth: number | null; what: string; overdue: boolean;
}
export interface TaskRow {
  id: string; title: string; description: string | null; taskType: string | null; assignee: string | null;
  assignedRole: string | null; entityType: string | null; entityId: string | null; dueAt: string | null;
  priority: string; status: string; raisedBy: string; overdue: boolean;
}
export interface RuleAction { type: string; note?: string }
export interface RuleSummary {
  id: string; code: string; name: string; module: string; description: string | null; triggerKind: string;
  eventType: string | null; cronExpr: string | null; actions: RuleAction[]; isActive: boolean; isSystem: boolean;
  previewUntil: string | null; inPreview: boolean; previewRuns: number; runCount: number; lastRunAt: string | null;
}
export interface PreviewRow { id: string; ruleId: string; code: string; name: string; module: string; startedAt: string; aggregateType: string | null; aggregateId: string | null; previewUntil: string | null; would: { type: string; would: string }[] }
export interface RunRow { id: string; ruleId: string; code: string; name: string; module: string; startedAt: string; finishedAt: string | null; status: string; aggregateType: string | null; aggregateId: string | null; error: string | null }
export interface ScheduledJobRow { id: string; jobKey: string; cronExpr: string; timezone: string; isActive: boolean; nextRunAt: string | null; lastRunAt: string | null; lastStatus: string | null; lastDurationMs: number | null; overdue: boolean }
export interface BackgroundJobRow { id: string; jobName: string; queue: string; status: string; attempts: number; progressPct: number; scheduledFor: string | null; error: string | null }
export interface WebhookRow { id: string; url: string; eventTypes: string[]; isActive: boolean; failureCount: number; attempts: number; delivered: number; successPct: number | null; lastAttemptAt: string | null }
export interface DeliveryRow { id: string; webhookId: string; url: string; eventUid: string; eventType: string | null; attempt: number; responseCode: number | null; deliveredAt: string | null; nextRetryAt: string | null; createdAt: string; responseExcerpt: string | null }

const s = (v: unknown): string => String(v ?? '');
const sn = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number => Number(v ?? 0);
const nn = (v: unknown): number | null => (v == null ? null : Number(v));
const b = (v: unknown): boolean => !!Number(v ?? 0) || v === true;

/**
 * What the automation console reads and does.
 *
 * The engine (rules, relay, scheduler) is elsewhere and stays there; this is the half a head teacher
 * touches — every waiting decision, every open task, what each rule listens for and when it last
 * fired, which cron lines are overdue, the run log, and the webhooks with their failures. Until it
 * existed, `ApprovalService.pending()` and `TaskService.open()` had no caller anywhere in the
 * console: a leave application could sit waiting for ever and nothing on any screen said so.
 *
 * Every method returns a named shape rather than a database row, because the console is the one
 * caller and a column rename should break the build here, not the page.
 */
export class AutomationService {
  constructor(private db: Db, private approvals: ApprovalService, private tasks: TaskService, private tick: (opts?: { budgetMs?: number; maxJobs?: number }) => Promise<unknown>) {}

  // ---------- approvals ----------
  /**
   * The inbox. Every waiting decision carries who asked, what it is about and **what it is worth**,
   * because "approve this expense" without the amount is not a decision, it is a click. The worth is
   * read out of the request's own summary — the module that raised it put it there — and the entity
   * is named in words rather than as a table name and an id.
   */
  async pendingApprovals(schoolId: string, limit = 100): Promise<ApprovalRow[]> {
    const rows = await this.db.query<Row>(
      `SELECT r.id, r.entity_type, r.entity_id, r.status, r.current_step, r.due_at, r.created_at, r.summary, u.display_name AS requester, w.name AS workflow_name
       FROM approval_requests r LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN approval_workflows w ON w.id = r.workflow_id
       WHERE r.school_id = ? AND r.status IN ('pending','escalated') ORDER BY r.due_at IS NULL, r.due_at ASC, r.created_at ASC LIMIT ${Math.min(500, limit)}`, [schoolId]);
    const now = nowSql();
    return rows.map(r => {
      const summary = json<Record<string, unknown>>(r.summary) ?? {};
      const worth = ['amount', 'total', 'value', 'gross'].map(k => summary[k]).find(v => typeof v === 'number' || (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))));
      return {
        id: s(r.id), entityType: s(r.entity_type), entityId: s(r.entity_id), status: s(r.status), currentStep: n(r.current_step),
        dueAt: sn(r.due_at), createdAt: s(r.created_at), requester: sn(r.requester), workflow: sn(r.workflow_name),
        worth: worth == null ? null : Number(worth),
        what: s(summary.title ?? summary.summary ?? summary.description ?? `${s(r.entity_type)} ${s(r.entity_id).slice(-6)}`),
        overdue: !!r.due_at && s(r.due_at) < now,
      };
    });
  }
  async decideApproval(schoolId: string, requestId: string, decision: 'approved' | 'rejected', comment?: string) {
    if (decision === 'rejected' && !comment?.trim()) throw new HttpError(400, 'a refusal needs a reason — the person who asked has to be told why', 'reason_required');
    return this.approvals.decide(requestId, schoolId, decision, comment);
  }

  // ---------- tasks ----------
  async openTasks(schoolId: string, opts: { assignedTo?: string; assignedRole?: string; limit?: number } = {}): Promise<TaskRow[]> {
    const where = ['t.school_id = ?', `t.status IN ('open','in_progress')`]; const params: unknown[] = [schoolId];
    if (opts.assignedTo) { where.push('t.assigned_to = ?'); params.push(opts.assignedTo); }
    if (opts.assignedRole) { where.push('t.assigned_role = ?'); params.push(opts.assignedRole); }
    const rows = await this.db.query<Row>(
      `SELECT t.id, t.title, t.description, t.task_type, t.assigned_role, t.entity_type, t.entity_id, t.due_at, t.priority, t.status, t.created_by, u.display_name AS assignee
       FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to WHERE ${where.join(' AND ')}
       ORDER BY t.due_at IS NULL, t.due_at ASC, t.created_at ASC LIMIT ${Math.min(500, opts.limit ?? 100)}`, params);
    const now = nowSql();
    return rows.map(t => ({
      id: s(t.id), title: s(t.title), description: sn(t.description), taskType: sn(t.task_type), assignee: sn(t.assignee),
      assignedRole: sn(t.assigned_role), entityType: sn(t.entity_type), entityId: sn(t.entity_id), dueAt: sn(t.due_at),
      priority: s(t.priority), status: s(t.status), raisedBy: s(t.created_by ?? 'system'), overdue: !!t.due_at && s(t.due_at) < now,
    }));
  }
  async completeTask(schoolId: string, id: string) {
    const done = await this.tasks.complete(id, schoolId);
    if (!done) throw notFound('task');
    return { ok: true };
  }

  // ---------- rules ----------
  /** Every rule with what it listens for, what it does, when it last ran and how often. */
  async rules(schoolId: string): Promise<RuleSummary[]> {
    const rows = await this.db.query<Row>(
      `SELECT r.id, r.code, r.name, r.module, r.description, r.trigger_kind, r.event_type, r.cron_expr, r.actions, r.is_active, r.is_system, r.preview_until, r.run_count, r.last_run_at,
        (SELECT COUNT(*) FROM automation_runs a WHERE a.rule_id = r.id AND a.status = 'preview') AS preview_runs
       FROM automation_rules r WHERE r.school_id = ? ORDER BY r.module, r.code`, [schoolId]);
    const now = nowSql();
    return rows.map(r => ({
      id: s(r.id), code: s(r.code), name: s(r.name), module: s(r.module), description: sn(r.description),
      triggerKind: s(r.trigger_kind), eventType: sn(r.event_type), cronExpr: sn(r.cron_expr),
      actions: (json<RuleAction[]>(r.actions) ?? []).filter(a => a && typeof a === 'object'),
      isActive: b(r.is_active), isSystem: b(r.is_system), previewUntil: sn(r.preview_until),
      inPreview: !!r.preview_until && s(r.preview_until) > now, previewRuns: n(r.preview_runs),
      runCount: n(r.run_count), lastRunAt: sn(r.last_run_at),
    }));
  }
  /**
   * Switching a rule on starts a 48-hour preview: it listens, it matches, it writes down what it
   * would have done, and it does none of it. `automation_rules.preview_until` has been a column
   * nobody wrote since the schema was drawn — so every rule a school turned on went live on the
   * spot, and the first time anybody saw what it did was when a thousand guardians were texted.
   *
   * Switching one off clears the window: an off rule has nothing to preview, and leaving a stale
   * date behind would silence it for two days the next time somebody turned it back on.
   */
  async setRuleActive(schoolId: string, ruleId: string, active: boolean, opts: { preview?: boolean } = {}) {
    const rule = await this.db.findOne<Row>('automation_rules', { id: ruleId, school_id: schoolId });
    if (!rule) throw notFound('automation rule');
    const preview = active && (opts.preview ?? true);
    const previewUntil = preview ? nowSql(new Date(Date.now() + PREVIEW_HOURS * 3600_000)) : null;
    await this.db.update('automation_rules', { is_active: active, preview_until: previewUntil, updated_at: nowSql() }, { id: ruleId, school_id: schoolId });
    return { id: ruleId, code: s(rule.code), active, previewUntil };
  }
  /** The window ends when a person has read the list and says so; nothing goes live on its own. */
  async endPreview(schoolId: string, ruleId: string) {
    const rule = await this.db.findOne<Row>('automation_rules', { id: ruleId, school_id: schoolId });
    if (!rule) throw notFound('automation rule');
    if (!rule.preview_until) return { id: ruleId, previewUntil: null as string | null, alreadyLive: true };
    await this.db.update('automation_rules', { preview_until: null, updated_at: nowSql() }, { id: ruleId, school_id: schoolId });
    return { id: ruleId, previewUntil: null as string | null, alreadyLive: false };
  }
  /** What the rules now in preview have decided not to do, in the words a person would have read. */
  async previewRuns(schoolId: string, opts: { ruleId?: string; limit?: number } = {}): Promise<PreviewRow[]> {
    const where = ['a.school_id = ?', `a.status = 'preview'`]; const params: unknown[] = [schoolId];
    if (opts.ruleId) { where.push('a.rule_id = ?'); params.push(opts.ruleId); }
    const rows = await this.db.query<Row>(
      `SELECT a.id, a.rule_id, a.started_at, a.aggregate_type, a.aggregate_id, a.actions_result, r.code, r.name, r.module, r.preview_until
       FROM automation_runs a JOIN automation_rules r ON r.id = a.rule_id WHERE ${where.join(' AND ')}
       ORDER BY a.started_at DESC, a.id DESC LIMIT ${Math.min(500, opts.limit ?? 100)}`, params);
    return rows.map(r => ({
      id: s(r.id), ruleId: s(r.rule_id), code: s(r.code), name: s(r.name), module: s(r.module),
      startedAt: s(r.started_at), aggregateType: sn(r.aggregate_type), aggregateId: sn(r.aggregate_id), previewUntil: sn(r.preview_until),
      would: json<{ actions?: { type: string; would: string }[] }>(r.actions_result)?.actions ?? [],
    }));
  }

  // ---------- activity ----------
  /** The run log, filterable by rule and by day — the two questions anybody actually asks of it. */
  async runs(schoolId: string, f: { ruleId?: string; day?: string; status?: string; limit?: number } = {}): Promise<RunRow[]> {
    const where = ['a.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.ruleId) { where.push('a.rule_id = ?'); params.push(f.ruleId); }
    if (f.status) { where.push('a.status = ?'); params.push(f.status); }
    if (f.day) { where.push('a.started_at >= ? AND a.started_at <= ?'); params.push(`${f.day} 00:00:00`, `${f.day} 23:59:59`); }
    const rows = await this.db.query<Row>(
      `SELECT a.id, a.rule_id, a.started_at, a.finished_at, a.status, a.aggregate_type, a.aggregate_id, a.error, r.code, r.name, r.module
       FROM automation_runs a JOIN automation_rules r ON r.id = a.rule_id WHERE ${where.join(' AND ')}
       ORDER BY a.started_at DESC, a.id DESC LIMIT ${Math.min(500, f.limit ?? 100)}`, params);
    return rows.map(r => ({
      id: s(r.id), ruleId: s(r.rule_id), code: s(r.code), name: s(r.name), module: s(r.module),
      startedAt: s(r.started_at), finishedAt: sn(r.finished_at), status: s(r.status),
      aggregateType: sn(r.aggregate_type), aggregateId: sn(r.aggregate_id), error: sn(r.error),
    }));
  }
  /** Today at a glance: how much ran, how much broke, and how deep the queue is. */
  async activitySummary(schoolId: string, day = nowSql().slice(0, 10)) {
    const [runs, jobs] = await Promise.all([
      this.db.query<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM automation_runs WHERE school_id = ? AND started_at >= ? AND started_at <= ? GROUP BY status`, [schoolId, `${day} 00:00:00`, `${day} 23:59:59`]),
      this.db.query<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM background_jobs WHERE school_id = ? GROUP BY status`, [schoolId]),
    ]);
    const at = (rows: { status: string; n: number }[], k: string) => Number(rows.find(r => r.status === k)?.n ?? 0);
    return {
      day,
      ran: runs.reduce((a, r) => a + Number(r.n), 0),
      failed: at(runs, 'failed'),
      preview: at(runs, 'preview'),
      skipped: at(runs, 'skipped'),
      queued: at(jobs, 'queued') + at(jobs, 'running'),
      jobsFailed: at(jobs, 'failed'),
    };
  }

  // ---------- scheduled jobs ----------
  async scheduledJobs(schoolId: string): Promise<ScheduledJobRow[]> {
    const rows = await this.db.findMany<Row>('scheduled_jobs', { school_id: schoolId }, { orderBy: 'job_key ASC' });
    const now = nowSql();
    return rows.map(j => ({
      id: s(j.id), jobKey: s(j.job_key), cronExpr: s(j.cron_expr), timezone: s(j.timezone), isActive: b(j.is_active),
      nextRunAt: sn(j.next_run_at), lastRunAt: sn(j.last_run_at), lastStatus: sn(j.last_status), lastDurationMs: nn(j.last_duration_ms),
      overdue: b(j.is_active) && !!j.next_run_at && s(j.next_run_at) < now,
    }));
  }
  /**
   * "Run it now" is a nudge, not a second scheduler: the row's own `next_run_at` is pulled back to
   * this moment and the ordinary tick picks it up. That keeps the leader lock, the failure recording
   * and the next-run calculation in exactly one place — two ways of running a job is how a shared
   * host ends up running one twice.
   */
  async runJobNow(schoolId: string, jobKey: string) {
    const job = await this.db.findOne<Row>('scheduled_jobs', { school_id: schoolId, job_key: jobKey });
    if (!job) throw notFound('scheduled job');
    if (!b(job.is_active)) throw new HttpError(409, 'that job is switched off — switch it on first', 'inactive');
    await this.db.update('scheduled_jobs', { next_run_at: nowSql(), locked_until: null, updated_at: nowSql() }, { id: s(job.id) });
    await this.tick({ budgetMs: 20_000, maxJobs: 10 });
    const after = await this.db.findOne<Row>('scheduled_jobs', { id: s(job.id) });
    return { jobKey, lastRunAt: sn(after?.last_run_at), lastStatus: sn(after?.last_status), lastDurationMs: nn(after?.last_duration_ms) };
  }
  async setJobActive(schoolId: string, jobKey: string, active: boolean) {
    const changed = await this.db.update('scheduled_jobs', { is_active: active, updated_at: nowSql() }, { school_id: schoolId, job_key: jobKey });
    if (!changed) throw notFound('scheduled job');
    return { jobKey, active };
  }
  async backgroundJobs(schoolId: string, limit = 50): Promise<BackgroundJobRow[]> {
    const rows = await this.db.findMany<Row>('background_jobs', { school_id: schoolId }, { orderBy: 'created_at DESC', limit: Math.min(200, limit) });
    return rows.map(j => ({ id: s(j.id), jobName: s(j.job_name), queue: s(j.queue), status: s(j.status), attempts: n(j.attempts), progressPct: n(j.progress_pct), scheduledFor: sn(j.scheduled_for), error: sn(j.error) }));
  }

  // ---------- integrations ----------
  /**
   * Webhooks with the consecutive-failure count the relay already keeps, and the last deliveries.
   * The secret never leaves the server: what the console needs to know is that one is set, not what
   * it is, and a page that prints signing secrets is a page somebody screenshots into a chat group.
   */
  async webhooks(schoolId: string): Promise<WebhookRow[]> {
    const rows = await this.db.query<Row>(
      `SELECT w.id, w.url, w.event_types, w.is_active, w.failure_count,
        (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id) AS attempts,
        (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.delivered_at IS NOT NULL) AS delivered,
        (SELECT MAX(d.created_at) FROM webhook_deliveries d WHERE d.webhook_id = w.id) AS last_attempt_at
       FROM webhooks w WHERE w.school_id = ? ORDER BY w.created_at DESC`, [schoolId]);
    return rows.map(w => {
      const attempts = n(w.attempts), delivered = n(w.delivered);
      return { id: s(w.id), url: s(w.url), eventTypes: json<string[]>(w.event_types) ?? [], isActive: b(w.is_active), failureCount: n(w.failure_count), attempts, delivered, successPct: attempts ? Math.round(delivered * 1000 / attempts) / 10 : null, lastAttemptAt: sn(w.last_attempt_at) };
    });
  }
  async deliveries(schoolId: string, opts: { webhookId?: string; limit?: number } = {}): Promise<DeliveryRow[]> {
    const where = ['d.school_id = ?']; const params: unknown[] = [schoolId];
    if (opts.webhookId) { where.push('d.webhook_id = ?'); params.push(opts.webhookId); }
    const rows = await this.db.query<Row>(
      `SELECT d.id, d.webhook_id, d.event_uid, d.attempt, d.response_code, d.delivered_at, d.next_retry_at, d.created_at, w.url,
        SUBSTR(d.response_body, 1, 200) AS response_excerpt, e.event_type
       FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id LEFT JOIN outbox_events e ON e.event_uid = d.event_uid
       WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC, d.id DESC LIMIT ${Math.min(200, opts.limit ?? 50)}`, params);
    return rows.map(d => ({
      id: s(d.id), webhookId: s(d.webhook_id), url: s(d.url), eventUid: s(d.event_uid), eventType: sn(d.event_type),
      attempt: n(d.attempt), responseCode: nn(d.response_code), deliveredAt: sn(d.delivered_at), nextRetryAt: sn(d.next_retry_at),
      createdAt: s(d.created_at), responseExcerpt: sn(d.response_excerpt),
    }));
  }
  async setWebhookActive(schoolId: string, id: string, active: boolean) {
    // switching one back on forgives the run of failures that switched it off: the count is
    // consecutive, and a webhook nobody has called since the server was fixed has failed nothing yet
    const patch: Row = active ? { is_active: true, failure_count: 0, updated_at: nowSql() } : { is_active: false, updated_at: nowSql() };
    const changed = await this.db.update('webhooks', patch, { id, school_id: schoolId });
    if (!changed) throw notFound('webhook');
    return { id, active };
  }
}
