import jsonLogic from 'json-logic-js';
import type { Db } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters, Logger } from '@pathshala/adapters';
import type { EventEnvelope } from '@pathshala/events';
import type { RuleAction } from '@pathshala/schemas';
import type { NotificationService } from '../notifications.js';
import type { TaskService } from '../tasks.js';
import type { ApprovalService } from '../approvals.js';
import type { OutboxService } from './outbox.js';
import { hmac, renderTemplate } from '../util.js';

export interface RuleRow {
  id: string; school_id: string; code: string; name: string; module: string; trigger_kind: string; event_type: string | null;
  conditions: unknown; actions: unknown; is_active: unknown; preview_until: string | null; priority: number; cooldown_minutes: number | null; run_count: number; last_run_at: string | null;
}

/**
 * Rule engine (⚙️ rows): for each active rule matching the event type, evaluate JSONLogic conditions
 * against { event, payload, school, now } and run the actions. Every run is recorded in `automation_runs`
 * (Admin → Automation → Activity). Preview window → recorded, not executed. Cooldown per rule+aggregate.
 * After 3 consecutive failures a `rule.failed` event alerts the school admin.
 */
export class RuleEngine {
  constructor(private db: Db, private adapters: Adapters, private deps: { notifications: NotificationService; tasks: TaskService; approvals: ApprovalService; outbox: OutboxService; log: Logger; appKey: string }) {}

  async handle(event: EventEnvelope): Promise<number> {
    const rules = await this.db.query<RuleRow>(
      `SELECT * FROM automation_rules WHERE school_id = ? AND is_active = 1 AND trigger_kind = 'event' AND event_type = ? ORDER BY priority ASC, code ASC`, [event.schoolId, event.type]);
    let ran = 0;
    for (const rule of rules) { if (await this.runRule(rule, event)) ran++; }
    return ran;
  }

