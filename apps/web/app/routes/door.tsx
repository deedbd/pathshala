import { useActionData, useLoaderData, useLocation, useNavigation } from 'react-router';
import type { Route } from './+types/door';
import { OwnerDoorPage, ownerDoorAction, ownerDoorLoader } from '~/door-owner';
import { SchoolDoorPage, schoolDoorAction, schoolDoorLoader } from '~/door-school';

/**
 * `/x/<door>` — one shape, two doors, and never both at the same address.
 *
 * A school owns the address (its own domain, or `/<slug>` on the installation's host) → this is that
 * school's own sign-in, the only way into its console now that `/login` is gone. Nobody owns it —
 * the installation's own root — → this is Pathshala's own door, exactly where it has always been.
 *
 * One route module rather than two because the two would otherwise both claim `/x/:door` at the
 * root and React Router would pick between them arbitrarily. The choice is made here instead, by
 * the one thing that decides it: whether the address belongs to a school.
 *
 * Neither door is linked from anywhere, and both are noindex. A wrong door on either is a 404.
 */
export async function loader(args: Route.LoaderArgs) {
  return args.context.tenant ? schoolDoorLoader(args) : ownerDoorLoader(args);
}

export async function action(args: Route.ActionArgs) {
  return args.context.tenant ? schoolDoorAction(args) : ownerDoorAction(args);
}

export function meta({ data }: Route.MetaArgs) {
  const name = data && data.kind === 'school' ? data.school?.name : null;
  return [
    { title: name ? `${name} — Sign in` : 'Pathshala' },
    // it is linked from nowhere and it stays out of every index: an address in a search result is
    // not an address nobody can guess
    { name: 'robots', content: 'noindex, nofollow' },
  ];
}

export default function Door() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as { error?: string; totpRequired?: boolean; otpSent?: boolean; identifier?: string } | undefined;
  const busy = useNavigation().state !== 'idle';
  const doorPath = useLocation().pathname;
  return data.kind === 'school'
    ? <SchoolDoorPage data={data} result={result} busy={busy} doorPath={doorPath} />
    : <OwnerDoorPage data={data} result={result} busy={busy} />;
}
