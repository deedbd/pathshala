import { redirect, type AppLoadContext } from 'react-router';

export const SESSION_COOKIE = 'ps_session';

export function sessionCookie(token: string, expiresAt: string, secure: boolean) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt.replace(' ', 'T') + 'Z').toUTCString()}${secure ? '; Secure' : ''}`;
}
export const clearSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`;

export function requireUser(context: AppLoadContext, request: Request) {
  if (!context.user) throw redirect(`/login?next=${encodeURIComponent(new URL(request.url).pathname)}`);
  return context.user;
}

/** Same-origin check for form posts (cookie sessions): Origin/Referer must match the app host when present. */
export function assertSameOrigin(request: Request, appUrl: string) {
  const origin = request.headers.get('origin') ?? request.headers.get('referer');
  if (!origin) return;
  const a = new URL(origin).host; const b = new URL(appUrl).host; const c = new URL(request.url).host;
  if (a !== b && a !== c) throw new Response('cross-origin form post rejected', { status: 403 });
}

export function formString(fd: FormData, key: string) { const v = fd.get(key); return typeof v === 'string' ? v : ''; }
