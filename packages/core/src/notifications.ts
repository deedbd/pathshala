import type { Db } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters, Logger } from '@pathshala/adapters';
import type { OutboxService } from './automation/outbox.js';
import type { SettingsService } from './settings.js';
import { inQuietHours, nextLocalTime, renderTemplate } from './util.js';

export type Channel = 'sms' | 'email' | 'push' | 'in_app' | 'whatsapp' | 'voice';
export interface NotifyInput {
  schoolId: string;
  userId?: string | null;
  address?: string | null;            // phone or email when there is no user
  channels: Channel[];
  eventKey: string;                   // template key, e.g. 'fees.invoice_created'
  data?: Record<string, unknown>;
  title?: string; body?: string;      // fallback when no template exists
  entityType?: string | null; entityId?: string | null;
  respectQuietHours?: boolean;        // default true; OTP passes false
  locale?: 'bn' | 'en';
  immediate?: boolean;                // deliver in-line instead of queuing (OTP, self-test)
}

/**
 * Notification pipeline: template (bn/en per user) → quiet hours → `notifications` rows (queued)
 * → `notifications.deliver` job → adapters (sms/mail/push) → status/delivery updates → stats.
 */
export class NotificationService {
  constructor(private db: Db, private adapters: Adapters, private settings: SettingsService, private outbox: OutboxService, private log: Logger) {}

  async notify(input: NotifyInput): Promise<string[]> {
    const user = input.userId ? await this.db.findOne<Record<string, unknown>>('users', { id: input.userId }) : null;
    const school = await this.db.findOne<Record<string, unknown>>('schools', { id: input.schoolId });
    const locale = (input.locale ?? (user?.locale as string) ?? (school?.locale as string) ?? 'bn') as 'bn' | 'en';
    const tz = String(school?.timezone ?? 'Asia/Dhaka');
    const enabled = (await this.settings.get<Record<string, boolean>>(input.schoolId, 'notifications.channels')) ?? { push: true, email: true, in_app: true, sms: false };
    const quiet = input.respectQuietHours === false ? null : await this.settings.get<{ from: string; to: string }>(input.schoolId, 'notifications.quiet_hours');
    const data = { school: school?.name ?? '', ...(input.data ?? {}) };
    const now = new Date();
    const scheduledFor = quiet && inQuietHours(now, quiet, tz) ? nextLocalTime(quiet.to, tz, now) : now;
    const ids: string[] = [];

    const critical = input.respectQuietHours === false; // OTP, lockouts, installer: ignore channel toggles and per-user opt-outs
    for (const channel of input.channels) {
      if (channel !== 'in_app' && enabled[channel] === false && !critical) continue;
      const address = channel === 'in_app' ? null : this.addressFor(channel, user, input.address);
      if (channel !== 'in_app' && !address) continue;
      if (channel === 'in_app' && !input.userId) continue;
      const prefs = input.userId ? await this.db.findOne<{ enabled: unknown }>('notification_preferences', { user_id: input.userId, event_key: input.eventKey, channel }) : null;
      if (prefs && !Number(prefs.enabled) && input.respectQuietHours !== false) continue;
      const tpl = await this.template(input.schoolId, input.eventKey, channel, locale);
      const body = renderTemplate(tpl?.body ?? input.body ?? input.title ?? input.eventKey, data);
      const title = renderTemplate(tpl?.subject ?? input.title ?? '', data) || null;
      const id = ulid();
      await this.db.insert('notifications', {
        id, school_id: input.schoolId, recipient_user_id: input.userId ?? null, recipient_address: address, channel, event_key: input.eventKey, template_id: tpl?.id ?? null,
        title: title?.slice(0, 200) ?? null, body, data: data as never, entity_type: input.entityType ?? null, entity_id: input.entityId ?? null,
        status: channel === 'in_app' ? 'sent' : 'queued', attempts: 0, scheduled_for: nowSql(scheduledFor), sent_at: channel === 'in_app' ? nowSql() : null,
      });
      if (channel === 'in_app') this.adapters.realtime.publish(`user:${input.userId}`, 'notification', { id, title, body, eventKey: input.eventKey });
      ids.push(id);
    }
    const toDeliver = ids.length ? await this.db.findMany<{ id: string }>('notifications', { id: ids, status: 'queued' }) : [];
    if (toDeliver.length) {
      if (input.immediate && scheduledFor <= now) await this.deliver(toDeliver.map(r => r.id));
      else await this.adapters.queue.push({ name: 'notifications.deliver', queue: 'notifications', schoolId: input.schoolId, payload: { ids: toDeliver.map(r => r.id) }, scheduledFor, triggeredBy: input.eventKey });
    }
    return ids;
  }

