import path from 'node:path';
import type { Db } from '@pathshala/db';
import type { Adapters, JobRecord, Logger } from './interfaces.js';
import { consoleLogger } from './interfaces.js';
import { DbQueue } from './queue/db.js';
import { DbScheduler, type SchedulerMode } from './scheduler/db.js';
import { LocalStorage } from './storage/local.js';
import { PdfmakePdf } from './pdf/pdfmake.js';
import { SseRealtime } from './realtime/sse.js';
import { LogMail, SmtpMail } from './mail.js';
import { HttpSms, LogSms } from './sms.js';
import { HttpVoice, LogVoice, LogWhatsApp, MetaWhatsApp } from './voice.js';
import { HttpAi, NoAi } from './ai.js';
import { createCPanel } from './cpanel.js';
import { LogPush, WebPush } from './push.js';
import { BullmqQueue, ChromiumPdf, FcmPush, S3Storage, WebsocketRealtime } from './stubs.js';

export * from './interfaces.js';
export * from './cron.js';
export { DbQueue } from './queue/db.js';
export { DbScheduler, type SchedulerMode } from './scheduler/db.js';
export { LocalStorage } from './storage/local.js';
export { PdfmakePdf } from './pdf/pdfmake.js';
export { SseRealtime } from './realtime/sse.js';
export { LogMail, SmtpMail } from './mail.js';
export { HttpSms, LogSms } from './sms.js';
export { HttpVoice, LogVoice, LogWhatsApp, MetaWhatsApp } from './voice.js';
export { HttpAi, NoAi } from './ai.js';
export type { AiAdapter, AiMessage, AiReply, AiRequest } from './ai.js';
export { CPanelApi, NoCPanel, createCPanel } from './cpanel.js';
export type { CPanelAdapter, CPanelAliasList, CPanelAliasResult, CPanelOptions } from './cpanel.js';
export type { VoiceAdapter, VoiceCall, WhatsAppAdapter, WhatsAppMessage } from './voice.js';
export { LogPush, WebPush } from './push.js';
export * from './stubs.js';

export interface AdapterEnv {
  ADAPTERS?: string;           // queue,scheduler,storage,pdf,realtime — e.g. db,inprocess,local,pdfmake,sse
  CRON_MODE?: string;          // heartbeat | cron | inprocess  (overrides the scheduler slot)
  APP_URL?: string; APP_KEY?: string; UPLOADS_DIR?: string; FONTS_DIR?: string;
  SMTP_HOST?: string; SMTP_PORT?: string; SMTP_USER?: string; SMTP_PASS?: string; MAIL_FROM?: string;
  SMS_PROVIDER?: string; SMS_HTTP_URL?: string; SMS_HTTP_METHOD?: string; SMS_SENDER_ID?: string; SMS_HTTP_BODY?: string; SMS_BALANCE_URL?: string; SMS_COST?: string;
  VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string;
  REDIS_URL?: string; QUEUE_CONCURRENCY?: string; JOB_BUDGET_MS?: string;
  CPANEL_URL?: string; CPANEL_USER?: string; CPANEL_API_TOKEN?: string;
  [k: string]: string | undefined;
}

/**
 * `ADAPTERS=db,inprocess,local,pdfmake,sse` on cPanel → `bullmq,cron,s3,chromium,websocket` on a VPS.
 * The five positional slots are queue, scheduler, storage, pdf, realtime; mail/sms/push come from their own vars.
 */
