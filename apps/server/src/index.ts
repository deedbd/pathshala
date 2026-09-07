import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createRequestHandler } from '@react-router/express';
import { createApp, runWithContext, normalizeBdPhone, HttpError, type App, type UserRow, type SessionRow, type RequestContext } from '@pathshala/core';
import { LocalStorage, SseRealtime } from '@pathshala/adapters';
import { installSchoolSchema, loginSchema, otpRequestSchema, otpVerifySchema, settingWriteSchema, z } from '@pathshala/schemas';
import { mountPhase1, mountPublic } from './routes/phase1.js';
import { mountPhase2 } from './routes/phase2.js';
import { mountPhase3 } from './routes/phase3.js';
import { mountPhase4 } from './routes/phase4.js';
import { mountPhase5, mountPublicHr } from './routes/phase5.js';
import { mountPhase6, mountPublicAdmissions } from './routes/phase6.js';
import { mountPhase7 } from './routes/phase7.js';
import { mountPhase8 } from './routes/phase8.js';
import { mountPhase9 } from './routes/phase9.js';
import { mountPhase10, mountPublicGiving } from './routes/phase10.js';
import { mountPhase11 } from './routes/phase11.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SESSION_COOKIE = 'ps_session';

export interface RequestState { user: UserRow | null; session: SessionRow | null; token: string | null; locale: 'bn' | 'en'; requestId: string }
declare global { namespace Express { interface Request { ps: RequestState } } }

