import { redirect } from 'react-router';
import type { Route } from './+types/logout';
import { clearSessionCookie } from '~/lib';
import { ctxPath } from '~/tenant';

async function signOut({ context, request }: Route.LoaderArgs | Route.ActionArgs) {
  const cookie = request.headers.get('cookie') ?? '';
  const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('ps_session='))?.slice('ps_session='.length);
  if (token) await context.app.auth.logout(decodeURIComponent(token));
  return redirect(ctxPath(context, '/login'), { headers: { 'Set-Cookie': clearSessionCookie } });
}
export const loader = signOut;
export const action = signOut;
export default function Logout() { return null; }
