import { redirect } from 'react-router';
import type { Route } from './+types/index';

export async function loader({ context }: Route.LoaderArgs) {
  if (!(await context.app.installer.isInstalled())) throw redirect('/install');
  throw redirect(context.user ? '/dashboard' : '/login');
}

export default function Index() { return null; }
