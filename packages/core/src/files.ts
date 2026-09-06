import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Db } from '@pathshala/db';
import { ulid } from '@pathshala/db';
import type { StorageAdapter } from '@pathshala/adapters';
import type { OutboxService } from './automation/outbox.js';
import { currentContext, notFound } from './context.js';
import { sha256 } from './util.js';

export interface StoreFileInput {
  schoolId: string; data: Buffer | Readable; fileName: string; mimeType: string;
  purpose?: string; entityType?: string; entityId?: string; visibility?: 'private' | 'school' | 'public'; width?: number; height?: number;
}

/** Files live on disk (or S3) under `<school>/<yyyy>/<mm>/`; metadata in `files`. */
export class FileService {
  constructor(private db: Db, private storage: StorageAdapter, private outbox: OutboxService) {}

  async store(input: StoreFileInput) {
    const id = ulid();
    const safe = path.basename(input.fileName).replace(/[^\w.\-()ঀ-৿ ]+/g, '_').slice(0, 120) || 'file';
    const now = new Date();
    const rel = `${input.schoolId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}-${safe}`;
    const stored = await this.storage.put(rel, input.data);
    const checksum = Buffer.isBuffer(input.data) ? sha256(input.data) : null;
    await this.db.transaction(async tx => {
      await tx.insert('files', {
        id, school_id: input.schoolId, uploaded_by: currentContext()?.userId ?? null, disk: this.storage.kind, path: rel, file_name: safe, mime_type: input.mimeType.slice(0, 120),
        size_bytes: stored.size, checksum, visibility: input.visibility ?? 'private', entity_type: input.entityType ?? null, entity_id: input.entityId ?? null, purpose: input.purpose ?? null,
        width: input.width ?? null, height: input.height ?? null,
      });
      await this.outbox.emit(tx, { type: 'file.uploaded', schoolId: input.schoolId, aggregateType: 'core.file', aggregateId: id, payload: { fileId: id, entityType: input.entityType ?? null, entityId: input.entityId ?? null, purpose: input.purpose ?? null } });
    });
    return { id, path: rel, size: stored.size };
  }

  async get(id: string, schoolId: string) {
    const row = await this.db.findOne<Record<string, unknown>>('files', { id, school_id: schoolId });
    if (!row) throw notFound('file');
    return row;
  }
  async stream(id: string, schoolId: string) { const f = await this.get(id, schoolId); return { file: f, stream: await this.storage.get(String(f.path)) }; }
  async url(id: string, schoolId: string, ttlSeconds = 900) { const f = await this.get(id, schoolId); return this.storage.url(String(f.path), ttlSeconds); }
  async remove(id: string, schoolId: string) { const f = await this.get(id, schoolId); await this.storage.delete(String(f.path)); await this.db.delete('files', { id }); }
}
