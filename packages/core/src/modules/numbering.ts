import type { Db } from '@pathshala/db';
import { ulid } from '@pathshala/db';

/**
 * Per-school document numbers (admission_no, employee_no, invoice_no…) from `number_sequences`.
 *
 * The sequence is bumped first and read afterwards. That order matters inside a transaction: MySQL's
 * REPEATABLE READ gives a plain SELECT the snapshot taken when the transaction began, so a row another
 * connection committed since then stays invisible to the read yet still collides on the unique key. An
 * UPDATE always sees the latest committed row and locks it, so this both finds the row and serialises
 * two callers racing for the same number — on SQLite, MySQL and Postgres alike.
 */
export class NumberingService {
  constructor(private db: Db) {}

  async next(schoolId: string, key: string, opts: { prefix?: string; padding?: number; resetYearly?: boolean; year?: number } = {}, tx: Db = this.db): Promise<string> {
    const year = String(opts.year ?? new Date().getFullYear());
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const bumped = await tx.execute(`UPDATE number_sequences SET next_value = next_value + 1 WHERE school_id = ? AND key_name = ?`, [schoolId, key]);
      if (bumped.affectedRows !== 1) {
        // no sequence yet: create it already used once (next_value 2) and take number 1
        try {
          // fenced with a savepoint: losing this race must not abort the transaction around it
          await tx.attempt(() => tx.insert('number_sequences', { id: ulid(), school_id: schoolId, key_name: key, prefix: opts.prefix ?? '', next_value: 2, padding: opts.padding ?? 6, reset_yearly: !!opts.resetYearly, year_tag: opts.resetYearly ? year : null }));
          return format(opts.prefix ?? '', 1, opts.padding ?? 6, opts.resetYearly ? year : null);
        } catch (e) { lastError = e; continue; }        // another writer created it first — bump it on the next pass
      }
      const row = (await tx.findOne<{ id: string; prefix: string; next_value: number; padding: number; reset_yearly: unknown; year_tag: string | null }>('number_sequences', { school_id: schoolId, key_name: key }))!;
      let value = Number(row.next_value) - 1;
      let yearTag = row.year_tag;
      if (Number(row.reset_yearly) && yearTag !== year) {  // a new year restarts the run
        value = 1; yearTag = year;
        await tx.execute(`UPDATE number_sequences SET next_value = ?, year_tag = ? WHERE id = ?`, [2, year, row.id]);
      }
      return format(String(row.prefix ?? ''), value, Number(row.padding) || 0, Number(row.reset_yearly) ? yearTag : null);
    }
    throw new Error(`could not allocate number for ${key}${lastError ? `: ${(lastError as Error).message}` : ''}`);
  }
}

const format = (prefix: string, value: number, padding: number, yearTag: string | null) => `${prefix}${yearTag ? `${yearTag}-` : ''}${String(value).padStart(padding, '0')}`;