export function createAdapters(env: AdapterEnv, deps: { db: Db; rootDir: string; log?: Logger; afterTick?: () => Promise<void>; onJobFailed?: (job: JobRecord, error: Error) => Promise<void> }): Adapters & { mode: SchedulerMode } {
  const log = deps.log ?? consoleLogger;
  const [q = 'db', s = 'inprocess', st = 'local', p = 'pdfmake', rt = 'sse'] = (env.ADAPTERS || 'db,inprocess,local,pdfmake,sse').split(',').map(x => x.trim().toLowerCase());
  const mode = ((env.CRON_MODE?.toLowerCase() as SchedulerMode) || (s === 'cron' || s === 'k8s-cronjob' ? 'cron' : s === 'heartbeat' ? 'heartbeat' : 'inprocess'));
  const budget = Number(env.JOB_BUDGET_MS) || 25_000;

  const queue = q === 'bullmq' ? new BullmqQueue(env.REDIS_URL) : new DbQueue({ db: deps.db, log, concurrency: Number(env.QUEUE_CONCURRENCY) || 2, jobBudgetMs: budget, onFailed: deps.onJobFailed });
  const scheduler = new DbScheduler({ db: deps.db, log, mode, jobBudgetMs: budget, afterTick: deps.afterTick });
  const uploads = path.resolve(deps.rootDir, env.UPLOADS_DIR || 'uploads');
  const storage = st === 's3' ? new S3Storage() : new LocalStorage(uploads, { baseUrl: env.APP_URL || 'http://localhost:3000', secret: env.APP_KEY || 'dev' });
  const pdf = p === 'chromium' ? new ChromiumPdf() : new PdfmakePdf(env.FONTS_DIR ? path.resolve(deps.rootDir, env.FONTS_DIR) : undefined);
  const realtime = rt === 'websocket' ? new WebsocketRealtime() : new SseRealtime();
  const mail = env.SMTP_HOST ? new SmtpMail({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT) || 465, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.MAIL_FROM || `Pathshala <no-reply@${hostOf(env.APP_URL)}>` }) : new LogMail(log);
  const sms = env.SMS_PROVIDER === 'http' && env.SMS_HTTP_URL ? new HttpSms({ url: env.SMS_HTTP_URL, method: (env.SMS_HTTP_METHOD as 'GET' | 'POST') || 'GET', senderId: env.SMS_SENDER_ID, body: env.SMS_HTTP_BODY, balanceUrl: env.SMS_BALANCE_URL, costPerSms: Number(env.SMS_COST) || undefined }) : new LogSms(log);
  // a school that has not connected WhatsApp or an IVR gateway still sees what would have gone out
  const whatsapp = env.WHATSAPP_URL && env.WHATSAPP_TOKEN ? new MetaWhatsApp({ url: env.WHATSAPP_URL, token: env.WHATSAPP_TOKEN, defaultTemplate: env.WHATSAPP_TEMPLATE, languageCode: env.WHATSAPP_LANG || 'bn', costPerMessage: Number(env.WHATSAPP_COST) || undefined }) : new LogWhatsApp(log);
  const voice = env.VOICE_URL ? new HttpVoice({ url: env.VOICE_URL, method: (env.VOICE_METHOD as 'GET' | 'POST') || 'GET', body: env.VOICE_BODY, costPerCall: Number(env.VOICE_COST) || undefined }) : new LogVoice(log);
  // any OpenAI-compatible endpoint; without one the assistant answers from data and refuses to draft
  const ai = env.AI_URL ? new HttpAi({ url: env.AI_URL, apiKey: env.AI_KEY, model: env.AI_MODEL, costPer1kIn: Number(env.AI_COST_IN) || undefined, costPer1kOut: Number(env.AI_COST_OUT) || undefined }) : new NoAi(log);
  const push = env.PUSH_PROVIDER === 'fcm' ? new FcmPush() : env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? new WebPush({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT }) : new LogPush();

  // the hosting panel, only where a token says there is one: adding a domain to the account is the
  // half of a custom domain that DNS cannot do, and every other host answers `configured: false`
  const cpanel = createCPanel(env, log);

  return { queue, scheduler, storage, pdf, realtime, mail, sms, push, whatsapp, voice, ai, cpanel, mode };
}

function hostOf(url?: string) { try { return new URL(url || 'http://localhost').hostname; } catch { return 'localhost'; } }
