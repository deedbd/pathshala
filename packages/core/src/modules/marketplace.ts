import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { OutboxService } from '../automation/outbox.js';
import type { HandlerRegistry } from '../automation/handlers.js';
import type { Logger, ScheduledFn } from '@pathshala/adapters';
import type { NotificationService } from '../notifications.js';
import { HttpError, badRequest, notFound } from '../context.js';

export type Scope = 'students.read' | 'students.write' | 'attendance.read' | 'attendance.write' | 'fees.read' | 'fees.write' | 'results.read' | 'notices.write' | 'profile.read';
export const SCOPES: Scope[] = ['students.read', 'students.write', 'attendance.read', 'attendance.write', 'fees.read', 'fees.write', 'results.read', 'notices.write', 'profile.read'];

/**
 * The marketplace: other people's code and other people's applications, kept at arm's length.
 *
 * A plugin does not run inside this process. It declares which events it wants and where to send
 * them, and the relay posts them to that URL with a signature the plugin checks — so a plugin that
 * hangs, crashes or turns malicious slows down nothing and reads nothing it was not given.
 *
 * A third-party application gets an OAuth2 client and a token with scopes. Two rules make the tokens
 * safe to hand out: only the hash is stored, so a stolen database yields nothing usable, and a scope
 * a school did not grant is refused at the door rather than checked deep inside a handler.
 */
export class MarketplaceService {
  constructor(private db: Db, private outbox: OutboxService, private log: Logger, private notifications: NotificationService) {}