  /** Sends admins of a school something (rule failures, installer results, provider alerts). */
  async notifyRole(schoolId: string, role: string, input: Omit<NotifyInput, 'schoolId' | 'userId'>) {
    const slugs = role === 'admin' ? ['admin', 'super_admin'] : [role]; // "admins" always includes the owner
    const users = await this.db.query<{ id: string }>(`SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.school_id = ? AND r.slug IN (${slugs.map(() => '?').join(',')}) AND u.is_active = TRUE`, [schoolId, ...slugs]);
    const ids: string[] = [];
    for (const u of users) ids.push(...await this.notify({ ...input, schoolId, userId: u.id }));
    return ids;
  }

  async deliver(ids: string[]): Promise<{ sent: number; failed: number }> {
    let sent = 0, failed = 0;
    for (const id of ids) {
      const n = await this.db.findOne<Record<string, unknown>>('notifications', { id });
      if (!n || n.status !== 'queued') continue;
      try {
        const r = await this.send(n);
        await this.db.update('notifications', { status: 'sent', sent_at: nowSql(), attempts: Number(n.attempts) + 1, provider_msg_id: r.id ?? null, cost: r.cost ?? null, error: null, updated_at: nowSql() }, { id });
        sent++;
      } catch (e) {
        const err = (e as Error).message.slice(0, 255);
        const attempts = Number(n.attempts) + 1;
        const dead = attempts >= 3;
        await this.db.update('notifications', { status: dead ? 'failed' : 'queued', attempts, error: err, scheduled_for: dead ? n.scheduled_for as string : nowSql(new Date(Date.now() + attempts * 5 * 60_000)), updated_at: nowSql() }, { id });
        if (dead) await this.outbox.emitNow({ type: 'notification.failed', schoolId: String(n.school_id), aggregateType: 'communication.notification', aggregateId: id, payload: { notificationId: id, channel: String(n.channel), error: err } });
        else await this.adapters.queue.push({ name: 'notifications.deliver', queue: 'notifications', schoolId: String(n.school_id), payload: { ids: [id] }, scheduledFor: new Date(Date.now() + attempts * 5 * 60_000) });
        this.log.warn(`notification ${id} (${n.channel}) failed: ${err}`);
        failed++;
      }
    }
    return { sent, failed };
  }

  private async send(n: Record<string, unknown>): Promise<{ id?: string; cost?: number }> {
    const channel = String(n.channel); const address = String(n.recipient_address ?? '');
    if (channel === 'sms') { const r = await this.adapters.sms.send({ to: address, text: String(n.body) }); return { id: r.providerMsgId, cost: r.cost }; }
    if (channel === 'whatsapp') { const d = json<Record<string, unknown>>(n.data) ?? {}; const r = await this.adapters.whatsapp.send({ to: address, text: String(n.body), templateName: (d.whatsappTemplate as string) ?? null, variables: (d.whatsappVariables as string[]) ?? undefined }); return { id: r.providerMsgId, cost: r.cost }; }
    // a voice call reads the message out: for a guardian who cannot read, this is the only channel that works
    if (channel === 'voice') { const r = await this.adapters.voice.call({ to: address, text: `${n.title ? `${n.title}. ` : ''}${String(n.body)}` }); return { id: r.providerCallId, cost: r.cost }; }
    if (channel === 'email') { const r = await this.adapters.mail.send({ to: address, subject: String(n.title ?? 'Pathshala'), text: String(n.body) }); return { id: r.id }; }
    if (channel === 'push') {
      const subs = await this.db.findMany<Record<string, unknown>>('push_subscriptions', { user_id: String(n.recipient_user_id), kind: 'webpush', revoked_at: null });
      if (!subs.length) throw new Error('no push subscription');
      let ok = 0;
      for (const s of subs) {
        try { await this.adapters.push.send({ endpoint: String(s.endpoint), keys: { p256dh: String(s.p256dh), auth: String(s.auth_key) } }, { title: String(n.title ?? 'Pathshala'), body: String(n.body), data: json(n.data) as Record<string, unknown> }); ok++; await this.db.update('push_subscriptions', { last_used_at: nowSql(), failed_count: 0 }, { id: s.id as string }); }
        catch (e) { const code = (e as { statusCode?: number }).statusCode; await this.db.update('push_subscriptions', code === 404 || code === 410 ? { revoked_at: nowSql() } : { failed_count: Number(s.failed_count) + 1 }, { id: s.id as string }); }
      }
      if (!ok) throw new Error('push delivery failed on every subscription');
      return {};
    }
    throw new Error(`channel ${channel} not deliverable`);
  }

