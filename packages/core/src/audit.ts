import type { Db, Row } from '@pathshala/db';
import { nowSql, ulid } from '@pathshala/db';
import { currentContext } from './context.js';

export interface AuditEntry {
  action: string;               // create | update | delete | login | logout | settings | install | …
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  schoolId?: string;
  actorUserId?: string | null;
  actorType?: 'user' | 'system' | 'automation' | 'api';
}

/** Append-only audit log. Uses the request context for actor/tenant/ip when not given. */
export class AuditService {
  constructor(private db: Db) {}
  async log(e: AuditEntry, tx: Db = this.db): Promise<void> {
    const ctx = currentContext();
    const schoolId = e.schoolId ?? ctx?.schoolId;
    if (!schoolId) return; // nothing to attribute to; platform-level events are logged by the logger
    await tx.insert('audit_logs', {
      id: ulid(), school_id: schoolId, actor_user_id: e.actorUserId ?? ctx?.userId ?? null, actor_type: e.actorType ?? ctx?.actorType ?? (ctx?.userId ? 'user' : 'system'),
      action: e.action.slice(0, 40), entity_type: e.entityType.slice(0, 60), entity_id: e.entityId ?? null,
      before_data: (e.before ?? null) as Row, after_data: (e.after ?? null) as Row,
      ip: ctx?.ip ?? null, user_agent: ctx?.userAgent?.slice(0, 255) ?? null, request_id: ctx?.requestId?.slice(0, 64) ?? null, created_at: nowSql(),
    });
  }
  async recent(schoolId: string, limit = 50) {
    return this.db.findMany('audit_logs', { school_id: schoolId }, { orderBy: 'created_at DESC', limit });
  }
}
