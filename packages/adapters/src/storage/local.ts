import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { StorageAdapter, StoredFile } from '../interfaces.js';

/** Files on disk under `uploads/` (never in the DB). Private files are served through a signed URL checked by the server. */
export class LocalStorage implements StorageAdapter {
  readonly kind = 'local';
  constructor(private root: string, private opts: { baseUrl: string; secret: string }) { fs.mkdirSync(root, { recursive: true }); }

  private abs(rel: string) {
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean.split('/').some(s => s === '..' || s === '')) throw new Error(`bad storage path ${rel}`);
    return path.join(this.root, clean);
  }
  async put(rel: string, data: Buffer | Readable): Promise<StoredFile> {
    const file = this.abs(rel); fs.mkdirSync(path.dirname(file), { recursive: true });
    if (Buffer.isBuffer(data)) fs.writeFileSync(file, data); else await pipeline(data, fs.createWriteStream(file));
    return { path: rel, size: fs.statSync(file).size };
  }
  async get(rel: string): Promise<Readable> { return fs.createReadStream(this.abs(rel)); }
  async exists(rel: string) { return fs.existsSync(this.abs(rel)); }
  async delete(rel: string) { try { fs.unlinkSync(this.abs(rel)); } catch { /* gone already */ } }
  async url(rel: string, ttlSeconds = 900) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `${this.opts.baseUrl.replace(/\/$/, '')}/files/${encodeURI(rel)}?exp=${exp}&sig=${this.sign(rel, exp)}`;
  }
  sign(rel: string, exp: number) { return createHmac('sha256', this.opts.secret).update(`${rel}:${exp}`).digest('hex').slice(0, 32); }
  verify(rel: string, exp: number, sig: string) { return exp > Date.now() / 1000 && this.sign(rel, exp) === sig; }
  async freeBytes() { try { const s = fs.statfsSync(this.root); return Number(s.bavail) * Number(s.bsize); } catch { return null; } }
}
