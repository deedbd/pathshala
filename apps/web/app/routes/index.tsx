import { redirect } from 'react-router';
import type { Route } from './+types/index';
import { ctxPath } from '~/tenant';

export async function loader({ context }: Route.LoaderArgs) {
  if (!(await context.app.installer.isInstalled())) throw redirect('/install');
  // /install lives on the installation, not on a school, so it stays absolute; the rest is this school's.
  throw redirect(ctxPath(context, context.user ? '/dashboard' : '/login'));
}

export default function Index() { return null; }
