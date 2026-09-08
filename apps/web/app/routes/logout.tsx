import { redirect } from 'react-router';
import type { Route } from './+types/logout';
import { clearSessionCookie } from '~/lib';
import { ctxPath } from '~/tenant';

/**
 * Signing out lands where the person can sign in again.
 *
 * A guardian goes back to the portal's own sign-in, which is a page they can find. A member of staff
 * goes to the school's public website: their sign-in is behind the school's door, and sending the
 * browser there would put that address in the history of any machine anybody ever borrowed.
 */
async function signOut({ context, request }: Route.LoaderArgs | Route.ActionArgs) {
  const cookie = request.headers.get('cookie') ?? '';
  const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('ps_session='))?.slice('ps_session='.length);
  const portal = ['guardian', 'student', 'alumni'].includes(String(context.user?.user_type ?? ''));
  if (token) await context.app.auth.logout(decodeURIComponent(token));
  return redirect(ctxPath(context, portal ? '/portal/login' : '/site'), { headers: { 'Set-Cookie': clearSessionCookie } });
}
export const loader = signOut;
export const action = signOut;
export default function Logout() { return null; }
