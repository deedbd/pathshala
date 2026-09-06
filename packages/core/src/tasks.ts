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

  async complete(id: string, schoolId: string) {
    return this.db.update('tasks', { status: 'done', completed_at: nowSql(), updated_at: nowSql() }, { id, school_id: schoolId });
  }
  async open(schoolId: string, opts: { assignedTo?: string; assignedRole?: string; limit?: number } = {}) {
    const where: Record<string, unknown> = { school_id: schoolId, status: 'open' };
    if (opts.assignedTo) where.assigned_to = opts.assignedTo;
    if (opts.assignedRole) where.assigned_role = opts.assignedRole;
    return this.db.findMany('tasks', where as never, { orderBy: 'due_at ASC', limit: opts.limit ?? 50 });
  }
}
