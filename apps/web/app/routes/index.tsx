import { redirect } from 'react-router';
import type { Route } from './+types/index';
import { ctxPath } from '~/tenant';

export async function loader({ context, params }: Route.LoaderArgs) {
  if (!(await context.app.installer.isInstalled())) throw redirect('/install');
  /**
   * `/<something>` where nothing owns that name is a 404, not a redirect.
   *
   * This route is mounted twice — at the root and at `/:school` — so it catches every one-segment
   * address there is, on the installation's host and on a school's own domain alike. Answering a
   * redirect there would tell a stranger typing `/login` or `/admin` that the installation is alive
   * and where its pages are; and it would be a lie anyway, since no school of that name exists.
   *
   * The one thing that makes a `:school` segment legitimate is the server having resolved the
   * tenant *from that very segment* — which is exactly what `tenant.prefix` says. On a school's own
   * domain the prefix is `''`, so `/login` there is a stray segment and not a school either.
   */
  if (params.school && context.tenant?.prefix !== `/${params.school}`) throw new Response('Not found', { status: 404 });
  // /install lives on the installation, not on a school, so it stays absolute; the rest is this
  // school's. Signed out, the front page is the school's own public website — there is no sign-in
  // page to send anybody to, because the console's is behind an address only the school knows and
  // the portal's is one click on from the site.
  throw redirect(ctxPath(context, context.user ? '/dashboard' : '/site'));
}

export default function Index() { return null; }
