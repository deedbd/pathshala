import { redirect, useLoaderData } from 'react-router';
import type { Route } from './+types/portal';
import { formatDate, t, type Locale } from '@pathshala/ui';
import { ctxPath, requireTenantUser, useTenantPath } from '~/tenant';

export async function loader({ context, request }: Route.LoaderArgs) {
  // The portal renders the school in the URL: a guardian holding another school's session is sent to
  // this school's sign-in, never shown the other school's children.
  if (!context.user) throw redirect(`${ctxPath(context, '/login')}?next=${encodeURIComponent(new URL(request.url).pathname)}`);
  const u = requireTenantUser(context, context.user, request);
  const [school, children, notices] = await Promise.all([context.app.db.findOne<{ name: string; name_bn: string | null }>('schools', { id: u.school_id }), context.app.portal.children(u.school_id, u.id), context.app.cms.publicNotices(u.school_id, 10)]);
  return { locale: (u.locale as Locale) || context.locale, user: { name: u.display_name, type: u.user_type }, school, children, notices, isGuardian: u.user_type === 'guardian' };
}
export function meta() { return [{ title: 'Pathshala — Portal' }]; }

export default function Portal() {
  const d = useLoaderData<typeof loader>(); const L = d.locale; const tr = (k: Parameters<typeof t>[0]) => t(k, L); const tp = useTenantPath();
  const name = L === 'bn' && d.school?.name_bn ? d.school.name_bn : d.school?.name;
  return (
    <div lang={L} className="mx-auto max-w-md pb-20">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b px-4 py-3" style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}><div><div className="text-xs" style={{ color: 'var(--accent)' }}>{tr('app.name')}</div><div className="display text-base">{name}</div></div><a href={tp('/logout')} className="btn btn-ghost btn-sm">{tr('nav.logout')}</a></header>
      <main className="px-4">
        <p className="mt-4 text-sm" style={{ color: 'var(--muted)' }}>{tr('dash.welcome')}, {d.user.name}</p>
        <h2 className="mt-4 text-base">{tr('portal.children')}</h2>
        {d.children.length === 0 && <div className="card mt-2 p-4 text-sm" style={{ color: 'var(--muted)' }}>{d.isGuardian ? '—' : 'This account is not a guardian.'}</div>}
        <ul className="mt-2 grid gap-2">{d.children.map(c => <li key={String(c.id)}><a href={tp(`/portal/child/${c.id}`)} className="card flex items-center gap-3 p-4"><span className="feed-icon feed-system">{String(c.first_name).slice(0, 1)}</span><span className="flex-1"><span className="block font-medium">{L === 'bn' && c.name_bn ? String(c.name_bn) : `${c.first_name} ${c.last_name ?? ''}`}</span><span className="block text-xs" style={{ color: 'var(--muted)' }}>{L === 'bn' && c.class_name_bn ? String(c.class_name_bn) : String(c.class_name ?? '')} {String(c.section_name ?? '')} · {tr('stu.roll')} <span className="num">{String(c.current_roll_no ?? '—')}</span></span></span><span style={{ color: 'var(--muted)' }}>›</span></a></li>)}</ul>
        <h2 className="mt-6 text-base">{tr('portal.notices')}</h2>
        <ul className="card mt-2 divide-y" style={{ borderColor: 'var(--line)' }}>{d.notices.map(n => <li key={String(n.id)} className="p-3"><div className="font-medium">{String(n.title)}</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{formatDate(String(n.publish_at), L)}</div><p className="mt-1 whitespace-pre-wrap text-sm">{String(n.body).slice(0, 400)}</p></li>)}{d.notices.length === 0 && <li className="p-3 text-sm" style={{ color: 'var(--muted)' }}>—</li>}</ul>
      </main>
      <nav className="fixed inset-x-0 bottom-0 mx-auto flex max-w-md justify-around border-t py-2 text-xs" style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}><a href={tp('/portal')} style={{ color: 'var(--accent)' }}>{tr('portal.children')}</a><a href={tp('/portal#notices')}>{tr('portal.notices')}</a><a href={tp('/site')}>{tr('web.title')}</a></nav>
      <script dangerouslySetInnerHTML={{ __html: `if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{});}` }} />
    </div>
  );
}
