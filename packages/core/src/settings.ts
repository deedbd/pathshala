import type { Db } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { OutboxService } from './automation/outbox.js';
import { currentContext } from './context.js';

/** Per-school key/value settings (JSON values) with a small in-memory cache per process. */
export class SettingsService {
  private cache = new Map<string, { at: number; value: unknown }>();
  constructor(private db: Db, private outbox?: OutboxService, private ttlMs = 15_000) {}

  async get<T = unknown>(schoolId: string, key: string, fallback: T | null = null): Promise<T | null> {
    const ck = `${schoolId}:${key}`;
    const hit = this.cache.get(ck);
    if (hit && Date.now() - hit.at < this.ttlMs) return (hit.value ?? fallback) as T | null;
    const row = await this.db.findOne<{ value: unknown }>('settings', { school_id: schoolId, key_name: key });
    const value = row ? json<T>(row.value) : null;
    this.cache.set(ck, { at: Date.now(), value });
    return value ?? fallback;
  }

  async set(schoolId: string, key: string, value: unknown): Promise<void> {
    const before = await this.get(schoolId, key);
    const userId = currentContext()?.userId ?? null;
    await this.db.transaction(async tx => {
      const row = await tx.findOne<{ id: string }>('settings', { school_id: schoolId, key_name: key });
      // JSON columns need valid JSON even for scalars (MySQL rejects bare text), so always stringify here
      if (row) await tx.update('settings', { value: JSON.stringify(value ?? null), updated_by: userId, updated_at: nowSql() }, { id: row.id });
      else await tx.insert('settings', { id: ulid(), school_id: schoolId, key_name: key, value: JSON.stringify(value ?? null), updated_by: userId });
      if (this.outbox) await this.outbox.emit(tx, { type: 'settings.changed', schoolId, aggregateType: 'core.setting', aggregateId: row?.id ?? key, payload: { key, before, after: value } });
    });
    this.cache.delete(`${schoolId}:${key}`);
  }

  async all(schoolId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.findMany<{ key_name: string; value: unknown }>('settings', { school_id: schoolId });
    return Object.fromEntries(rows.map(r => [r.key_name, json(r.value)]));
  }
  invalidate(schoolId?: string) { for (const k of this.cache.keys()) if (!schoolId || k.startsWith(schoolId + ':')) this.cache.delete(k); }
}