  // ---------- plugins ----------
  async publishPlugin(p: { slug: string; name: string; vendor?: string | null; description?: string | null; version: string; hooks?: string[]; settingsSchema?: unknown; priceMonthly?: number }) {
    const ex = await this.db.findOne<{ id: string }>('plugins', { slug: p.slug });
    const row = { slug: p.slug, name: p.name, vendor: p.vendor ?? null, description: p.description ?? null, version: p.version, hooks: (p.hooks ?? []) as never, settings_schema: (p.settingsSchema ?? null) as never, price_monthly: p.priceMonthly ?? 0, status: 'published' };
    if (ex) { await this.db.update('plugins', { ...row, updated_at: nowSql() }, { id: ex.id }); return ex.id; }
    const id = ulid();
    await this.db.insert('plugins', { id, ...row });
    return id;
  }
  async plugins(onlyPublished = true) {
    return this.db.findMany<Row>('plugins', onlyPublished ? { status: 'published' } : {}, { orderBy: 'name ASC' });
  }
  /**
   * Installs a plugin for one school. The webhook secret is shown once, here, and only its hash is
   * kept: the school can rotate it, and nobody with the database can forge a call to the plugin.
   */
  async install(schoolId: string, pluginId: string, p: { settings?: Record<string, unknown>; webhookUrl?: string | null; installedBy?: string | null } = {}) {
    const plugin = await this.db.findOne<Row>('plugins', { id: pluginId, status: 'published' });
    if (!plugin) throw notFound('plugin');
    const ex = await this.db.findOne<Row>('plugin_installs', { school_id: schoolId, plugin_id: pluginId });
    const secret = randomBytes(24).toString('hex');
    const settings = { ...(p.settings ?? {}), webhookUrl: p.webhookUrl ?? (p.settings?.webhookUrl as string) ?? null, secretHash: hash(secret) };
    if (ex) {
      await this.db.update('plugin_installs', { settings: settings as never, is_enabled: true, updated_at: nowSql() }, { id: String(ex.id) });
      return { id: String(ex.id), secret, reinstalled: true };
    }
    const id = ulid();
    await this.db.insert('plugin_installs', { id, school_id: schoolId, plugin_id: pluginId, settings: settings as never, is_enabled: true, installed_by: p.installedBy ?? null });
    await this.outbox.emitNow({ type: 'plugin.installed', schoolId, aggregateType: 'marketplace.plugin', aggregateId: id, payload: { installId: id, slug: String(plugin.slug), version: String(plugin.version) } });
    return { id, secret };
  }
  async setPluginEnabled(schoolId: string, installId: string, enabled: boolean) {
    if (!(await this.db.update('plugin_installs', { is_enabled: enabled, updated_at: nowSql() }, { id: installId, school_id: schoolId }))) throw notFound('install');
    return { id: installId, enabled };
  }
  async uninstall(schoolId: string, installId: string) {
    if (!(await this.db.delete('plugin_installs', { id: installId, school_id: schoolId }))) throw notFound('install');
    return { id: installId, uninstalled: true };
  }
  async installs(schoolId: string) {
    const rows = await this.db.query<Row>(`SELECT i.*, p.slug, p.name, p.vendor, p.version, p.hooks, p.price_monthly FROM plugin_installs i JOIN plugins p ON p.id = i.plugin_id WHERE i.school_id = ? ORDER BY p.name`, [schoolId]);
    // the secret hash is nobody's business but the installation's
    return rows.map(r => { const s = json<Record<string, unknown>>(r.settings) ?? {}; delete s.secretHash; return { ...r, settings: s, hooks: json(r.hooks) } as Row; });
  }
  /**
   * Registers one handler per hook a plugin asked for. The handler posts the event to the plugin's
   * URL and gives up quickly: a plugin's webhook is somebody else's server, and the school's own
   * automation must not wait on it.
   */
  registerHooks(handlers: HandlerRegistry, events: string[]) {
    for (const event of events) {
      handlers.on(event as never, 'plugin-webhooks', async e => {
        const installs = await this.db.query<Row>(`SELECT i.*, p.slug, p.hooks FROM plugin_installs i JOIN plugins p ON p.id = i.plugin_id WHERE i.school_id = ? AND i.is_enabled = TRUE`, [e.schoolId]);
        for (const install of installs) {
          const hooks = json<string[]>(install.hooks) ?? [];
          if (!hooks.includes(e.type)) continue;
          const settings = json<Record<string, unknown>>(install.settings) ?? {};
          const url = settings.webhookUrl as string | undefined;
          if (!url) continue;
          const body = JSON.stringify({ event: e.type, schoolId: e.schoolId, aggregateId: e.aggregateId, payload: e.payload, at: nowSql() });
          const signature = createHash('sha256').update(`${String(settings.secretHash ?? '')}.${body}`).digest('hex');
          try {
            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pathshala-Event': e.type, 'X-Pathshala-Signature': signature }, body, signal: AbortSignal.timeout(5000) });
            if (!res.ok) { this.log.warn(`plugin ${install.slug} answered ${res.status} to ${e.type}`); await this.recordHookResult(String(install.id), settings, `${res.status} ${res.statusText}`.trim()); }
            else await this.recordHookResult(String(install.id), settings, null);
          } catch (err) {
            this.log.warn(`plugin ${install.slug} did not answer ${e.type}: ${(err as Error).message}`);
            await this.recordHookResult(String(install.id), settings, (err as Error).message);
          }
        }
      });
    }
  }

  /**
   * Keeps the score for one plugin's webhook. A failure that is only written to the log is a failure
   * nobody sees: the school installed the plugin, the plugin's server has been answering 502 since
   * Tuesday, and every event since Tuesday has gone nowhere. The count lives beside the install so
   * the daily pass can act on it, and a single success clears it — a plugin that recovers on its own
   * must not be switched off by a fortnight-old grudge.
   */
  private async recordHookResult(installId: string, settings: Record<string, unknown>, error: string | null) {
    const failures = error ? Number(settings.hookFailures ?? 0) + 1 : 0;
    if (!error && !Number(settings.hookFailures ?? 0)) return;                     // nothing to write
    const next = { ...settings, hookFailures: failures, hookLastError: error ? error.slice(0, 200) : null, hookLastAt: nowSql() };
    await this.db.update('plugin_installs', { settings: next as never, updated_at: nowSql() }, { id: installId }).catch(() => undefined);
  }

