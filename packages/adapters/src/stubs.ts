import type { Readable } from 'node:stream';
import type { PdfAdapter, PushAdapter, PushPayload, PushSubscription, QueueAdapter, RealtimeAdapter, StorageAdapter, StoredFile } from './interfaces.js';

/**
 * VPS-side adapter implementations land with the Docker/Kubernetes deployment (docs/HOSTING-CPANEL.md §4).
 * They exist now so `ADAPTERS=bullmq,cron,s3,chromium,websocket` resolves and fails with a precise message
 * instead of silently falling back — the portability contract is the interface, not the implementation.
 */
const notYet = (what: string, hint: string) => new Error(`${what} adapter is not available in this build: ${hint}`);

export class BullmqQueue implements QueueAdapter {
  readonly kind = 'bullmq';
  constructor(private redisUrl?: string) {}
  private err() { return notYet('bullmq queue', `set REDIS_URL (${this.redisUrl ? 'given' : 'missing'}) and install bullmq in the VPS image`); }
  async push(): Promise<string> { throw this.err(); }
  register() { /* handlers are registered on the worker in the VPS image */ }
  async drain(): Promise<{ ran: number; failed: number }> { throw this.err(); }
  start() { throw this.err(); }
  async stop() { /* nothing to stop */ }
}

export class S3Storage implements StorageAdapter {
  readonly kind = 's3';
  private err() { return notYet('s3 storage', 'set S3_BUCKET, S3_ENDPOINT, S3_KEY, S3_SECRET on the VPS'); }
  async put(): Promise<StoredFile> { throw this.err(); }
  async get(): Promise<Readable> { throw this.err(); }
  async exists(): Promise<boolean> { throw this.err(); }
  async delete() { throw this.err(); }
  async url(): Promise<string> { throw this.err(); }
  async freeBytes() { return null; }
}

export class ChromiumPdf implements PdfAdapter {
  readonly kind = 'chromium';
  async render(): Promise<Buffer> { throw notYet('chromium pdf', 'set GOTENBERG_URL on the VPS (docker compose ships Gotenberg)'); }
}

export class WebsocketRealtime implements RealtimeAdapter {
  readonly kind = 'websocket';
  publish() { throw notYet('websocket realtime', 'use sse on shared hosting; the VPS image ships the ws server'); }
  subscribe(): () => void { throw notYet('websocket realtime', 'use sse on shared hosting; the VPS image ships the ws server'); }
}

export class FcmPush implements PushAdapter {
  readonly kind = 'fcm';
  async send(_sub: PushSubscription, _payload: PushPayload): Promise<{ statusCode?: number }> { throw notYet('fcm push', 'set FCM_SERVICE_ACCOUNT_JSON; Web Push (VAPID) works without it'); }
  publicKey() { return null; }
}
