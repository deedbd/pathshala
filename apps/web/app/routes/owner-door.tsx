import { Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { Route } from './+types/owner-door';
import { assertSameOrigin, deviceLabel, formString, ownerDeviceCookie, readOwnerDeviceCookie, sessionCookie } from '~/lib';

/**
 * The door: the only way in to Pathshala's own console.
 *
 * A school's `/login` never signs the vendor in, and `/owner` is a 404 to everyone who has not come
 * through here, so a client's site carries no trace of this page at all. The path itself lives in
 * `.env` (`OWNER_DOOR`), written once at install; with none set there is no door and the console is
 * closed rather than open.
 *
 * The path is not the security. Three things in front of it decide whether the form is even drawn —
 * a machine the owner has already trusted, an address on the allowlist, or a MAC on the server's own
 * network — and **any one of them is enough**, so a laptop that travels keeps working while its
 * address changes. Behind it the lock is unchanged: the `super_admin` role on the founder school, the
 * password, and the second factor where the account has one. Everything that is refused here is
 * refused as a 404, because a 403 would confirm there is something to attack.
 */
const ATTEMPTS = 5;
const WINDOW_MS = 15 * 60_000;
const tries = new Map<string, number[]>();

function notFound(): never {
  throw new Response('Not found', { status: 404 });
}

function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0]!.trim() : null) || request.headers.get('x-real-ip') || null;
}

function throttled(key: string): boolean {
  const now = Date.now();
  const recent = (tries.get(key) ?? []).filter(t => now - t < WINDOW_MS);
  tries.set(key, recent);
  if (tries.size > 2000) for (const [k, v] of tries) if (!v.some(t => now - t < WINDOW_MS)) tries.delete(k);
  return recent.length >= ATTEMPTS;
}
function noteAttempt(key: string) {
  const recent = tries.get(key) ?? [];
  recent.push(Date.now());
  tries.set(key, recent);
}

/** The door is drawn only for the right path, from a machine allowed to see it, at a sane rate. */
async function guard(context: Route.LoaderArgs['context'], request: Request, door: string | undefined) {
  const expected = context.app.config.ownerDoor;
  if (!expected || !door || door.toLowerCase() !== expected) notFound();
  const ip = clientIp(request);
  if (throttled(`door:${ip ?? 'unknown'}`)) notFound();
  const access = await context.app.ownerAccess.check({ ip, deviceToken: readOwnerDeviceCookie(request.headers.get('cookie')) });
  if (!access.allowed) { noteAttempt(`door:${ip ?? 'unknown'}`); notFound(); }
  return { ip, access };
}

export async function loader({ context, request, params }: Route.LoaderArgs) {
  await guard(context, request, params.door);
  if (context.user) {
    // already signed in: the owner goes to their console, anybody else is told nothing at all
    try { await context.app.owner.requireOwner(context.user); throw redirect('/owner'); }
    catch (e) { if (e instanceof Response) throw e; notFound(); }
  }
  return { appUrl: context.app.config.appUrl };
}

export function meta() { return [{ title: 'Pathshala' }, { name: 'robots', content: 'noindex, nofollow' }]; }

export async function action({ context, request, params }: Route.ActionArgs) {
  const { ip, access } = await guard(context, request, params.door);
  assertSameOrigin(request, context.app.config.appUrl);
  const fd = await request.formData();
  const identifier = formString(fd, 'identifier');
  const key = `door:${ip ?? 'unknown'}`;
  const secure = context.app.config.appUrl.startsWith('https');
  try {
    const r = await context.app.auth.login({
      identifier, password: formString(fd, 'password'), totp: formString(fd, 'totp') || undefined,
      remember: false, platform: 'web', ip, userAgent: request.headers.get('user-agent'),
    });
    if ('totpRequired' in r) return { totpRequired: true, identifier };
    const user = r.user as { id: string; school_id: string; user_type: string };
    // the account signed in, but it is not the vendor's: the session is dropped and the page is gone
    // the first person through the door becomes the vendor; everybody after it must already be
    try { await context.app.owner.claimOwnership(user); } catch { await context.app.auth.logout(r.token).catch(() => undefined); noteAttempt(key); notFound(); }

    const headers = new Headers();
    headers.append('Set-Cookie', sessionCookie(r.token, r.expiresAt, secure));
    // this machine got through the gate, gave the password and the second factor: it is trusted from
    // now on, which is what lets the owner sign in again from a different address tomorrow
    if (access.matched !== 'device') {
      const device = await context.app.ownerAccess.trustDevice({ label: deviceLabel(request.headers.get('user-agent')), ip });
      headers.append('Set-Cookie', ownerDeviceCookie(device.token, secure));
    }
    headers.set('Location', '/owner');
    return new Response(null, { status: 302, headers });
  } catch (e) {
    if (e instanceof Response) throw e;
    noteAttempt(key);
    const err = e as { status?: number; message: string };
    return { error: err.status === 401 ? 'Those details do not match.' : err.message, identifier };
  }
}

export default function OwnerDoor() {
  const d = useLoaderData<typeof loader>();
  const a = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== 'idle';
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="card w-full max-w-[380px] p-6">
        <div className="display text-lg">Pathshala</div>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>The team's own console.</p>
        {a && 'error' in a && a.error ? <div className="banner banner-bad mt-4">{a.error}</div> : null}
        <Form method="post" className="mt-4 grid gap-3">
          <label className="block">
            <span className="label">Email or mobile</span>
            <input className="input" name="identifier" autoComplete="username" defaultValue={a && 'identifier' in a ? a.identifier : ''} required autoFocus />
          </label>
          <label className="block">
            <span className="label">Password</span>
            <input className="input" name="password" type="password" autoComplete="current-password" required />
          </label>
          {a && 'totpRequired' in a && a.totpRequired ? (
            <label className="block">
              <span className="label">Code from your authenticator</span>
              <input className="input num" name="totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus />
            </label>
          ) : null}
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </Form>
        <p className="mt-4 text-xs" style={{ color: 'var(--muted)' }}>{new URL(d.appUrl).host}</p>
      </div>
    </div>
  );
}