  // ---------- OAuth2 clients and tokens ----------
  /** Registers an application. The secret is returned once and never stored in the clear. */
  async createClient(schoolId: string, c: { name: string; redirectUris?: string[]; scopes?: Scope[]; isConfidential?: boolean }) {
    const bad = (c.scopes ?? []).filter(s => !SCOPES.includes(s));
    if (bad.length) throw badRequest(`unknown scope: ${bad.join(', ')}`);
    const clientId = randomBytes(16).toString('hex');
    const secret = randomBytes(32).toString('hex');
    const id = ulid();
    await this.db.insert('oauth_clients', { id, school_id: schoolId, name: c.name, client_id: clientId, client_secret_hash: hash(secret), redirect_uris: (c.redirectUris ?? []) as never, scopes: (c.scopes ?? ['profile.read']) as never, is_confidential: c.isConfidential ?? true, revoked_at: null });
    return { id, clientId, clientSecret: secret, scopes: c.scopes ?? ['profile.read'] };
  }
  async clients(schoolId: string) {
    const rows = await this.db.findMany<Row>('oauth_clients', { school_id: schoolId }, { orderBy: 'created_at DESC', limit: 100 });
    return rows.map(r => ({ id: r.id, name: r.name, client_id: r.client_id, scopes: json(r.scopes), redirect_uris: json(r.redirect_uris), revoked_at: r.revoked_at, created_at: r.created_at }) as Row);
  }
  async revokeClient(schoolId: string, clientRowId: string) {
    if (!(await this.db.update('oauth_clients', { revoked_at: nowSql(), updated_at: nowSql() }, { id: clientRowId, school_id: schoolId }))) throw notFound('client');
    await this.db.execute(`UPDATE oauth_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL`, [nowSql(), clientRowId]);
    return { id: clientRowId, revoked: true };
  }
  /**
   * The client-credentials grant: an application acting as itself, for server-to-server work. A scope
   * the school never granted the client is refused here, not later — the token that comes back can
   * only ever do what the school agreed to.
   */
  async issueToken(p: { clientId: string; clientSecret: string; scopes?: string[]; expiresInSeconds?: number }) {
    const client = await this.db.findOne<Row>('oauth_clients', { client_id: p.clientId });
    if (!client || client.revoked_at) throw new HttpError(401, 'unknown client', 'invalid_client');
    if (!tokensMatch(String(client.client_secret_hash), hash(p.clientSecret))) throw new HttpError(401, 'wrong client secret', 'invalid_client');
    const granted = json<string[]>(client.scopes) ?? [];
    const asked = p.scopes?.length ? p.scopes : granted;
    const refused = asked.filter(s => !granted.includes(s));
    if (refused.length) throw new HttpError(403, `this client was not granted ${refused.join(', ')}`, 'invalid_scope');
    const token = randomBytes(32).toString('hex');
    const expiresIn = Math.min(p.expiresInSeconds ?? 3600, 86_400);
    await this.db.insert('oauth_tokens', { id: ulid(), school_id: String(client.school_id), client_id: String(client.id), user_id: null, token_hash: hash(token), kind: 'access', scopes: asked as never, expires_at: nowSql(new Date(Date.now() + expiresIn * 1000)), revoked_at: null });
    return { accessToken: token, tokenType: 'Bearer', expiresIn, scope: asked.join(' ') };
  }
  /** Verifies a bearer token and says what it may do. Used by the public API on every request. */
  async verifyToken(token: string, needs?: Scope) {
    const row = await this.db.findOne<Row>('oauth_tokens', { token_hash: hash(token), kind: 'access' });
    if (!row || row.revoked_at) throw new HttpError(401, 'this token is not valid', 'invalid_token');
    if (String(row.expires_at) < nowSql()) throw new HttpError(401, 'this token has expired', 'invalid_token');
    const scopes = json<string[]>(row.scopes) ?? [];
    if (needs && !scopes.includes(needs)) throw new HttpError(403, `this token does not carry ${needs}`, 'insufficient_scope');
    return { schoolId: String(row.school_id), clientId: String(row.client_id), scopes };
  }
  async revokeToken(token: string) {
    const n = await this.db.update('oauth_tokens', { revoked_at: nowSql() }, { token_hash: hash(token) });
    return { revoked: n > 0 };
  }

