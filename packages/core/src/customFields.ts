import type { Db } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';

export interface CustomFieldDef {
  entityType: string; fieldKey: string; label: string; labelBn?: string | null;
  fieldType: 'text' | 'number' | 'date' | 'select' | 'multiselect' | 'bool' | 'file' | 'phone';
  options?: string[] | null; isRequired?: boolean; sortOrder?: number; showInList?: boolean;
}

/** School-defined extra fields on any entity (students, staff, …) stored in `custom_field_values`. */
export class CustomFieldService {
  constructor(private db: Db) {}

  async define(schoolId: string, d: CustomFieldDef) {
    const existing = await this.db.findOne<{ id: string }>('custom_fields', { school_id: schoolId, entity_type: d.entityType, field_key: d.fieldKey });
    const row = { label: d.label, label_bn: d.labelBn ?? null, field_type: d.fieldType, options: d.options ?? null, is_required: !!d.isRequired, sort_order: d.sortOrder ?? 0, show_in_list: !!d.showInList };
    if (existing) { await this.db.update('custom_fields', { ...row, updated_at: nowSql() } as never, { id: existing.id }); return existing.id; }
    const id = ulid();
    await this.db.insert('custom_fields', { id, school_id: schoolId, entity_type: d.entityType, field_key: d.fieldKey, ...row } as never);
    return id;
  }

  async listFor(schoolId: string, entityType: string) {
    const rows = await this.db.findMany<Record<string, unknown>>('custom_fields', { school_id: schoolId, entity_type: entityType }, { orderBy: 'sort_order ASC' });
    return rows.map(r => ({ id: String(r.id), fieldKey: String(r.field_key), label: String(r.label), labelBn: r.label_bn as string | null, fieldType: String(r.field_type), options: json<string[]>(r.options) ?? [], isRequired: !!r.is_required, showInList: !!r.show_in_list }));
  }

  async setValues(schoolId: string, entityType: string, entityId: string, values: Record<string, unknown>) {
    const defs = await this.listFor(schoolId, entityType);
    await this.db.transaction(async tx => {
      for (const def of defs) {
        if (!(def.fieldKey in values)) continue;
        if (def.isRequired && (values[def.fieldKey] == null || values[def.fieldKey] === '')) throw new Error(`custom field ${def.fieldKey} is required`);
        const ex = await tx.findOne<{ id: string }>('custom_field_values', { school_id: schoolId, field_id: def.id, entity_id: entityId });
        if (ex) await tx.update('custom_field_values', { value: JSON.stringify(values[def.fieldKey] ?? null) }, { id: ex.id });
        else await tx.insert('custom_field_values', { id: ulid(), school_id: schoolId, field_id: def.id, entity_id: entityId, value: JSON.stringify(values[def.fieldKey] ?? null) });
      }
    });
  }

  async getValues(schoolId: string, entityType: string, entityId: string): Promise<Record<string, unknown>> {
    const rows = await this.db.query<{ field_key: string; value: unknown }>(
      `SELECT f.field_key, v.value FROM custom_field_values v JOIN custom_fields f ON f.id = v.field_id WHERE v.school_id = ? AND f.entity_type = ? AND v.entity_id = ?`, [schoolId, entityType, entityId]);
    return Object.fromEntries(rows.map(r => [r.field_key, json(r.value)]));
  }
}
