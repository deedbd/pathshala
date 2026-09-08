import type { AppLoadContext } from 'react-router';
import { requireTenantUser } from './tenant';

export const SESSION_COOKIE = 'ps_session';

export function sessionCookie(token: string, expiresAt: string, secure: boolean) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt.replace(' ', 'T') + 'Z').toUTCString()}${secure ? '; Secure' : ''}`;
}
export const clearSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`;

/**
  * The signed-in user of the school whose address this page is being served at.
  *
  * Two things get nothing from a console page, and both get the same answer — a 404:
  *  - **no session at all.** There is nowhere to send the browser any more. The sign-in form lives
  *    behind an address the school was emailed, and redirecting to it here would hand that address
  *    to the first stranger who typed `/‹slug›/fees` — which is exactly the thing the door exists to
  *    prevent. So the page is simply not there, as `/owner` already is for everyone but the vendor.
  *  - **a session belonging to another school.** Handled in `requireTenantUser`, the same way: one
  *    school's console is never drawn under another school's address.
  */
export function requireUser(context: AppLoadContext, request: Request) {
  if (!context.user) throw new Response('Not found', { status: 404 });
  return requireTenantUser(context, context.user, request);
}

/** Same-origin check for form posts (cookie sessions): Origin/Referer must match the app host when present. */
export function assertSameOrigin(request: Request, appUrl: string) {
  const origin = request.headers.get('origin') ?? request.headers.get('referer');
  if (!origin) return;
  const a = new URL(origin).host; const b = new URL(appUrl).host; const c = new URL(request.url).host;
  if (a !== b && a !== c) throw new Response('cross-origin form post rejected', { status: 403 });
}

export function formString(fd: FormData, key: string) { const v = fd.get(key); return typeof v === 'string' ? v : ''; }

/**
 * The vendor's device key, as the browser carries it.
 *
 * These are string helpers, not logic: the token is signed and checked by `OwnerAccessService` on the
 * server. They live here because the web app must not import `@pathshala/core` at runtime — the
 * release ships the two separately and `context.app` is handed in, not required — and the cookie name
 * is the one thing the two halves have to agree on (`OWNER_DEVICE_COOKIE` in core).
 */
export const OWNER_DEVICE_COOKIE = 'ps_owner_device';

export function ownerDeviceCookie(token: string, secure: boolean) {
  return `${OWNER_DEVICE_COOKIE}=${token}; Path=/; Max-Age=${2 * 365 * 24 * 3600}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function readOwnerDeviceCookie(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === OWNER_DEVICE_COOKIE) return rest.join('=') || null;
  }
  return null;
}

/** What to call this machine in the owner's list of trusted ones. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = String(userAgent ?? '');
  const os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'a machine';
  const browser = /Edg\//i.test(ua) ? 'Edge' : /Chrome\//i.test(ua) ? 'Chrome' : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : 'a browser';
  return `${browser} on ${os}`;
}