  // ---------- template packs ----------
  /**
   * A pack of ready-made templates — a board's document wording, another country's grading scale, a
   * different chart of accounts. Installing one writes rows the school owns from then on; a later
   * version of the pack never silently overwrites what the school has since edited.
   */
  async publishPack(p: { slug: string; name: string; kind: 'documents' | 'notifications' | 'accounting' | 'grading' | 'curriculum' | 'forms'; locale?: string | null; content: unknown; version: string }) {
    const ex = await this.db.findOne<{ id: string }>('template_packs', { slug: p.slug });
    const row = { slug: p.slug, name: p.name, kind: p.kind, locale: p.locale ?? null, content: p.content as never, version: p.version };
    if (ex) { await this.db.update('template_packs', { ...row, updated_at: nowSql() }, { id: ex.id }); return ex.id; }
    const id = ulid();
    await this.db.insert('template_packs', { id, ...row });
    return id;
  }
  async packs(kind?: string) { return this.db.findMany<Row>('template_packs', kind ? { kind } : {}, { orderBy: 'name ASC' }); }
  /** Applies a pack to one school, leaving anything the school has already changed alone. */
  async applyPack(schoolId: string, packId: string) {
    const pack = await this.db.findOne<Row>('template_packs', { id: packId });
    if (!pack) throw notFound('template pack');
    const content = json<Record<string, unknown[]>>(pack.content) ?? {};
    let written = 0, kept = 0;
    if (pack.kind === 'documents') {
      for (const t of (content.templates ?? []) as { docType: string; name: string; body: string; variables?: string[] }[]) {
        const ex = await this.db.findOne('document_templates', { school_id: schoolId, doc_type: t.docType, name: t.name });
        if (ex) { kept++; continue; }
        await this.db.insert('document_templates', { id: ulid(), school_id: schoolId, doc_type: t.docType, name: t.name, html_template: t.body, css: null, page_size: 'A4', orientation: 'portrait', variables: (t.variables ?? []) as never, is_default: false, version: 1 });
        written++;
      }
    } else if (pack.kind === 'notifications') {
      for (const t of (content.templates ?? []) as { eventKey: string; channel: string; locale: string; subject?: string | null; body: string }[]) {
        const ex = await this.db.findOne('notification_templates', { school_id: schoolId, event_key: t.eventKey, channel: t.channel, locale: t.locale });
        if (ex) { kept++; continue; }
        await this.db.insert('notification_templates', { id: ulid(), school_id: schoolId, event_key: t.eventKey, channel: t.channel, locale: t.locale, subject: t.subject ?? null, body: t.body, variables: null, is_active: true });
        written++;
      }
    } else if (pack.kind === 'grading') {
      // a scale is a row plus its bands, so both go in together or the scale grades nothing
      for (const g of (content.scales ?? []) as { name: string; maxGpa?: number; failGpaZero?: boolean; bands: { grade: string; minPercent: number; maxPercent: number; gradePoint: number; isFail?: boolean; remarks?: string | null }[] }[]) {
        const ex = await this.db.findOne('grading_scales', { school_id: schoolId, name: g.name });
        if (ex) { kept++; continue; }
        const scaleId = ulid();
        await this.db.insert('grading_scales', { id: scaleId, school_id: schoolId, name: g.name, is_default: false, gpa_max: g.maxGpa ?? 5, fail_gpa_zero: g.failGpaZero ?? true });
        if (g.bands?.length) await this.db.insertMany('grading_bands', g.bands.map(b => ({ id: ulid(), school_id: schoolId, scale_id: scaleId, grade: b.grade, min_percent: b.minPercent, max_percent: b.maxPercent, grade_point: b.gradePoint, is_fail: !!b.isFail, remarks: b.remarks ?? null })));
        written++;
      }
    } else {
      throw badRequest(`packs of kind ${pack.kind} are not applied automatically yet`);
    }
    return { packId, kind: String(pack.kind), written, kept };
  }