  async runRule(rule: RuleRow, event: EventEnvelope, opts: { manual?: boolean } = {}): Promise<boolean> {
    const runId = ulid();
    const started = nowSql();
    const conditions = json<unknown>(rule.conditions);
    const school = await this.db.findOne<Record<string, unknown>>('schools', { id: rule.school_id });
    const data = { event: { type: event.type, aggregateType: event.aggregateType, aggregateId: event.aggregateId, actorUserId: event.actorUserId, occurredAt: event.occurredAt }, payload: event.payload, school: { id: rule.school_id, name: school?.name, type: school?.institution_type, locale: school?.locale }, now: started };

    // conditions: JSONLogic object → evaluate; `{note: "..."}` (seeded from docs) → treated as "no machine condition"
    let matched = true;
    if (conditions && typeof conditions === 'object' && !('note' in (conditions as object))) {
      try { matched = !!jsonLogic.apply(conditions as never, data); } catch (e) { matched = false; this.deps.log.warn(`rule ${rule.code} condition error: ${(e as Error).message}`); }
    }
    if (!matched) return false;

    // cooldown per rule + aggregate
    if (rule.cooldown_minutes && !opts.manual) {
      const since = nowSql(new Date(Date.now() - Number(rule.cooldown_minutes) * 60_000));
      const recent = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM automation_runs WHERE rule_id = ? AND aggregate_id = ? AND started_at >= ? AND status IN ('success','preview')`, [rule.id, event.aggregateId, since]);
      if (Number(recent[0]?.n) > 0) { await this.record(runId, rule, event, 'skipped', { reason: 'cooldown' }); return false; }
    }
    const preview = !!rule.preview_until && rule.preview_until > started && !opts.manual;
    const actions = (json<RuleAction[]>(rule.actions) ?? []).filter(a => a && typeof a === 'object');
    if (preview) { await this.record(runId, rule, event, 'preview', { actions: actions.map(a => a.type) }); return false; }

    const results: unknown[] = [];
    try {
      for (const action of actions) results.push(await this.runAction(action, rule, event, data));
      await this.record(runId, rule, event, 'success', { results });
      await this.db.execute(`UPDATE automation_rules SET run_count = run_count + 1, last_run_at = ? WHERE id = ?`, [nowSql(), rule.id]);
      return true;
    } catch (e) {
      const err = e as Error;
      await this.record(runId, rule, event, 'failed', { results }, err.message);
      this.deps.log.error(`rule ${rule.code} failed`, err);
      const fails = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM automation_runs WHERE rule_id = ? AND status = 'failed' AND started_at >= ?`, [rule.id, nowSql(new Date(Date.now() - 86_400_000))]);
      if (Number(fails[0]?.n) >= 3) await this.deps.outbox.emitNow({ type: 'rule.failed', schoolId: rule.school_id, aggregateType: 'platform.rule', aggregateId: rule.id, payload: { ruleId: rule.id, ruleCode: rule.code, attempts: Number(fails[0]?.n), error: err.message.slice(0, 500) } });
      return false;
    }
  }

  private async runAction(a: RuleAction, rule: RuleRow, event: EventEnvelope, data: Record<string, unknown>): Promise<unknown> {
    const sid = rule.school_id;
    const payload = event.payload as Record<string, unknown>;
    switch (a.type) {
      case 'notify': {
        const channels = a.channel ? [a.channel] : (['push', 'in_app'] as const);
        const base = { channels: [...channels], eventKey: a.eventKey ?? `rule.${rule.code.toLowerCase()}`, data: { ...payload, rule: rule.name }, title: a.title ? renderTemplate(a.title, data) : rule.name, body: a.body ? renderTemplate(a.body, data) : (a.note ?? rule.name), entityType: event.aggregateType, entityId: event.aggregateId };
        if (a.to === 'user' && a.userId) return { type: 'notify', ids: await this.deps.notifications.notify({ ...base, schoolId: sid, userId: a.userId }) };
        if (a.to === 'actor' && event.actorUserId) return { type: 'notify', ids: await this.deps.notifications.notify({ ...base, schoolId: sid, userId: event.actorUserId }) };
        if (a.to === 'guardians' && typeof payload.guardianUserIds === 'object') { const ids: string[] = []; for (const u of payload.guardianUserIds as string[]) ids.push(...await this.deps.notifications.notify({ ...base, schoolId: sid, userId: u })); return { type: 'notify', ids }; }
        return { type: 'notify', ids: await this.deps.notifications.notifyRole(sid, a.to === 'role' && a.role ? a.role : 'admin', base) };
      }
      case 'task': {
        const id = await this.deps.tasks.create({ schoolId: sid, title: renderTemplate(a.title, data), assignedRole: a.assignedRole ?? null, assignedTo: a.assignedTo ?? null, dueAt: a.dueInHours ? new Date(Date.now() + a.dueInHours * 3600_000) : null, priority: a.priority, entityType: event.aggregateType, entityId: event.aggregateId, taskType: 'automation', createdBy: `rule:${rule.code}` });
        return { type: 'task', id };
      }
      case 'job': return { type: 'job', id: await this.adapters.queue.push({ name: a.name, queue: a.queue ?? 'default', schoolId: sid, payload: { ...(a.payload ?? {}), event: { type: event.type, aggregateId: event.aggregateId, payload }, ruleCode: rule.code }, triggeredBy: `rule:${rule.code}` }) };
      case 'webhook': {
        const body = JSON.stringify({ event, rule: { code: rule.code, name: rule.name } });
        const res = await fetch(a.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pathshala-Signature': hmac(this.deps.appKey, body) }, body, signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`webhook ${a.url} → ${res.status}`);
        return { type: 'webhook', status: res.status };
      }
      case 'approval': return { type: 'approval', ...(await this.deps.approvals.request({ schoolId: sid, entityType: a.entityType, entityId: event.aggregateId, workflowId: a.workflowId, summary: { rule: rule.code, event: event.type } })) };
      case 'emit': return { type: 'emit', uid: (await this.deps.outbox.emitNow({ type: a.eventType as never, schoolId: sid, aggregateType: event.aggregateType, aggregateId: event.aggregateId, payload: { ...(a.payload ?? {}), source: rule.code } as never })).uid };
      case 'document': return { type: 'document', skipped: `document templates ship with the documents module (${a.template})` };
      default: return { type: (a as { type: string }).type, skipped: 'unknown action type' };
    }
  }

  private async record(id: string, rule: RuleRow, event: EventEnvelope, status: 'running' | 'success' | 'failed' | 'skipped' | 'preview', result: unknown, error?: string) {
    await this.db.insert('automation_runs', { id, school_id: rule.school_id, rule_id: rule.id, trigger_event_uid: event.uid, aggregate_type: event.aggregateType, aggregate_id: event.aggregateId, started_at: nowSql(), finished_at: nowSql(), status, actions_result: result as never, error: error ?? null });
    this.adapters.realtime.publish(`school:${rule.school_id}:automation`, 'run', { id, rule: rule.code, status });
  }
}
