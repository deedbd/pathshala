import type { Readable } from 'node:stream';

// ---------------- queue ----------------
export interface JobSpec {
  name: string;                       // handler key, e.g. 'notifications.deliver'
  payload?: Record<string, unknown>;
  queue?: string;                     // 'default' | 'notifications' | 'pdf' | 'batch'
  schoolId: string;
  scheduledFor?: Date | string;       // delay
  maxAttempts?: number;
  totalItems?: number;
  triggeredBy?: string;
}
export interface JobRecord {
  id: string; schoolId: string; queue: string; name: string; payload: Record<string, unknown>;
  attempts: number; maxAttempts: number; cursor: unknown; doneItems: number; totalItems: number | null;
}
export interface JobContext {
  job: JobRecord;
  /** Persist progress for chunked jobs. Return from the handler with `{ continue: true }` to be re-queued immediately. */
  progress(done: number, total?: number | null, cursor?: unknown): Promise<void>;
  log(msg: string): void;
  deadline: number;                    // epoch ms; handlers should yield before it (≈25 s on shared hosting)
}
export type JobResult = void | { continue: true; cursor?: unknown; delayMs?: number } | { result?: unknown };
export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<JobResult>;
export interface QueueAdapter {
  readonly kind: string;
  push(job: JobSpec): Promise<string>;
  register(name: string, handler: JobHandler): void;
  /** Runs at most `max` due jobs and returns; used by the heartbeat and the in-process loop. */
  drain(max?: number): Promise<{ ran: number; failed: number }>;
  start(): void;
  stop(): Promise<void>;
}

// ---------------- scheduler ----------------
export type ScheduledFn = (ctx: { schoolId: string; jobKey: string; payload: Record<string, unknown>; deadline: number }) => Promise<unknown>;
export interface SchedulerAdapter {
  readonly kind: string;
  register(jobKey: string, fn: ScheduledFn): void;
  /** Runs everything overdue (DB lock, one instance at a time). Safe to call from any request. */
  tick(): Promise<{ ran: string[]; skipped: number; errors: string[] }>;
  start(): void;
  stop(): Promise<void>;
}

// ---------------- storage ----------------
export interface StoredFile { path: string; size: number; url?: string }
export interface StorageAdapter {
  readonly kind: string;
  put(relPath: string, data: Buffer | Readable): Promise<StoredFile>;
  get(relPath: string): Promise<Readable>;
  exists(relPath: string): Promise<boolean>;
  delete(relPath: string): Promise<void>;
  /** Signed or public URL for a private file, valid for `ttlSeconds`. */
  url(relPath: string, ttlSeconds?: number): Promise<string>;
  freeBytes(): Promise<number | null>;
}

// ---------------- pdf ----------------
export interface PdfAdapter {
  readonly kind: string;
  /** `doc` is a pdfmake document definition (content, styles, pageSize…); Bangla text works when Noto Sans Bengali is bundled. */
  render(doc: Record<string, unknown>, opts?: { fontFamily?: string }): Promise<Buffer>;
}

// ---------------- realtime ----------------
export interface RealtimeAdapter {
  readonly kind: string;
  publish(channel: string, event: string, data: unknown): void;
  subscribe(channel: string, cb: (event: string, data: unknown) => void): () => void;
}

// ---------------- mail / sms / push ----------------
export interface MailMessage { to: string; subject: string; text?: string; html?: string; from?: string; replyTo?: string; attachments?: { filename: string; content: Buffer; contentType?: string }[] }
export interface MailAdapter { readonly kind: string; send(msg: MailMessage): Promise<{ id?: string }>; verify(): Promise<boolean> }

export interface SmsMessage { to: string; text: string; senderId?: string }
export interface SmsAdapter { readonly kind: string; send(msg: SmsMessage): Promise<{ providerMsgId?: string; cost?: number }>; balance?(): Promise<number | null> }

export interface PushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushPayload { title: string; body: string; url?: string; icon?: string; tag?: string; data?: Record<string, unknown> }
export interface PushAdapter { readonly kind: string; send(sub: PushSubscription, payload: PushPayload): Promise<{ statusCode?: number }>; publicKey(): string | null }

export interface Adapters {
  queue: QueueAdapter;
  scheduler: SchedulerAdapter;
  storage: StorageAdapter;
  pdf: PdfAdapter;
  realtime: RealtimeAdapter;
  mail: MailAdapter;
  sms: SmsAdapter;
  push: PushAdapter;
}

export interface Logger { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void; error(msg: string, meta?: unknown): void; debug(msg: string, meta?: unknown): void }
export const consoleLogger: Logger = {
  info: (m, x) => console.log(`[info] ${m}`, x ?? ''),
  warn: (m, x) => console.warn(`[warn] ${m}`, x ?? ''),
  error: (m, x) => console.error(`[error] ${m}`, x ?? ''),
  debug: (m, x) => { if (process.env.DEBUG) console.log(`[debug] ${m}`, x ?? ''); },
};