export async function createServer(app: App = createApp()) {
  const { config, log } = app;
  const server = express();
  server.disable('x-powered-by');
  server.set('trust proxy', true);
  // Body parsers only under /api and /cron: React Router actions read the raw stream themselves (request.formData()).
  server.use('/api/import', express.raw({ type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/octet-stream'], limit: '16mb' }));
  server.use(['/api', '/cron'], express.json({ limit: '20mb' }), express.urlencoded({ extended: true, limit: '2mb' }));
  server.get('/favicon.ico', (_req, res) => res.status(204).end());

  // ---- per-request context: session → user → tenant → AsyncLocalStorage ----
  server.use(async (req, res, next) => {
    const requestId = String(req.headers['x-request-id'] || randomUUID());
    res.setHeader('X-Request-Id', requestId);
    const cookies = parseCookies(req.headers.cookie);
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    let user: UserRow | null = null, session: SessionRow | null = null;
    const token = cookies[SESSION_COOKIE] ?? bearer ?? null;
    try { const r = await app.auth.resolveSession(token); if (r) { user = r.user; session = r.session; } } catch (e) { /* schema not installed yet */ }
    const locale = ((user?.locale as 'bn' | 'en') || (cookies.ps_locale as 'bn' | 'en') || 'bn');
    req.ps = { user, session, token, locale, requestId };
    const ctx: RequestContext = { requestId, schoolId: user?.school_id ?? null, userId: user?.id ?? null, actorType: user ? 'user' : 'system', locale, ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
    if (user) { const a = await app.rbac.accessFor(user.id); ctx.roles = a.roles; ctx.permissions = a.permissions; }
    runWithContext(ctx, () => next());
  });

  // ---- health, cron, heartbeat ----
  server.get('/_health', async (_req, res) => {
    let dbOk = false; try { await app.db.query('SELECT 1 AS ok'); dbOk = true; } catch { /* down */ }
    res.json({ ok: dbOk, engine: app.db.engine, installed: await app.installer.isInstalled(), mode: app.adapters.mode, version: process.env.APP_VERSION ?? '0.1.0', node: process.version });
  });
  server.all('/cron/tick', async (req, res) => {
    const key = String(req.query.key ?? req.headers['x-cron-key'] ?? '');
    if (key !== config.cronKey) return res.status(403).json({ error: 'bad cron key' });
    res.json(await app.tick());
  });
  server.use((req, _res, next) => { if (!req.path.startsWith('/install') && !req.path.startsWith('/api/install') && !req.path.startsWith('/assets')) app.heartbeat(); next(); });

  // ---- signed private files (local storage) ----
  server.get('/files/*rel', async (req, res, next) => {
    const storage = app.adapters.storage;
    if (!(storage instanceof LocalStorage)) return next();
    const rel = decodeURI((req.params as { rel: string | string[] }).rel.toString().split(',').join('/'));
    const exp = Number(req.query.exp), sig = String(req.query.sig ?? '');
    if (!storage.verify(rel, exp, sig)) return res.status(403).send('link expired');
    if (!(await storage.exists(rel))) return res.status(404).send('not found');
    res.setHeader('Cache-Control', 'private, max-age=300');
    (await storage.get(rel)).pipe(res);
  });

  // ---- realtime (SSE) ----
  if (app.adapters.realtime instanceof SseRealtime) {
    const rt = app.adapters.realtime;
    server.get('/events', (req, res) => {
      if (!req.ps.user) return res.status(401).end();
      const u = req.ps.user;
      rt.handler(() => [`user:${u.id}`, `school:${u.school_id}:automation`])(req as never, res);
    });
  }

  // see tuneKeepAlive: the client must give up on an idle socket well before the server does
  server.use((_req, res, next) => { res.setHeader('Keep-Alive', `timeout=${KEEP_ALIVE_ADVERTISED_SECONDS}`); next(); });

  // ---- API ----
  const api = express.Router();
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).then(r => { if (r !== undefined && !res.headersSent) res.json(r); }).catch(next);
  const requireUser = (req: Request) => { if (!req.ps.user) throw new HttpError(401, 'sign in required', 'unauthorized'); return req.ps.user; };
  /**
   * Console endpoints. Portal accounts (guardian, student, alumni) never reach them even when their
   * role carries the permission — a guardian reads their child's data through /api/portal/*, which
   * checks the parent-child link instead of a role.
   */
  const requirePerm = (req: Request, perm: string) => {
    const u = requireUser(req);
    if (['guardian', 'student', 'alumni'].includes(u.user_type)) throw new HttpError(403, 'this is a school-staff endpoint', 'forbidden');
    app.rbac.require(perm);
    return u;
  };
  const setSessionCookie = (req: Request, res: Response, token: string, expiresAt: string) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt.replace(' ', 'T') + 'Z').toUTCString()}${req.secure || config.appUrl.startsWith('https') ? '; Secure' : ''}`);
  };

  // installer (only while not installed)
  api.use('/install', async (req, res, next) => { if (await app.installer.isInstalled()) return res.status(410).json({ error: 'already installed' }); next(); });
  api.get('/install/status', wrap(async () => app.installer.status()));
  api.post('/install/prepare', wrap(async () => { void app.installer.runPrepare(); return { started: true }; }));
  api.post('/install/school', wrap(async (req, res) => {
    const input = installSchoolSchema.parse(req.body);
    const r = await app.installer.createSchool(input);
    const user = await app.auth.findByIdentifier(input.adminPhone, r.schoolId);
    if (user) { const s = await app.auth.createSession(user, { platform: 'web', ip: req.ip, userAgent: req.headers['user-agent'] }); setSessionCookie(req, res, s.token, s.expiresAt); }
    return r;
  }));
  api.post('/install/selftest', wrap(async () => { const st = await app.installer.status(); if (!st.school) throw new HttpError(400, 'create the school first'); return app.installer.runSelfTest(st.school.id); }));
  api.post('/install/finish', wrap(async () => { const st = await app.installer.status(); if (!st.school) throw new HttpError(400, 'create the school first'); await app.installer.finish(st.school.id); return { ok: true, url: config.appUrl }; }));

  // auth
  api.post('/auth/login', wrap(async (req, res) => {
    const input = loginSchema.parse(req.body);
    await verifyTurnstile(config.env, input.turnstile, req.ip);
    const r = await app.auth.login({ identifier: input.identifier, password: input.password, totp: input.totp || undefined, platform: 'web', ip: req.ip, userAgent: req.headers['user-agent'], remember: input.remember });
    if ('totpRequired' in r) return { totpRequired: true };
    setSessionCookie(req, res, r.token, r.expiresAt);
    return { user: publicUser(r.user), accessToken: app.auth.accessToken(r.user, r.sessionId) };
  }));
  // asking for codes is throttled by target whether or not the number belongs to anybody: the reply is
  // deliberately the same either way, so without this an attacker could enumerate numbers for free.
  // Per process, which on Passenger is the whole app; the database limit in AuthService is the real one.
  const otpAsks = new Map<string, number[]>();
  const OTP_ASKS_PER_10MIN = 5;
  api.post('/auth/otp/request', wrap(async req => {
    const input = otpRequestSchema.parse(req.body);
    await verifyTurnstile(config.env, input.turnstile, req.ip);
    const key = `${input.target}`.toLowerCase();
    const recent = (otpAsks.get(key) ?? []).filter(t => Date.now() - t < 600_000);
    if (recent.length >= OTP_ASKS_PER_10MIN) throw new HttpError(429, 'too many codes requested; wait 10 minutes', 'rate_limited');
    recent.push(Date.now());
    otpAsks.set(key, recent);
    if (otpAsks.size > 5000) for (const [k, v] of otpAsks) if (!v.some(t => Date.now() - t < 600_000)) otpAsks.delete(k);
    let user = await app.auth.findByIdentifier(input.target);
    if (!user) { // a guardian on file gets a portal account the first time they ask for a code
      const g = await app.db.findOne<{ id: string; school_id: string }>('guardians', { phone: input.target.includes('@') ? '__' : normalizeBdPhone(input.target) ?? '__' });
      if (g) { await app.people.ensureGuardianAccount(g.school_id, g.id); user = await app.auth.findByIdentifier(input.target); }
    }
    if (!user) return { sent: true }; // do not reveal whether the number exists
    return { sent: true, ...(await app.auth.issueOtp({ schoolId: user.school_id, target: input.target, channel: input.channel, purpose: input.purpose, userId: user.id })) };
  }));
  api.post('/auth/otp/verify', wrap(async (req, res) => {
    const input = otpVerifySchema.parse(req.body);
    const user = await app.auth.findByIdentifier(input.target);
    if (!user) throw new HttpError(401, 'wrong code');
    const r = await app.auth.loginWithOtp({ schoolId: user.school_id, target: input.target, code: input.code, platform: 'web', ip: req.ip, userAgent: req.headers['user-agent'] });
    setSessionCookie(req, res, r.token, r.expiresAt);
    return { user: publicUser(r.user), accessToken: app.auth.accessToken(r.user, r.sessionId) };
  }));
  api.post('/auth/logout', wrap(async (req, res) => { if (req.ps.token) await app.auth.logout(req.ps.token); res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`); return { ok: true }; }));
  api.post('/auth/logout-all', wrap(async req => { const u = requireUser(req); await app.auth.logoutEverywhere(u.id); return { ok: true }; }));
  api.get('/auth/me', wrap(async req => { const u = requireUser(req); const a = await app.rbac.accessFor(u.id); return { user: publicUser(u), roles: a.roles, permissions: [...a.permissions] }; }));
  api.post('/auth/totp/begin', wrap(async req => { const u = requireUser(req); return app.auth.beginTotp(u.id, u.phone || u.email || u.display_name); }));
  api.post('/auth/totp/confirm', wrap(async req => { const u = requireUser(req); await app.auth.confirmTotp(u.id, z.object({ code: z.string() }).parse(req.body).code); return { enabled: true }; }));

  // automation console
  api.get('/automation/activity', wrap(async req => {
    const u = requirePerm(req, 'platform.view');
    const [runs, jobs, scheduled] = await Promise.all([
      app.db.query(`SELECT r.id, r.status, r.started_at, r.finished_at, r.error, r.aggregate_type, r.aggregate_id, a.code, a.name, a.module FROM automation_runs r JOIN automation_rules a ON a.id = r.rule_id WHERE r.school_id = ? ORDER BY r.started_at DESC LIMIT 50`, [u.school_id]),
      app.db.findMany('background_jobs', { school_id: u.school_id }, { orderBy: 'created_at DESC', limit: 50 }),
      app.db.findMany('scheduled_jobs', { school_id: u.school_id }, { orderBy: 'next_run_at ASC' }),
    ]);
    return { runs, jobs, scheduled, mode: app.adapters.mode };
  }));
  api.get('/automation/rules', wrap(async req => { const u = requirePerm(req, 'platform.view'); return app.db.findMany('automation_rules', { school_id: u.school_id }, { orderBy: 'module ASC, code ASC' }); }));
  api.patch('/automation/rules/:id', wrap(async req => {
    const u = requirePerm(req, 'platform.automation');
    const body = z.object({ isActive: z.boolean().optional(), previewHours: z.number().optional() }).parse(req.body);
    const set: Record<string, unknown> = {};
    if (body.isActive !== undefined) set.is_active = body.isActive;
    if (body.previewHours !== undefined) set.preview_until = new Date(Date.now() + body.previewHours * 3600_000);
    const n = await app.db.update('automation_rules', set as never, { id: req.params.id as string, school_id: u.school_id });
    await app.audit.log({ action: 'update', entityType: 'automation_rule', entityId: req.params.id as string, after: body });
    return { updated: n };
  }));
  api.post('/automation/tick', wrap(async req => { requirePerm(req, 'platform.automation'); return app.tick(); }));
  api.get('/notifications', wrap(async req => { const u = requireUser(req); return app.notifications.recentFor(u.id); }));
  api.post('/notifications/:id/read', wrap(async req => { const u = requireUser(req); return { updated: await app.notifications.markRead(req.params.id as string, u.id) }; }));
  api.get('/settings', wrap(async req => { const u = requirePerm(req, 'platform.view'); return app.settings.all(u.school_id); }));
  api.put('/settings', wrap(async req => { const u = requirePerm(req, 'platform.settings'); const { key, value } = settingWriteSchema.parse(req.body); await app.settings.set(u.school_id, key, value); return { ok: true }; }));
  api.get('/audit', wrap(async req => { const u = requirePerm(req, 'core.audit'); return app.audit.recent(u.school_id); }));
  api.post('/push/subscribe', wrap(async req => {
    const u = requireUser(req);
    const s = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).parse(req.body);
    const ex = await app.db.findOne<{ id: string }>('push_subscriptions', { user_id: u.id, endpoint: s.endpoint });
    if (!ex) await app.db.insert('push_subscriptions', { id: (await import('@pathshala/db')).ulid(), user_id: u.id, kind: 'webpush', endpoint: s.endpoint, p256dh: s.keys.p256dh, auth_key: s.keys.auth, user_agent: req.headers['user-agent']?.slice(0, 255) ?? null, failed_count: 0 });
    return { ok: true, publicKey: app.adapters.push.publicKey() };
  }));
  api.get('/push/public-key', (_req, res) => res.json({ publicKey: app.adapters.push.publicKey() }));
  mountPhase1(api, app, wrap, requirePerm, requireUser);
  mountPhase2(api, app, wrap, requirePerm, requireUser);
  mountPhase3(api, app, wrap, requirePerm, requireUser);
  mountPhase4(api, app, wrap, requirePerm, requireUser);
  mountPhase5(api, app, wrap, requirePerm, requireUser);
  mountPhase6(api, app, wrap, requirePerm, requireUser);
  mountPhase7(api, app, wrap, requirePerm, requireUser);
  mountPhase8(api, app, wrap, requirePerm, requireUser);
  mountPhase9(api, app, wrap, requirePerm);
  mountPhase10(api, app, wrap, requirePerm, requireUser);
  mountPhase11(api, app, wrap, requirePerm, requireUser);
  const pub = express.Router();
  mountPublic(pub, app, wrap, (token, ip) => verifyTurnstile(config.env, token, ip));
  mountPublicGiving(pub, app, wrap);
  mountPublicHr(pub, app, wrap, (token, ip) => verifyTurnstile(config.env, token, ip));
  mountPublicAdmissions(pub, app, wrap, (token, ip) => verifyTurnstile(config.env, token, ip));
  api.use('/public', pub);
  server.use('/api', api);

  // ---- not installed → wizard ----
  server.use(async (req, res, next) => {
    if (req.path.startsWith('/install') || req.path.startsWith('/assets') || req.path.startsWith('/api')) return next();
    if (!(await app.installer.isInstalled())) return res.redirect('/install');
    next();
  });

  // ---- web (React Router SSR build) ----
  const webBuildDir = resolveWebBuild(config.env.WEB_BUILD_DIR);
  if (webBuildDir) {
    server.use('/assets', express.static(path.join(webBuildDir, 'client', 'assets'), { immutable: true, maxAge: '1y' }));
    server.use(express.static(path.join(webBuildDir, 'client'), { maxAge: '1h' }));
    const serverBuild = path.join(webBuildDir, 'server', 'index.js');
    server.use(createRequestHandler({
      build: () => import(pathToFileUrl(serverBuild)) as never,
      getLoadContext: req => ({ app, user: req.ps.user, session: req.ps.session, locale: req.ps.locale, requestId: req.ps.requestId, setSessionCookie }),
      mode: config.isProduction ? 'production' : 'development',
    }));
    log.info(`web build: ${webBuildDir}`);
  } else {
    server.use((_req, res) => res.status(503).type('html').send('<h1>Pathshala</h1><p>Web build not found. Run <code>pnpm build</code> (apps/web) or set WEB_BUILD_DIR.</p>'));
    log.warn('web build not found — only /api, /_health and /cron/tick are served');
  }

  // ---- errors ----
  server.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'validation', code: 'bad_request', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    log.error(`unhandled ${req.method} ${req.path}`, err);
    res.status(500).json({ error: config.isProduction ? 'internal error' : String((err as Error)?.stack || err), code: 'internal', requestId: req.ps?.requestId });
  });

  return { app, server };
}

