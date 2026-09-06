import type { Db } from '@pathshala/db';
import { ulid } from '@pathshala/db';

/**
 * Per-school document numbers (admission_no, employee_no, invoice_no…) from `number_sequences`.
 * Atomic on every engine: an UPDATE guarded by the value we read, retried on contention.
 */
export class NumberingService {
  constructor(private db: Db) {}

  async next(schoolId: string, key: string, opts: { prefix?: string; padding?: number; resetYearly?: boolean; year?: number } = {}, tx: Db = this.db): Promise<string> {
    const year = String(opts.year ?? new Date().getFullYear());
    for (let attempt = 0; attempt < 10; attempt++) {
      let row = await tx.findOne<{ id: string; prefix: string; next_value: number; padding: number; reset_yearly: unknown; year_tag: string | null }>('number_sequences', { school_id: schoolId, key_name: key });
      if (!row) {
        try { await tx.insert('number_sequences', { id: ulid(), school_id: schoolId, key_name: key, prefix: opts.prefix ?? '', next_value: 1, padding: opts.padding ?? 6, reset_yearly: !!opts.resetYearly, year_tag: opts.resetYearly ? year : null }); }
        catch { /* raced with another writer */ }
        continue;
      }
      let value = Number(row.next_value);
      let yearTag = row.year_tag;
      if (Number(row.reset_yearly) && yearTag !== year) { value = 1; yearTag = year; }
      const n = await tx.execute(`UPDATE number_sequences SET next_value = ?, year_tag = ? WHERE id = ? AND next_value = ?`, [value + 1, yearTag, row.id, row.next_value]);
      if (n.affectedRows !== 1) continue;
      const num = String(value).padStart(Number(row.padding) || 0, '0');
      return `${row.prefix ?? ''}${Number(row.reset_yearly) ? `${yearTag}-` : ''}${num}`;
    }
    throw new Error(`could not allocate number for ${key}`);
  }
}
