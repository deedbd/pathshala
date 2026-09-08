import type { Db } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { OutboxService } from './automation/outbox.js';
import { currentContext, notFound } from './context.js';

export interface ApprovalStep { role?: string; userId?: string; label?: string }

/**
 * Approval requests driven by `approval_workflows.steps` (JSON: [{role:'principal'},{role:'accountant'}]).
 * No matching active workflow → auto-approved (so a school can start without configuring anything).
 */
export class ApprovalService {
  constructor(private db: Db, private outbox: OutboxService) {}

  async request(input: { schoolId: string; entityType: string; entityId: string; summary?: Record<string, unknown>; workflowId?: string; dueInHours?: number }, tx?: Db) {
    const run = async (t: Db) => {
      let wf = input.workflowId
        ? await t.findOne<Record<string, unknown>>('approval_workflows', { id: input.workflowId, school_id: input.schoolId })
        : await t.findOne<Record<string, unknown>>('approval_workflows', { school_id: input.schoolId, entity_type: input.entityType, is_active: true });
      let auto = false;
      if (!wf) { // keep an audit trail even when nothing is configured: a per-entity "auto-approve" workflow with no steps
        const wfId = ulid();
        await t.insert('approval_workflows', { id: wfId, school_id: input.schoolId, entity_type: input.entityType, name: `Auto-approve (${input.entityType})`, conditions: null, steps: [], auto_approve_after_hours: 0, escalate_after_hours: null, is_active: true });
        wf = { id: wfId, steps: [], escalate_after_hours: null }; auto = true;
      }
      const id = ulid();
      const steps = json<ApprovalStep[]>(wf.steps) ?? [];
      if (!steps.length) auto = true;
      const status = auto ? 'approved' : 'pending';
      const due = input.dueInHours ?? (Number(wf.escalate_after_hours) || 48);
      await t.insert('approval_requests', {
        id, school_id: input.schoolId, workflow_id: String(wf.id), entity_type: input.entityType, entity_id: input.entityId, requested_by: currentContext()?.userId ?? null,
        current_step: 1, status, summary: input.summary ?? null, due_at: auto ? null : nowSql(new Date(Date.now() + due * 3600_000)),
      });
      if (auto) {
        await t.insert('approval_actions', { id: ulid(), school_id: input.schoolId, request_id: id, step: 1, actor_id: null, decision: 'auto_approved', comment: 'no workflow configured', acted_at: nowSql() });
        await this.outbox.emit(t, { type: 'approval.decided', schoolId: input.schoolId, aggregateType: 'platform.approval', aggregateId: id, payload: { requestId: id, decision: 'auto_approved', entityType: input.entityType, entityId: input.entityId } });
      } else {
        await this.outbox.emit(t, { type: 'approval.requested', schoolId: input.schoolId, aggregateType: 'platform.approval', aggregateId: id, payload: { requestId: id, entityType: input.entityType, entityId: input.entityId, step: 1, summary: input.summary ? JSON.stringify(input.summary).slice(0, 200) : null } });
      }
      return { id, status, steps };
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  async decide(requestId: string, schoolId: string, decision: 'approved' | 'rejected', comment?: string) {
    return this.db.transaction(async t => {
      const req = await t.findOne<Record<string, unknown>>('approval_requests', { id: requestId, school_id: schoolId });
      if (!req) throw notFound('approval request');
      if (req.status !== 'pending' && req.status !== 'escalated') return { status: req.status as string };
      const wf = req.workflow_id ? await t.findOne<Record<string, unknown>>('approval_workflows', { id: req.workflow_id as string }) : null;
      const steps = wf ? json<ApprovalStep[]>(wf.steps) ?? [] : [];
      const step = Number(req.current_step);
      await t.insert('approval_actions', { id: ulid(), school_id: schoolId, request_id: requestId, step, actor_id: currentContext()?.userId ?? null, decision, comment: comment ?? null, acted_at: nowSql() });
      const final = decision === 'rejected' || step >= steps.length;
      const status = decision === 'rejected' ? 'rejected' : final ? 'approved' : 'pending';
      await t.update('approval_requests', { status, current_step: final ? step : step + 1, updated_at: nowSql() }, { id: requestId });
      if (final) await this.outbox.emit(t, { type: 'approval.decided', schoolId, aggregateType: 'platform.approval', aggregateId: requestId, payload: { requestId, decision, entityType: String(req.entity_type), entityId: String(req.entity_id) } });
      else await this.outbox.emit(t, { type: 'approval.requested', schoolId, aggregateType: 'platform.approval', aggregateId: requestId, payload: { requestId, entityType: String(req.entity_type), entityId: String(req.entity_id), step: step + 1, summary: null } });
      return { status };
    });
  }

  async pending(schoolId: string, limit = 50) { return this.db.findMany('approval_requests', { school_id: schoolId, status: 'pending' }, { orderBy: 'created_at DESC', limit }); }

  /**
   * Who is waiting for a decision, in a shape a dashboard can print: the entity in words, whatever
   * the requester put in the summary, and the name of the person who asked. The count is the whole
   * queue even though only the first few are listed — a card that says "6 waiting" when there are
   * thirty is worse than no card.
   */
  async pendingSummary(schoolId: string, limit = 6) {
    const [total, rows] = await Promise.all([
      this.db.count('approval_requests', { school_id: schoolId, status: 'pending' }),
      this.db.query<Record<string, unknown>>(`SELECT a.id, a.entity_type, a.entity_id, a.summary, a.created_at, u.display_name AS requested_by
        FROM approval_requests a LEFT JOIN users u ON u.id = a.requested_by
        WHERE a.school_id = ? AND a.status = 'pending' ORDER BY a.created_at DESC, a.id DESC LIMIT ?`, [schoolId, limit]),
    ]);
    return {
      total,
      items: rows.map(r => {
        const summary = json<Record<string, unknown>>(r.summary) ?? {};
        const detail = Object.entries(summary)
          .filter(([, v]) => v != null && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
          .map(([k, v]) => `${k}: ${v}`).join(' · ');
        return {
          id: String(r.id), kind: String(r.entity_type),
          title: String(r.entity_type).replace(/[._]/g, ' '),
          detail: detail ? detail.slice(0, 160) : null,
          requestedBy: r.requested_by == null ? null : String(r.requested_by),
          at: String(r.created_at),
        };
      }),
    };
  }
}
