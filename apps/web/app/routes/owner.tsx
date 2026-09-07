import { Form, Link, NavLink, Outlet, useLoaderData } from 'react-router';
import type { Route } from './+types/owner';
import { formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';
import { ownerApi, ownerLoad, requireOwnerOr404 } from '~/owner-api';

/**
 * Pathshala's own console — the company's, not a school's.
 *
 * It is a layout of its own, outside `console.tsx`, so nothing here can be reached from a school's
 * sidebar. The gate is the owner service's, and a refusal is a **404**: a 403 would confirm to a
 * school's administrator that a vendor console exists at this address and is worth attacking. The
 * way in is the door (`/x/<OWNER_DOOR>`), which is the only page that signs the vendor in.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  await requireOwnerOr404(context);
  if (!context.user) throw new Response('Not found', { status: 404 });
  const user = requireUser(context, request);
  try { await context.app.owner.requireOwner(context.user); }
  catch { throw new Response('Not found', { status: 404 }); }
  const overview = await ownerLoad(() => ownerApi(context).overview());
  return {
    locale: (user.locale as Locale) || context.locale,
    user: { name: user.display_name },
    denied: overview === null,
    schools: overview?.schools.total ?? 0,
    engine: context.app.db.engine,
    mode: context.app.adapters.mode,
  };
}
export function meta() { return [{ title: 'Pathshala — Owner console' }]; }

export default function Owner() {
  const d = useLoaderData<typeof loader>();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);

  if (d.denied) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center p-4 sm:p-8" lang={d.locale}>
        <div className="card w-full p-8 text-center">
          <div className="text-xs font-medium" style={{ color: 'var(--accent)' }}>{tr('app.name')}</div>
          <div className="display mt-1 text-lg">{tr('own.refused')}</div>
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>{tr('own.refusedNote')}</p>
          <div className="mt-4"><Link className="btn btn-secondary" to="/dashboard">{tr('own.backToSchool')}</Link></div>
        </div>
      </main>
    );
  }

  const link = ({ isActive }: { isActive: boolean }) => `block rounded-[var(--radius-ctl)] px-3 py-2 text-sm ${isActive ? 'font-medium' : ''}`;
  const style = ({ isActive }: { isActive: boolean }) => (isActive ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : { color: 'var(--ink)' });
  return (
    <div className="flex min-h-screen flex-col sm:flex-row" lang={d.locale}>
      <aside className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:w-[236px] sm:flex-col sm:items-stretch sm:justify-start sm:border-b-0 sm:border-r" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <div className="sm:mb-4">
          <div className="text-xs font-medium" style={{ color: 'var(--accent)' }}>{tr('app.name')}</div>
          <div className="display truncate text-base">{tr('own.title')}</div>
        </div>
        <nav className="flex gap-1 overflow-x-auto sm:flex-col">
          <NavLink to="/owner" end className={link} style={style}>{tr('own.overview')}</NavLink>
          <NavLink to="/owner/schools" className={link} style={style}>{tr('own.schools')}</NavLink>
          <NavLink to="/owner/billing" className={link} style={style}>{tr('own.billing')}</NavLink>
          <NavLink to="/owner/health" className={link} style={style}>{tr('own.health')}</NavLink>
          <NavLink to="/owner/support" className={link} style={style}>{tr('own.support')}</NavLink>
        </nav>
        <div className="hidden sm:mt-auto sm:block">
          <div className="text-xs" style={{ color: 'var(--muted)' }}>{d.user.name}</div>
          <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{d.engine} · {d.mode}</div>
          <Link className="btn btn-ghost btn-sm mt-2 px-0" to="/dashboard">{tr('own.backToSchool')}</Link>
          <Form method="post" action="/logout"><button className="btn btn-ghost btn-sm px-0">{tr('nav.logout')}</button></Form>
        </div>
        <Form method="post" action="/logout" className="sm:hidden"><button className="btn btn-ghost btn-sm">{tr('nav.logout')}</button></Form>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-6" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
          <div>
            <div className="display text-base">{tr('own.title')}</div>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('own.notASchool')}</p>
          </div>
          <span className="chip">{formatNumber(d.schools, d.locale)} {tr('own.schoolsWord')}</span>
        </header>
        <main className="flex-1 p-4 sm:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
