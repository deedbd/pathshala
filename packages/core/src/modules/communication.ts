import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import { HttpError, badRequest, forbidden, notFound } from '../context.js';
import { decryptSecret, encryptSecret, renderTemplate } from '../util.js';

export type BroadcastChannel = 'sms' | 'email' | 'push' | 'in_app' | 'whatsapp' | 'voice';
export interface Audience { roles?: string[]; classIds?: string[]; sectionIds?: string[]; studentIds?: string[]; guardians?: boolean; staff?: boolean; withDues?: boolean }
export interface BroadcastInput { title: string; body: string; channels?: BroadcastChannel[]; audience?: Audience; noticeType?: string; expiresAt?: string | null; urgent?: boolean; whatsappTemplate?: string | null; whatsappVariables?: string[]; createdBy?: string | null }

export interface MessageInput { conversationId: string; body?: string | null; attachments?: unknown; replyToId?: string | null }

/**
 * Chat (direct, group and one channel per section), PTM slots and bookings, and the diary
 * (homework, KG daily report, teacher remarks). Delivery reuses the notification pipeline, so
 * quiet hours and per-user channel preferences apply to chat pushes too.
 */
export class CommunicationService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService, private adapters: Adapters, private appKey = '') {}

  // ---------- conversations ----------
  async conversations(schoolId: string, userId: string) {
    return this.db.query<Row>(`SELECT c.*, p.last_read_at, p.muted,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL AND (p.last_read_at IS NULL OR m.sent_at > p.last_read_at)) AS unread,
        (SELECT m2.body FROM messages m2 WHERE m2.conversation_id = c.id AND m2.deleted_at IS NULL ORDER BY m2.sent_at DESC LIMIT 1) AS last_body
      FROM conversation_participants p JOIN conversations c ON c.id = p.conversation_id
      WHERE p.school_id = ? AND p.user_id = ? ORDER BY CASE WHEN c.last_message_at IS NULL THEN 1 ELSE 0 END, COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC LIMIT 100`, [schoolId, userId]);
  }
  async openDirect(schoolId: string, userId: string, otherUserId: string) {
    if (userId === otherUserId) throw badRequest('cannot message yourself');
    const existing = await this.db.query<Row>(`SELECT c.id FROM conversations c JOIN conversation_participants a ON a.conversation_id = c.id AND a.user_id = ? JOIN conversation_participants b ON b.conversation_id = c.id AND b.user_id = ? WHERE c.school_id = ? AND c.kind = 'direct' LIMIT 1`, [userId, otherUserId, schoolId]);
    if (existing[0]) return String(existing[0].id);
    const id = ulid();
    await this.db.transaction(async tx => {
      await tx.insert('conversations', { id, school_id: schoolId, kind: 'direct', subject: null, section_id: null, created_by: userId, is_locked: false });
      await tx.insertMany('conversation_participants', [userId, otherUserId].map(u => ({ id: ulid(), school_id: schoolId, conversation_id: id, user_id: u, role: 'member', muted: false })));
    });
    return id;
  }
  /** One channel per section: the class teacher, the subject teachers and every guardian of the section. */
  async ensureSectionChannel(schoolId: string, sectionId: string) {
    const ex = await this.db.findOne<Row>('conversations', { school_id: schoolId, section_id: sectionId, kind: 'section_channel' });
    const section = await this.db.findOne<Row>('sections', { id: sectionId, school_id: schoolId });
    if (!section) throw notFound('section');
    const cls = await this.db.findOne<Row>('classes', { id: String(section.class_id) });
    const id = ex ? String(ex.id) : ulid();
    if (!ex) await this.db.insert('conversations', { id, school_id: schoolId, kind: 'section_channel', subject: `${cls?.name ?? ''} ${section.name}`, section_id: sectionId, created_by: null, is_locked: false });
    const members = await this.db.query<{ user_id: string; is_teacher: number }>(`SELECT DISTINCT u.id AS user_id, 1 AS is_teacher FROM section_subject_teachers t JOIN staff st ON st.id = t.teacher_id JOIN users u ON u.id = st.user_id WHERE t.section_id = ?
      UNION SELECT DISTINCT u.id, 0 FROM student_enrollments e JOIN student_guardians sg ON sg.student_id = e.student_id JOIN guardians g ON g.id = sg.guardian_id JOIN users u ON u.id = g.user_id WHERE e.section_id = ? AND e.status = 'active' AND sg.receives_notifications = TRUE`, [sectionId, sectionId]);
    const have = new Set((await this.db.findMany<{ user_id: string }>('conversation_participants', { conversation_id: id })).map(p => p.user_id));
    const add = members.filter(m => m.user_id && !have.has(m.user_id)).map(m => ({ id: ulid(), school_id: schoolId, conversation_id: id, user_id: m.user_id, role: Number(m.is_teacher) ? 'admin' : 'member', muted: false }));
    if (add.length) await this.db.insertMany('conversation_participants', add);
    return { id, added: add.length, members: have.size + add.length };
  }
  async messages(schoolId: string, conversationId: string, userId: string, before?: string) {
    const me = await this.db.findOne<Row>('conversation_participants', { conversation_id: conversationId, user_id: userId });
    if (!me) throw forbidden('not in this conversation');
    const rows = await this.db.query<Row>(`SELECT m.*, u.display_name AS sender_name, u.user_type AS sender_type FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = ? AND m.deleted_at IS NULL${before ? ' AND m.sent_at < ?' : ''} ORDER BY m.sent_at DESC LIMIT 50`, before ? [conversationId, before] : [conversationId]);
    await this.db.update('conversation_participants', { last_read_at: nowSql() }, { id: me.id as string });
    void schoolId;
    return rows.reverse();
  }
  async send(schoolId: string, userId: string, m: MessageInput) {
    const me = await this.db.findOne<Row>('conversation_participants', { conversation_id: m.conversationId, user_id: userId });
    if (!me) throw forbidden('not in this conversation');
    const convo = await this.db.findOne<Row>('conversations', { id: m.conversationId, school_id: schoolId });
    if (!convo) throw notFound('conversation');
    if (Number(convo.is_locked) && me.role !== 'admin') throw forbidden('this conversation is read-only');
    if (!m.body?.trim() && !m.attachments) throw badRequest('empty message');
    const id = ulid();
    await this.db.transaction(async tx => {
      await tx.insert('messages', { id, school_id: schoolId, conversation_id: m.conversationId, sender_id: userId, body: m.body?.slice(0, 4000) ?? null, attachments: (m.attachments ?? null) as never, reply_to_id: m.replyToId ?? null, sent_at: nowSql(), flagged: false });
      await tx.update('conversations', { last_message_at: nowSql(), updated_at: nowSql() }, { id: m.conversationId });
      await this.outbox.emit(tx, { type: 'message.sent', schoolId, aggregateType: 'communication.message', aggregateId: id, payload: { messageId: id, conversationId: m.conversationId, senderId: userId } as never });
    });
    const sender = await this.db.findOne<Row>('users', { id: userId });
    const others = await this.db.query<{ user_id: string }>(`SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id <> ? AND muted = FALSE`, [m.conversationId, userId]);
    for (const o of others) {
      this.adapters.realtime.publish(`user:${o.user_id}`, 'message', { conversationId: m.conversationId, messageId: id });
      await this.notifications.notify({ schoolId, userId: o.user_id, channels: ['push', 'in_app'], eventKey: 'chat.message', data: { from: sender?.display_name ?? '', text: m.body ?? '' }, title: String(sender?.display_name ?? 'Message'), body: (m.body ?? '').slice(0, 140), entityType: 'communication.conversation', entityId: m.conversationId });
    }
    return { id, notified: others.length };
  }

  // ---------- PTM ----------
  // ---------- broadcast ----------
  /**
   * One message to many people, on the channels the school chooses.
   *
   * Two things make this different from a loop over `notify`. The audience is resolved from the
   * school's own records — a class, a section, a role, everyone with unpaid fees — so nobody has to
   * keep a list in a notebook. And a voice call is offered as a channel, because a guardian who
   * cannot read gets nothing from an SMS: the message is read out to them instead.
   *
   * A broadcast is queued, not sent inline: five hundred calls placed inside one request would take
   * the request with them.
   */
  async broadcast(schoolId: string, b: BroadcastInput) {
    const channels = b.channels?.length ? b.channels : ['push', 'in_app'];
    const recipients = await this.audience(schoolId, b.audience ?? {});
    if (!recipients.length) throw badRequest('that audience matches nobody');
    const id = ulid();
    await this.db.insert('notices', {
      id, school_id: schoolId, title: b.title, body: b.body, notice_type: b.noticeType ?? 'general',
      audience: { ...(b.audience ?? {}), channels, recipients: recipients.length } as never, attachments: null,
      publish_at: nowSql(), expires_at: b.expiresAt ?? null, is_pinned: false,
      send_push: channels.includes('push'), send_sms: channels.includes('sms'), send_email: channels.includes('email'),
      status: 'published', created_by: b.createdBy ?? null,
    });
    for (const r of recipients) {
      await this.notifications.notify({
        schoolId, userId: r.userId, address: r.phone ?? r.email ?? null, channels: channels as never,
        eventKey: 'comms.broadcast', title: b.title, body: b.body,
        data: b.whatsappTemplate ? { whatsappTemplate: b.whatsappTemplate, whatsappVariables: b.whatsappVariables ?? [] } : undefined,
        entityType: 'communication.notice', entityId: id,
        respectQuietHours: b.urgent ? false : undefined,
      });
    }
    await this.outbox.emitNow({ type: 'broadcast.sent', schoolId, aggregateType: 'communication.notice', aggregateId: id, payload: { noticeId: id, title: b.title, recipients: recipients.length, channels: channels.join(',') } });
    return { id, recipients: recipients.length, channels };
  }
  /**
   * Who a broadcast reaches. Guardians are addressed through the guardian who receives notifications
   * for that child, so a family with three children here is written to once per child and not once
   * per child per guardian.
   */
  async audience(schoolId: string, a: Audience) {
    const out = new Map<string, { userId: string | null; phone: string | null; email: string | null }>();
    const add = (key: string, r: { userId: string | null; phone: string | null; email: string | null }) => { if (!out.has(key)) out.set(key, r); };
    if (a.roles?.length) {
      const rows = await this.db.query<Row>(`SELECT DISTINCT u.id, u.phone, u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.school_id = ? AND u.is_active = TRUE AND r.slug IN (${a.roles.map(() => '?').join(',')})`, [schoolId, ...a.roles]);
      for (const r of rows) add(`u:${r.id}`, { userId: String(r.id), phone: (r.phone as string) ?? null, email: (r.email as string) ?? null });
    }
    if (a.guardians || a.classIds?.length || a.sectionIds?.length || a.studentIds?.length || a.withDues) {
      const where: string[] = ['g.school_id = ?', 'sg.receives_notifications = TRUE', `s.status = 'active'`];
      const params: unknown[] = [schoolId];
      if (a.classIds?.length) { where.push(`s.current_class_id IN (${a.classIds.map(() => '?').join(',')})`); params.push(...a.classIds); }
      if (a.sectionIds?.length) { where.push(`s.current_section_id IN (${a.sectionIds.map(() => '?').join(',')})`); params.push(...a.sectionIds); }
      if (a.studentIds?.length) { where.push(`s.id IN (${a.studentIds.map(() => '?').join(',')})`); params.push(...a.studentIds); }
      if (a.withDues) where.push(`EXISTS (SELECT 1 FROM invoices i WHERE i.student_id = s.id AND i.balance > 0)`);
      const rows = await this.db.query<Row>(`SELECT DISTINCT g.id AS guardian_id, g.user_id, g.phone, g.email FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id JOIN students s ON s.id = sg.student_id WHERE ${where.join(' AND ')} LIMIT 20000`, params);
      for (const r of rows) add(`g:${r.guardian_id}`, { userId: (r.user_id as string) ?? null, phone: (r.phone as string) ?? null, email: (r.email as string) ?? null });
    }
    if (a.staff) {
      const rows = await this.db.query<Row>(`SELECT id, user_id, phone, email FROM staff WHERE school_id = ? AND status IN ('active','probation')`, [schoolId]);
      for (const r of rows) add(`s:${r.id}`, { userId: (r.user_id as string) ?? null, phone: (r.phone as string) ?? null, email: (r.email as string) ?? null });
    }
    return [...out.values()];
  }
  /** What a broadcast cost and where it got to, once the queue has worked through it. */
  async broadcastStatus(schoolId: string, noticeId: string) {
    const notice = await this.db.findOne<Row>('notices', { id: noticeId, school_id: schoolId });
    if (!notice) throw notFound('notice');
    const rows = await this.db.query<{ channel: string; status: string; n: number; cost: number }>(`SELECT channel, status, COUNT(*) AS n, COALESCE(SUM(cost), 0) AS cost FROM notifications WHERE school_id = ? AND entity_type = 'communication.notice' AND entity_id = ? GROUP BY channel, status`, [schoolId, noticeId]);
    return { notice: { ...notice, audience: json(notice.audience) }, delivery: rows, cost: rows.reduce((a, r) => a + Number(r.cost), 0) };
  }

  // ---------- the notice board ----------
  /**
   * Every notice with what became of it: who it went to, how many of those messages are still in the
   * queue, and how many people have opened it. The reads are counted on the `notifications` rows the
   * pipeline actually wrote, not on a column somebody has to remember to bump.
   */
  async noticeBoard(schoolId: string, f: { status?: string; limit?: number } = {}) {
    const where = ['n.school_id = ?', 'n.deleted_at IS NULL']; const params: unknown[] = [schoolId];
    if (f.status) { where.push('n.status = ?'); params.push(f.status); }
    const limit = Math.min(Math.max(Number(f.limit ?? 100), 1), 200);
    const notices = await this.db.query<Row>(`SELECT n.*, u.display_name AS author FROM notices n LEFT JOIN users u ON u.id = n.created_by
      WHERE ${where.join(' AND ')} ORDER BY n.publish_at DESC, n.id DESC LIMIT ${limit}`, params);
    if (!notices.length) return [];
    const ids = notices.map(n => String(n.id));
    const delivery = await this.db.query<Row>(`SELECT entity_id, channel, status, COUNT(*) AS n, COALESCE(SUM(cost), 0) AS cost FROM notifications
      WHERE school_id = ? AND entity_type = 'communication.notice' AND entity_id IN (${ids.map(() => '?').join(',')}) GROUP BY entity_id, channel, status`, [schoolId, ...ids]);
    const receipts = await this.db.query<Row>(`SELECT notice_id, COUNT(*) AS n FROM notice_reads WHERE notice_id IN (${ids.map(() => '?').join(',')}) GROUP BY notice_id`, ids);
    const receiptBy = new Map(receipts.map(r => [String(r.notice_id), Number(r.n)]));
    return notices.map(n => {
      const mine = delivery.filter(d => String(d.entity_id) === String(n.id));
      const count = (p: (d: Row) => boolean) => mine.filter(p).reduce((a, d) => a + Number(d.n), 0);
      const channels = [...new Set(mine.map(d => String(d.channel)))];
      return {
        ...n, audience: json(n.audience),
        channels, told: count(() => true),
        queued: count(d => String(d.status) === 'queued'),
        failed: count(d => String(d.status) === 'failed'),
        read: count(d => String(d.status) === 'read') + (receiptBy.get(String(n.id)) ?? 0),
        cost: Math.round(mine.reduce((a, d) => a + Number(d.cost ?? 0), 0) * 100) / 100,
      };
    });
  }

  // ---------- the message log ----------
  /** Every message the school has sent, with the channel it went on, what came back and what it cost. */
  async notificationLog(schoolId: string, f: { channel?: string; status?: string; eventKey?: string; from?: string; to?: string; search?: string; limit?: number; offset?: number } = {}) {
    const where = ['n.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.channel) { where.push('n.channel = ?'); params.push(f.channel); }
    if (f.status) { where.push('n.status = ?'); params.push(f.status); }
    if (f.eventKey) { where.push('n.event_key = ?'); params.push(f.eventKey); }
    if (f.from) { where.push('n.created_at >= ?'); params.push(`${f.from} 00:00:00`); }
    if (f.to) { where.push('n.created_at <= ?'); params.push(`${f.to} 23:59:59`); }
    if (f.search) { where.push('(n.recipient_address LIKE ? OR n.title LIKE ?)'); params.push(`%${f.search}%`, `%${f.search}%`); }
    const limit = Math.min(Math.max(Number(f.limit ?? 100), 1), 500);
    const offset = Math.max(Number(f.offset ?? 0), 0);
    const rows = await this.db.query<Row>(`SELECT n.id, n.channel, n.event_key, n.title, n.body, n.status, n.recipient_address, n.attempts, n.cost, n.error,
        n.scheduled_for, n.created_at, n.sent_at, n.delivered_at, n.read_at, u.display_name AS recipient_name
      FROM notifications n LEFT JOIN users u ON u.id = n.recipient_user_id
      WHERE ${where.join(' AND ')} ORDER BY n.created_at DESC, n.id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    const total = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications n WHERE ${where.join(' AND ')}`, params);
    return { rows, total: Number(total[0]?.n ?? 0), limit, offset };
  }
  /** The same rows added up: what went out today, what failed, and the bill for it. */
  async notificationStats(schoolId: string, from: string, to: string) {
    const rows = await this.db.query<Row>(`SELECT channel, status, COUNT(*) AS n, COALESCE(SUM(cost), 0) AS cost FROM notifications
      WHERE school_id = ? AND created_at >= ? AND created_at <= ? GROUP BY channel, status`, [schoolId, `${from} 00:00:00`, `${to} 23:59:59`]);
    const sum = (p: (r: Row) => boolean) => rows.filter(p).reduce((a, r) => a + Number(r.n), 0);
    const sent = sum(r => ['sent', 'delivered', 'read'].includes(String(r.status)));
    const total = sum(() => true);
    return {
      from, to, total, sent, queued: sum(r => String(r.status) === 'queued'), failed: sum(r => String(r.status) === 'failed'),
      byChannel: [...new Set(rows.map(r => String(r.channel)))].map(ch => ({ channel: ch, count: sum(r => String(r.channel) === ch), failed: sum(r => String(r.channel) === ch && String(r.status) === 'failed'), cost: Math.round(rows.filter(r => String(r.channel) === ch).reduce((a, r) => a + Number(r.cost ?? 0), 0) * 100) / 100 })),
      cost: Math.round(rows.reduce((a, r) => a + Number(r.cost ?? 0), 0) * 100) / 100,
      // "delivered" here means the provider took it: only a gateway that reports back can say more
      deliveredPct: total ? Math.round(sent / total * 1000) / 10 : null,
    };
  }
  /** Queue a failed message again. Nothing is rewritten: the same row goes back on the queue. */
  async retryNotification(schoolId: string, id: string) {
    const n = await this.db.findOne<Row>('notifications', { id, school_id: schoolId });
    if (!n) throw notFound('notification');
    if (String(n.status) !== 'failed') throw badRequest('only a failed message is retried');
    await this.db.update('notifications', { status: 'queued', attempts: 0, error: null, scheduled_for: nowSql(), updated_at: nowSql() }, { id });
    await this.adapters.queue.push({ name: 'notifications.deliver', queue: 'notifications', schoolId, payload: { ids: [id] }, triggeredBy: 'console.retry' });
    return { id, queued: true };
  }

  // ---------- templates ----------
  /** Every template: event × channel × locale, and whether the pipeline is allowed to pick it. */
  async templates(schoolId: string, f: { eventKey?: string; channel?: string; locale?: string } = {}) {
    const where: Row = { school_id: schoolId };
    if (f.eventKey) where.event_key = f.eventKey;
    if (f.channel) where.channel = f.channel;
    if (f.locale) where.locale = f.locale;
    const rows = await this.db.findMany<Row>('notification_templates', where, { orderBy: 'event_key ASC, channel ASC, locale ASC', limit: 500 });
    return rows.map(r => ({ ...r, variables: json(r.variables), is_active: !!Number(r.is_active), placeholders: [...new Set(String(r.body).match(/{{\s*[\w.]+\s*}}/g) ?? [])].map(v => v.replace(/[{}\s]/g, '')) }));
  }
  /**
   * One template per event × channel × locale — the unique key says so, so this updates the row that
   * is already there instead of leaving two and letting the pipeline pick whichever it finds first.
   */
  async saveTemplate(schoolId: string, t: { eventKey: string; channel: string; locale: string; subject?: string | null; body: string; isActive?: boolean }) {
    if (!t.body.trim()) throw badRequest('a template needs a body');
    const ex = await this.db.findOne<{ id: string }>('notification_templates', { school_id: schoolId, event_key: t.eventKey, channel: t.channel, locale: t.locale });
    const row = { subject: t.subject ?? null, body: t.body, is_active: t.isActive ?? true };
    if (ex) { await this.db.update('notification_templates', { ...row, updated_at: nowSql() }, { id: ex.id }); return { id: ex.id, created: false }; }
    const id = ulid();
    await this.db.insert('notification_templates', { id, school_id: schoolId, event_key: t.eventKey, channel: t.channel, locale: t.locale, variables: null, ...row });
    return { id, created: true };
  }
  async setTemplateActive(schoolId: string, id: string, active: boolean) {
    return { updated: await this.db.update('notification_templates', { is_active: active, updated_at: nowSql() }, { id, school_id: schoolId }) };
  }
  /** What the next send would read like, with the placeholders filled from the sample given. */
  async previewTemplate(schoolId: string, t: { id?: string; body?: string; subject?: string | null }, sample: Record<string, unknown> = {}) {
    let body = t.body ?? '', subject = t.subject ?? null;
    if (t.id) {
      const row = await this.db.findOne<Row>('notification_templates', { id: t.id, school_id: schoolId });
      if (!row) throw notFound('template');
      body = t.body ?? String(row.body); subject = t.subject ?? ((row.subject as string) ?? null);
    }
    const school = await this.db.findOne<Row>('schools', { id: schoolId });
    const data = { school: String(school?.name ?? ''), ...sample };
    const used = [...new Set(body.match(/{{\s*[\w.]+\s*}}/g) ?? [])].map(v => v.replace(/[{}\s]/g, ''));
    return { subject: subject ? renderTemplate(subject, data) : null, body: renderTemplate(body, data), placeholders: used, missing: used.filter(k => k.split('.').reduce<unknown>((o, kk) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[kk] : undefined), data) == null) };
  }

  // ---------- providers ----------
  /**
   * The providers a school sends through. Credentials never leave the server: the row says whether a
   * key is set and nothing more, because a page that can display an API key is a page that leaks it.
   */
  async providers(schoolId: string) {
    const rows = await this.db.findMany<Row>('messaging_providers', { school_id: schoolId }, { orderBy: 'channel ASC, provider ASC' });
    return rows.map(r => {
      const { credentials, ...rest } = r;
      return {
        ...rest,
        hasCredentials: !!credentials && Object.keys((json<Record<string, unknown>>(credentials) ?? {})).length > 0,
        is_default: !!Number(r.is_default), is_active: !!Number(r.is_active),
        balance: r.balance == null ? null : Number(r.balance),
        low_balance_threshold: r.low_balance_threshold == null ? null : Number(r.low_balance_threshold),
        low: r.balance != null && r.low_balance_threshold != null && Number(r.balance) < Number(r.low_balance_threshold),
      };
    });
  }
  /**
   * One default per channel: setting a new default clears the old one in the same breath, because
   * two defaults is the same as none — the pipeline would take whichever row came back first.
   */
  async saveProvider(schoolId: string, p: { id?: string; channel: string; provider: string; senderId?: string | null; credentials?: Record<string, string> | null; isDefault?: boolean; isActive?: boolean; lowBalanceThreshold?: number | null; costPerUnit?: number | null }) {
    const ex = p.id
      ? await this.db.findOne<Row>('messaging_providers', { id: p.id, school_id: schoolId })
      : await this.db.findOne<Row>('messaging_providers', { school_id: schoolId, channel: p.channel, provider: p.provider });
    if (p.id && !ex) throw notFound('provider');
    const secret = p.credentials && Object.keys(p.credentials).length
      ? { enc: encryptSecret(JSON.stringify(p.credentials), this.appKey) }
      : undefined;
    const row: Record<string, unknown> = {
      channel: p.channel, provider: p.provider, sender_id: p.senderId ?? null,
      is_default: p.isDefault ?? false, is_active: p.isActive ?? true,
      low_balance_threshold: p.lowBalanceThreshold ?? null, cost_per_unit: p.costPerUnit ?? null,
    };
    if (secret) row.credentials = secret;
    const id = ex ? String(ex.id) : ulid();
    if (ex) await this.db.update('messaging_providers', { ...row, updated_at: nowSql() }, { id });
    else await this.db.insert('messaging_providers', { id, school_id: schoolId, balance: null, credentials: null, ...row });
    if (row.is_default) await this.db.execute(`UPDATE messaging_providers SET is_default = FALSE WHERE school_id = ? AND channel = ? AND id <> ?`, [schoolId, p.channel, id]);
    return { id, created: !ex };
  }
  /** The credentials, for the server only — nothing that answers a browser may call this. */
  providerCredentials(provider: Row): Record<string, string> {
    const raw = json<Record<string, unknown>>(provider.credentials) ?? {};
    if (typeof raw.enc === 'string') { try { return JSON.parse(decryptSecret(raw.enc, this.appKey)) as Record<string, string>; } catch { return {}; } }
    return raw as Record<string, string>;
  }

  async createPtmSlots(schoolId: string, s: { teacherId: string; date: string; startTime: string; endTime: string; minutes: number; capacity?: number; roomId?: string | null; mode?: 'in_person' | 'online' }) {
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const start = toMin(s.startTime), end = toMin(s.endTime);
    if (end <= start) throw badRequest('end before start');
    const rows: Row[] = []; const ids: string[] = [];
    for (let t = start; t + s.minutes <= end; t += s.minutes) {
      const id = ulid(); ids.push(id);
      const at = (m: number) => `${s.date} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
      rows.push({ id, school_id: schoolId, event_id: null, teacher_id: s.teacherId, starts_at: at(t), ends_at: at(t + s.minutes), capacity: s.capacity ?? 1, room_id: s.roomId ?? null, mode: s.mode ?? 'in_person', join_url: null });
    }
    if (rows.length) await this.db.insertMany('ptm_slots', rows);
    return { created: rows.length, ids };
  }
  async ptmSlots(schoolId: string, f: { teacherId?: string; from?: string } = {}) {
    const where = ['s.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.teacherId) { where.push('s.teacher_id = ?'); params.push(f.teacherId); }
    where.push('s.starts_at >= ?'); params.push(f.from ?? nowSql());
    return this.db.query<Row>(`SELECT s.*, st.first_name, st.last_name, r.name AS room_name, (SELECT COUNT(*) FROM ptm_bookings b WHERE b.slot_id = s.id AND b.status = 'booked') AS booked FROM ptm_slots s JOIN staff st ON st.id = s.teacher_id LEFT JOIN rooms r ON r.id = s.room_id WHERE ${where.join(' AND ')} ORDER BY s.starts_at LIMIT 300`, params);
  }
  async bookPtm(schoolId: string, slotId: string, studentId: string, guardianId: string) {
    const slot = await this.db.findOne<Row>('ptm_slots', { id: slotId, school_id: schoolId });
    if (!slot) throw notFound('slot');
    // an existing booking for the same child is a no-op, checked before capacity so re-tapping "book" is safe
    const dup = await this.db.findOne('ptm_bookings', { slot_id: slotId, student_id: studentId, status: 'booked' });
    if (dup) return { id: String((dup as Row).id), already: true };
    const booked = await this.db.count('ptm_bookings', { slot_id: slotId, status: 'booked' });
    if (booked >= Number(slot.capacity)) throw new HttpError(409, 'that slot is full', 'full');
    const id = ulid();
    await this.db.insert('ptm_bookings', { id, school_id: schoolId, slot_id: slotId, student_id: studentId, guardian_id: guardianId, status: 'booked', notes: null });
    const teacher = await this.db.findOne<Row>('staff', { id: String(slot.teacher_id) });
    if (teacher?.user_id) await this.notifications.notify({ schoolId, userId: String(teacher.user_id), channels: ['push', 'in_app'], eventKey: 'ptm.booked', title: 'PTM booked', body: `A guardian booked ${String(slot.starts_at).slice(0, 16)}.`, entityType: 'communication.ptm', entityId: id });
    return { id, already: false };
  }
  async ptmBookings(schoolId: string, f: { teacherId?: string; guardianId?: string } = {}) {
    const where = ['b.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.teacherId) { where.push('s.teacher_id = ?'); params.push(f.teacherId); }
    if (f.guardianId) { where.push('b.guardian_id = ?'); params.push(f.guardianId); }
    return this.db.query<Row>(`SELECT b.*, s.starts_at, s.ends_at, s.mode, st.first_name AS teacher_first, st.last_name AS teacher_last, stu.first_name AS student_first, stu.last_name AS student_last FROM ptm_bookings b JOIN ptm_slots s ON s.id = b.slot_id JOIN staff st ON st.id = s.teacher_id JOIN students stu ON stu.id = b.student_id WHERE ${where.join(' AND ')} ORDER BY s.starts_at LIMIT 200`, params);
  }

  // ---------- diary ----------
  async addDiary(schoolId: string, d: { sectionId: string; onDate: string; teacherId?: string | null; classSubjectId?: string | null; entryType?: 'homework' | 'note' | 'reminder' | 'announcement'; body: string; dueDate?: string | null; attachments?: unknown }) {
    const id = ulid();
    await this.db.insert('diary_entries', { id, school_id: schoolId, section_id: d.sectionId, on_date: d.onDate, teacher_id: d.teacherId ?? null, class_subject_id: d.classSubjectId ?? null, entry_type: d.entryType ?? 'homework', body: d.body, attachments: (d.attachments ?? null) as never, due_date: d.dueDate ?? null });
    const guardians = await this.db.query<{ user_id: string }>(`SELECT DISTINCT u.id AS user_id FROM student_enrollments e JOIN student_guardians sg ON sg.student_id = e.student_id JOIN guardians g ON g.id = sg.guardian_id JOIN users u ON u.id = g.user_id WHERE e.section_id = ? AND e.status = 'active' AND sg.receives_notifications = TRUE`, [d.sectionId]);
    for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, channels: ['push', 'in_app'], eventKey: 'diary.entry', title: d.entryType === 'homework' ? 'Homework' : 'Class diary', body: d.body.slice(0, 140), entityType: 'diary.entry', entityId: id });
    return { id, notified: guardians.length };
  }
  async diary(schoolId: string, f: { sectionId?: string; studentId?: string; from?: string; to?: string }) {
    const where = ['d.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.sectionId) { where.push('d.section_id = ?'); params.push(f.sectionId); }
    if (f.studentId) { where.push('d.section_id = (SELECT current_section_id FROM students WHERE id = ?)'); params.push(f.studentId); }
    if (f.from) { where.push('d.on_date >= ?'); params.push(f.from); }
    if (f.to) { where.push('d.on_date <= ?'); params.push(f.to); }
    return this.db.query<Row>(`SELECT d.*, s.name AS subject_name, sec.name AS section_name, c.name AS class_name, st.first_name AS teacher_first FROM diary_entries d LEFT JOIN class_subjects cs ON cs.id = d.class_subject_id LEFT JOIN subjects s ON s.id = cs.subject_id JOIN sections sec ON sec.id = d.section_id JOIN classes c ON c.id = sec.class_id LEFT JOIN staff st ON st.id = d.teacher_id WHERE ${where.join(' AND ')} ORDER BY d.on_date DESC, d.created_at DESC LIMIT 100`, params);
  }
  async ackDiary(schoolId: string, entryId: string, studentId: string, guardianId?: string | null) {
    const ex = await this.db.findOne('diary_acknowledgements', { entry_id: entryId, student_id: studentId });
    if (ex) return { already: true };
    await this.db.insert('diary_acknowledgements', { id: ulid(), school_id: schoolId, entry_id: entryId, student_id: studentId, guardian_id: guardianId ?? null, acked_at: nowSql() });
    return { already: false };
  }
  /** KG daily report: meals, nap, mood, activities — one row per child per day, pushed to guardians when sent. */
  async saveDailyReport(schoolId: string, r: { studentId: string; onDate: string; meals?: unknown; napMinutes?: number | null; mood?: 'happy' | 'calm' | 'tired' | 'upset' | 'sick' | null; activities?: unknown; toilet?: unknown; notes?: string | null; teacherId?: string | null; send?: boolean }) {
    const ex = await this.db.findOne<Row>('daily_reports', { student_id: r.studentId, on_date: r.onDate });
    const row: Row = { school_id: schoolId, student_id: r.studentId, on_date: r.onDate, meals: (r.meals ?? null) as never, nap_minutes: r.napMinutes ?? null, mood: r.mood ?? null, activities: (r.activities ?? null) as never, toilet: (r.toilet ?? null) as never, notes: r.notes ?? null, teacher_id: r.teacherId ?? null, sent_at: r.send ? nowSql() : (ex?.sent_at as string) ?? null };
    const id = ex ? String(ex.id) : ulid();
    if (ex) await this.db.update('daily_reports', { ...row, updated_at: nowSql() }, { id }); else await this.db.insert('daily_reports', { id, ...row });
    if (r.send) {
      const guardians = await this.db.query<{ user_id: string }>(`SELECT u.id AS user_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id JOIN users u ON u.id = g.user_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [r.studentId]);
      const student = await this.db.findOne<Row>('students', { id: r.studentId });
      for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, channels: ['push', 'in_app'], eventKey: 'diary.daily_report', title: 'Daily report', body: `${student?.first_name ?? 'Your child'}: ${r.mood ?? 'day'} · ${r.notes?.slice(0, 100) ?? ''}`, entityType: 'diary.daily_report', entityId: id });
    }
    return { id };
  }
  async dailyReports(schoolId: string, f: { sectionId?: string; studentId?: string; onDate: string }) {
    const where = ['r.school_id = ?', 'r.on_date = ?']; const params: unknown[] = [schoolId, f.onDate];
    if (f.studentId) { where.push('r.student_id = ?'); params.push(f.studentId); }
    if (f.sectionId) { where.push('s.current_section_id = ?'); params.push(f.sectionId); }
    return this.db.query<Row>(`SELECT r.*, s.first_name, s.last_name FROM daily_reports r JOIN students s ON s.id = r.student_id WHERE ${where.join(' AND ')} ORDER BY s.first_name`, params);
  }
  async addRemark(schoolId: string, r: { studentId: string; teacherId: string; onDate?: string; remark: string; polarity?: 'positive' | 'neutral' | 'concern'; visibleToGuardian?: boolean }) {
    const id = ulid();
    await this.db.insert('student_remarks', { id, school_id: schoolId, student_id: r.studentId, teacher_id: r.teacherId, on_date: r.onDate ?? nowSql().slice(0, 10), remark: r.remark, polarity: r.polarity ?? 'neutral', visible_to_guardian: r.visibleToGuardian ?? true });
    if (r.visibleToGuardian !== false) {
      const guardians = await this.db.query<{ user_id: string }>(`SELECT u.id AS user_id FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id JOIN users u ON u.id = g.user_id WHERE sg.student_id = ?`, [r.studentId]);
      for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, channels: ['push', 'in_app'], eventKey: 'diary.remark', title: r.polarity === 'concern' ? 'A note from the teacher' : 'Teacher remark', body: r.remark.slice(0, 140), entityType: 'diary.remark', entityId: id });
    }
    return id;
  }
}
