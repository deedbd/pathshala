import type { Db } from '@pathshala/db';
import { nowSql, ulid } from '@pathshala/db';
import type { OutboxService } from './automation/outbox.js';
import { currentContext } from './context.js';

export interface CreateTaskInput {
  schoolId: string; title: string; description?: string | null; taskType?: string | null;
  assignedTo?: string | null; assignedRole?: string | null; entityType?: string | null; entityId?: string | null;
  dueAt?: Date | string | null; priority?: 'low' | 'normal' | 'high' | 'urgent'; createdBy?: string;
}

/** Tasks created by people or by automation (rule actions, approvals, reminders). */
export class TaskService {
  constructor(private db: Db, private outbox: OutboxService) {}

  async create(input: CreateTaskInput, tx?: Db): Promise<string> {
    const run = async (t: Db) => {
      const id = ulid();
      const dueAt = input.dueAt ? (typeof input.dueAt === 'string' ? input.dueAt : nowSql(input.dueAt)) : null;
      await t.insert('tasks', {
        id, school_id: input.schoolId, title: input.title.slice(0, 200), description: input.description ?? null, task_type: input.taskType ?? null,
        assigned_to: input.assignedTo ?? null, assigned_role: input.assignedRole ?? null, entity_type: input.entityType ?? null, entity_id: input.entityId ?? null,
        due_at: dueAt, priority: input.priority ?? 'normal', status: 'open', created_by: input.createdBy ?? currentContext()?.userId ?? 'system',
      });
      await this.outbox.emit(t, { type: 'task.created', schoolId: input.schoolId, aggregateType: 'platform.task', aggregateId: id, payload: { taskId: id, title: input.title, assignedTo: input.assignedTo ?? null, assignedRole: input.assignedRole ?? null, dueAt } });
      return id;
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  /**
   * The same task, raised once and not once a night. A daily watch that finds the same contract
   * expiring, the same asset overdue for service or the same shelf empty must not leave thirty
   * identical rows behind it — so a task that is still open for the same thing is reused, and a new
   * one is only written after somebody has closed the last.
   *
   * Returns the id of the task it created, or `null` when one was already open.
   */
  async ensure(input: CreateTaskInput & { entityType: string; entityId: string }, tx?: Db): Promise<string | null> {
    const where: Record<string, unknown> = { school_id: input.schoolId, entity_type: input.entityType, entity_id: input.entityId, status: 'open' };
    if (input.taskType) where.task_type = input.taskType;
    const open = await (tx ?? this.db).findOne('tasks', where as never);
    if (open) return null;
    return this.create(input, tx);
  }

  async complete(id: string, schoolId: string) {
    return this.db.update('tasks', { status: 'done', completed_at: nowSql(), updated_at: nowSql() }, { id, school_id: schoolId });
  }
  async open(schoolId: string, opts: { assignedTo?: string; assignedRole?: string; limit?: number } = {}) {
    const where: Record<string, unknown> = { school_id: schoolId, status: 'open' };
    if (opts.assignedTo) where.assigned_to = opts.assignedTo;
    if (opts.assignedRole) where.assigned_role = opts.assignedRole;
    return this.db.findMany('tasks', where as never, { orderBy: 'due_at ASC', limit: opts.limit ?? 50 });
  }

  /**
   * The open list a dashboard prints: the most pressing few, with the count of the whole queue
   * beside them. Priority is a word, so it is ordered by what the words mean rather than by the
   * alphabet — sorting `priority ASC` would put "high" above "urgent" and "low" above both. A task
   * with no date sorts after the dated ones on every engine, because the three of them disagree
   * about where NULLs belong.
   */
  async openSummary(schoolId: string, limit = 6) {
    const [total, rows] = await Promise.all([
      this.db.count('tasks', { school_id: schoolId, status: 'open' }),
      this.db.query<Record<string, unknown>>(`SELECT t.id, t.title, t.due_at, t.priority, t.assigned_role, u.display_name AS assignee
        FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to WHERE t.school_id = ? AND t.status = 'open'
        ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END ASC,
                 CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END ASC, t.due_at ASC, t.id ASC LIMIT ?`, [schoolId, limit]),
    ]);
    return {
      total,
      items: rows.map(r => ({
        id: String(r.id), title: String(r.title),
        assignee: r.assignee != null ? String(r.assignee) : r.assigned_role != null ? String(r.assigned_role) : null,
        due: r.due_at == null ? null : String(r.due_at),
        priority: String(r.priority),
      })),
    };
  }
}