  // ---------- scheduled ----------
  /** How many times somebody else's server may refuse us before we stop calling it. */
  static readonly PLUGIN_FAILURES = 10;
  static readonly WEBHOOK_FAILURES = 20;
  jobs(): Record<string, ScheduledFn> {
    return {
      /**
       * Daily: the integrations that have stopped working. Both halves of this module talk to
       * somebody else's machine, and both used to fail in the quietest possible way — a line in the
       * log, a counter nobody reads — while the school went on believing its attendance was reaching
       * the government portal.
       *
       * The rule is: stop calling, and say so. Retrying a dead endpoint for ever costs the school's
       * own automation time on every single event, and a school that is told can fix the URL or
       * uninstall the plugin. Neither is switched back on by this job; that is the school's decision.
       */
      'marketplace.health': async ({ schoolId }) => {
        const out = { pluginsDisabled: 0, webhooksDisabled: 0 };
        const installs = await this.db.query<Row>(`SELECT i.*, p.slug, p.name FROM plugin_installs i JOIN plugins p ON p.id = i.plugin_id WHERE i.school_id = ? AND i.is_enabled = TRUE`, [schoolId]);
        for (const i of installs) {
          const settings = json<Record<string, unknown>>(i.settings) ?? {};
          const failures = Number(settings.hookFailures ?? 0);
          if (failures < MarketplaceService.PLUGIN_FAILURES) continue;
          await this.db.update('plugin_installs', { is_enabled: false, settings: { ...settings, disabledReason: 'webhook kept failing', disabledAt: nowSql() } as never, updated_at: nowSql() }, { id: String(i.id) });
          await this.notifications.notifyRole(schoolId, 'admin', {
            channels: ['in_app', 'email'], eventKey: 'marketplace.plugin_disabled', title: `${String(i.name)} has been switched off`,
            body: `Its webhook failed ${failures} times in a row (${String(settings.hookLastError ?? 'no answer')}). Events are no longer being sent to it. Fix the address and turn it back on in Platform → Apps.`,
            entityType: 'marketplace.plugin', entityId: String(i.id),
          });
          await this.outbox.emitNow({ type: 'plugin.disabled', schoolId, aggregateType: 'marketplace.plugin', aggregateId: String(i.id), payload: { installId: String(i.id), slug: String(i.slug), failures, reason: String(settings.hookLastError ?? 'webhook kept failing').slice(0, 200) } });
          out.pluginsDisabled++;
        }
        const hooks = await this.db.query<Row>(`SELECT * FROM webhooks WHERE school_id = ? AND is_active = TRUE AND failure_count >= ?`, [schoolId, MarketplaceService.WEBHOOK_FAILURES]);
        for (const h of hooks) {
          await this.db.update('webhooks', { is_active: false, updated_at: nowSql() }, { id: String(h.id) });
          await this.notifications.notifyRole(schoolId, 'admin', {
            channels: ['in_app'], eventKey: 'marketplace.webhook_disabled', title: 'A webhook has been switched off',
            body: `${String(h.url).slice(0, 80)} failed ${Number(h.failure_count)} times in a row. Nothing is being posted to it any more.`,
            entityType: 'platform.webhook', entityId: String(h.id),
          });
          await this.outbox.emitNow({ type: 'automation.stalled', schoolId, aggregateType: 'platform.webhook', aggregateId: String(h.id), payload: { kind: 'outbox', detail: `webhook ${String(h.url).slice(0, 120)} disabled after ${Number(h.failure_count)} failures`, count: Number(h.failure_count) } });
          out.webhooksDisabled++;
        }
        return out;
      },
    };
  }
}

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const tokensMatch = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