  private addressFor(channel: Channel, user: Record<string, unknown> | null, fallback?: string | null): string | null {
    if (channel === 'sms' || channel === 'whatsapp' || channel === 'voice') return (user?.phone as string) ?? fallback ?? null;
    if (channel === 'email') return (user?.email as string) ?? fallback ?? null;
    if (channel === 'push') return user ? `push:${user.id}` : null;
    return null;
  }

  private async template(schoolId: string, eventKey: string, channel: Channel, locale: string) {
    const ch = channel === 'in_app' ? 'in_app' : channel;
    const rows = await this.db.findMany<{ id: string; subject: string | null; body: string; locale: string }>('notification_templates', { school_id: schoolId, event_key: eventKey, channel: ch, is_active: true });
    return rows.find(r => r.locale === locale) ?? rows.find(r => r.locale === 'en') ?? rows[0] ?? null;
  }

  /**
   * Has this exact message already gone out about this exact thing since `since`?
   *
   * Every automation that messages a person has to answer that question, and each one answering it
   * with a column of its own is how a reminder becomes a daily reminder: the column is added for the
   * first case, forgotten for the second, and the guardian gets the same SMS every morning for a
   * fortnight. The `notifications` rows are the record of what was actually sent, so they are the
   * honest place to ask. Housekeeping keeps 90 days of them, which bounds every window below.
   */
  async sentSince(schoolId: string, eventKey: string, entityId: string | null, since: string | Date, userId?: string | null): Promise<boolean> {
    const from = typeof since === 'string' ? since : nowSql(since);
    const where = ['school_id = ?', 'event_key = ?', entityId == null ? 'entity_id IS NULL' : 'entity_id = ?', 'created_at >= ?'];
    const params: unknown[] = entityId == null ? [schoolId, eventKey, from] : [schoolId, eventKey, entityId, from];
    // a message to one person is repeated only to that person: twenty staff who have not read a
    // policy are twenty messages about the same policy, and the first of them must not silence the
    // other nineteen. The entity stays the thing itself, which is what the console reads it by.
    if (userId) { where.splice(3, 0, 'recipient_user_id = ?'); params.splice(3, 0, userId); }
    const rows = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE ${where.join(' AND ')}`, params);
    return Number(rows[0]?.n ?? 0) > 0;
  }
  /** Notifies a role unless the same message about the same thing already went out inside the window. */
  async notifyRoleOnce(schoolId: string, role: string, withinHours: number, input: Omit<NotifyInput, 'schoolId' | 'userId'>): Promise<string[]> {
    const since = nowSql(new Date(Date.now() - withinHours * 3600_000));
    if (await this.sentSince(schoolId, input.eventKey, input.entityId ?? null, since)) return [];
    return this.notifyRole(schoolId, role, input);
  }
  /** The same rule for one person: an offer expiring is worth one SMS, not one a day. */
  async notifyOnce(withinHours: number, input: NotifyInput): Promise<string[]> {
    const since = nowSql(new Date(Date.now() - withinHours * 3600_000));
    if (await this.sentSince(input.schoolId, input.eventKey, input.entityId ?? null, since, input.userId ?? null)) return [];
    return this.notify(input);
  }

  async recentFor(userId: string, limit = 30) { return this.db.findMany('notifications', { recipient_user_id: userId, channel: 'in_app' }, { orderBy: 'created_at DESC', limit }); }
  async markRead(id: string, userId: string) { return this.db.update('notifications', { status: 'read', read_at: nowSql() }, { id, recipient_user_id: userId }); }
}
