import type { Db, Row } from '@pathshala/db';
import { ulid } from '@pathshala/db';
import { badRequest, notFound } from '../context.js';

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

  /** Every sequence this school has, with a worked example of the next number it would hand out. */
  async sequences(schoolId: string): Promise<SequenceRow[]> {
    const rows = await this.db.findMany<Row>('number_sequences', { school_id: schoolId }, { orderBy: 'key_name ASC' });
    return rows.map(r => {
      const resetYearly = !!Number(r.reset_yearly);
      const year = String(new Date().getUTCFullYear());
      // a yearly sequence whose tag is last year's restarts at 1 on its next call, so say so
      const next = resetYearly && r.year_tag !== year ? 1 : Number(r.next_value);
      return {
        id: String(r.id), key: String(r.key_name), prefix: String(r.prefix ?? ''), nextValue: Number(r.next_value),
        padding: Number(r.padding) || 0, resetYearly, yearTag: (r.year_tag as string) ?? null,
        issued: Math.max(Number(r.next_value) - 1, 0),
        example: format(String(r.prefix ?? ''), next, Number(r.padding) || 0, resetYearly ? year : null),
      };
    });
  }

  /**
   * Change how a sequence reads, and where it goes next.
   *
   * The one thing refused is moving `next_value` backwards: every number below it is already on a
   * receipt or an admission form somebody is holding, and handing the same one out twice puts two
   * documents under one number. Moving it forward is allowed — that is how a school carries on from
   * the last number its old register used.
   */
  async updateSequence(schoolId: string, id: string, patch: { prefix?: string; padding?: number; nextValue?: number; resetYearly?: boolean }) {
    const row = await this.db.findOne<Row>('number_sequences', { id, school_id: schoolId });
    if (!row) throw notFound('sequence');
    const set: Row = {};
    if (patch.prefix !== undefined) set.prefix = patch.prefix.slice(0, 20);
    if (patch.padding !== undefined) {
      if (patch.padding < 0 || patch.padding > 12) throw badRequest('padding is between 0 and 12 digits');
      set.padding = Math.floor(patch.padding);
    }
    if (patch.nextValue !== undefined) {
      const current = Number(row.next_value);
      const issued = Math.max(current - 1, 0);
      if (patch.nextValue < current) throw badRequest(`${row.key_name} has already issued up to ${issued}; the next number cannot go below ${current} without giving two documents the same number`);
      if (patch.nextValue > 1e12) throw badRequest('that number is too large to be a document number');
      set.next_value = Math.floor(patch.nextValue);
    }
    if (patch.resetYearly !== undefined) {
      set.reset_yearly = patch.resetYearly;
      // turning the yearly reset on has to claim the current year, or the very next call restarts at 1
      set.year_tag = patch.resetYearly ? String(new Date().getUTCFullYear()) : null;
    }
    if (!Object.keys(set).length) return { updated: 0 };
    const updated = await this.db.update('number_sequences', set, { id, school_id: schoolId });
    return { updated, before: { prefix: String(row.prefix ?? ''), padding: Number(row.padding) || 0, nextValue: Number(row.next_value), resetYearly: !!Number(row.reset_yearly) }, key: String(row.key_name) };
  }
}

export interface SequenceRow {
  id: string; key: string; prefix: string; nextValue: number; padding: number;
  resetYearly: boolean; yearTag: string | null; issued: number; example: string;
}

const format = (prefix: string, value: number, padding: number, yearTag: string | null) => `${prefix}${yearTag ? `${yearTag}-` : ''}${String(value).padStart(padding, '0')}`;
