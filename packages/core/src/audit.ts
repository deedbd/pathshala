import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
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

  /**
   * The log as a person reads it: filtered, paged, with the actor's name beside their id.
   *
   * `created_at` is second-precision on every engine, so a burst of writes inside one second sorts
   * arbitrarily unless the order is tie-broken — `id` is a ULID, which is already time-ordered.
   * Every filter is an exact match; `from`/`to` are whole days in the stored UTC.
   */
  async search(schoolId: string, f: AuditFilter = {}): Promise<{ rows: AuditRow[]; total: number; page: number; pageSize: number; actions: string[]; entityTypes: string[] }> {
    const where: string[] = ['a.school_id = ?'];
    const params: unknown[] = [schoolId];
    if (f.entityType) { where.push('a.entity_type = ?'); params.push(f.entityType); }
    if (f.entityId) { where.push('a.entity_id = ?'); params.push(f.entityId); }
    if (f.action) { where.push('a.action = ?'); params.push(f.action); }
    if (f.actorUserId) { where.push('a.actor_user_id = ?'); params.push(f.actorUserId); }
    if (f.actorType) { where.push('a.actor_type = ?'); params.push(f.actorType); }
    if (f.from) { where.push('a.created_at >= ?'); params.push(`${f.from} 00:00:00`); }
    if (f.to) { where.push('a.created_at <= ?'); params.push(`${f.to} 23:59:59`); }
    const sql = where.join(' AND ');
    const pageSize = Math.min(Math.max(Number(f.pageSize) || 50, 1), 200);
    const page = Math.max(Number(f.page) || 0, 0);
    const [rows, counted, actions, entityTypes] = await Promise.all([
      this.db.query<AuditRow>(
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.actor_user_id, a.actor_type, a.ip, a.request_id, a.created_at, a.before_data, a.after_data, u.display_name AS actor_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE ${sql} ORDER BY a.created_at DESC, a.id DESC LIMIT ${pageSize} OFFSET ${page * pageSize}`, params),
      this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs a WHERE ${sql}`, params),
      this.db.query<{ v: string }>(`SELECT DISTINCT action AS v FROM audit_logs WHERE school_id = ? ORDER BY v ASC`, [schoolId]),
      this.db.query<{ v: string }>(`SELECT DISTINCT entity_type AS v FROM audit_logs WHERE school_id = ? ORDER BY v ASC`, [schoolId]),
    ]);
    // SQLite hands a JSON column back as text where MySQL and Postgres hand back the parsed object;
    // the console has to be able to read `before`/`after` the same way on all three
    const parsed = rows.map(r => ({ ...r, before_data: json(r.before_data), after_data: json(r.after_data) }));
    return { rows: parsed, total: Number(counted[0]?.n ?? 0), page, pageSize, actions: actions.map(r => String(r.v)), entityTypes: entityTypes.map(r => String(r.v)) };
  }
}

export interface AuditFilter {
  entityType?: string | null; entityId?: string | null; action?: string | null;
  actorUserId?: string | null; actorType?: string | null;
  from?: string | null; to?: string | null;      // 'YYYY-MM-DD', inclusive
  page?: number; pageSize?: number;
}

export interface AuditRow {
  id: string; action: string; entity_type: string; entity_id: string | null;
  actor_user_id: string | null; actor_type: string; actor_name: string | null;
  ip: string | null; request_id: string | null; created_at: string;
  before_data: unknown; after_data: unknown;
}