export async function main() {
  const app = createApp();
  const { server } = await createServer(app);
  await app.start();
  const port = process.env.PORT ? Number(process.env.PORT) : app.config.port;
  const listener = server.listen(port, () => app.log.info(`listening on :${port} (${app.config.appUrl})`));
  tuneKeepAlive(listener);
  const shutdown = async () => { app.log.info('shutting down'); listener.close(); await app.stop(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  return { app, server, listener };
}

/**
 * Node closes idle keep-alive sockets after 5 s, which races clients that are about to reuse one
 * (Passenger, Cloudflare and undici all pool connections) and surfaces as a random "fetch failed".
 * 65 s sits above the usual 60 s proxy idle timeout, so the proxy always closes first.
 *
 * The header matters as much as the timeout. Node advertises `Keep-Alive: timeout=65` to match, and
 * clients that honour it (undici does) then hold the socket for exactly as long as the server keeps
 * it — so whoever loses the race by a millisecond sees an ECONNRESET on the next request. The
 * middleware below advertises a much shorter idle time than the server actually tolerates, which
 * puts the client comfortably first: it reconnects while the server is still willing to wait.
 */
export const KEEP_ALIVE_ADVERTISED_SECONDS = 5;
export function tuneKeepAlive(listener: { keepAliveTimeout: number; headersTimeout: number }) {
  listener.keepAliveTimeout = 65_000;
  listener.headersTimeout = 66_000;
  return listener;
}

function resolveWebBuild(envDir?: string): string | null {
  const candidates = [envDir, path.resolve(here, '..', 'web-build'), path.resolve(here, '..', '..', 'web', 'build'), path.resolve(here, '..', 'node_modules', '@pathshala', 'web', 'build')].filter((x): x is string => !!x);
  for (const c of candidates) if (fs.existsSync(path.join(c, 'server', 'index.js'))) return c;
  return null;
}
const pathToFileUrl = (p: string) => 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');
function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
export function publicUser(u: UserRow) { return { id: u.id, schoolId: u.school_id, userType: u.user_type, displayName: u.display_name, phone: u.phone, email: u.email, locale: u.locale, twoFactorEnabled: !!Number(u.two_factor_enabled) }; }
async function verifyTurnstile(env: NodeJS.ProcessEnv, token: string | undefined, ip?: string) {
  if (!env.TURNSTILE_SECRET) return;
  if (!token) throw new HttpError(400, 'captcha required', 'turnstile');
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }) });
  const j = await r.json() as { success: boolean };
  if (!j.success) throw new HttpError(400, 'captcha failed', 'turnstile');
}
