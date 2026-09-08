import { Form, NavLink, Outlet, useLoaderData } from 'react-router';
import type { Route } from './+types/console';
import { Greeting, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';
import { useTenantPath } from '~/tenant';
import { TopBar } from '~/topbar';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const school = await context.app.db.findOne<{ name: string; name_bn: string | null; timezone: string | null }>('schools', { id: user.school_id });
  const [access, year, unread] = await Promise.all([
    context.app.rbac.accessFor(user.id),
    context.app.academic.currentYear(user.school_id).catch(() => null),
    context.app.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE recipient_user_id = ? AND channel = 'in_app' AND status <> 'read'`, [user.id]).then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
  ]);
  return {
    locale: (user.locale as Locale) || context.locale,
    user: { name: user.display_name, type: user.user_type },
    school, roles: access.roles,
    canAutomation: access.roles.includes('super_admin') || access.permissions.has('platform.view'),
    mode: context.app.adapters.mode, engine: context.app.db.engine,
    timeZone: String(school?.timezone ?? 'Asia/Dhaka'),
    year: year ? String(year.name) : null,
    unread,
  };
}

export default function Console() {
  const d = useLoaderData<typeof loader>();
  // Every link below is this school's: under /saranjai it stays under /saranjai, and under the
  // school's own domain it is the plain path. A missed one silently leaves the school's address.
  const tp = useTenantPath();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const schoolName = d.locale === 'bn' && d.school?.name_bn ? d.school.name_bn : d.school?.name;
  const link = ({ isActive }: { isActive: boolean }) => `block rounded-[var(--radius-ctl)] px-3 py-2 text-sm ${isActive ? 'font-medium' : ''}`;
  const style = ({ isActive }: { isActive: boolean }) => (isActive ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : { color: 'var(--ink)' });
  return (
    <div className="flex min-h-screen flex-col sm:flex-row" lang={d.locale}>
      <aside className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:w-[236px] sm:flex-col sm:items-stretch sm:justify-start sm:border-b-0 sm:border-r" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
        <div className="sm:mb-4">
          <div className="text-xs font-medium" style={{ color: 'var(--accent)' }}>{tr('app.name')}</div>
          <div className="display truncate text-base">{schoolName}</div>
        </div>
        <nav className="flex gap-1 overflow-x-auto sm:flex-col">
          <NavLink to={tp('/dashboard')} className={link} style={style}>{tr('nav.dashboard')}</NavLink>
          <NavLink to={tp('/academic')} className={link} style={style}>{tr('nav.academic')}</NavLink>
          <NavLink to={tp('/students')} className={link} style={style}>{tr('nav.students')}</NavLink>
          <NavLink to={tp('/staff')} className={link} style={style}>{tr('nav.staff')}</NavLink>
          <NavLink to={tp('/attendance')} className={link} style={style}>{tr('nav.attendance')}</NavLink>
          <NavLink to={tp('/timetable')} className={link} style={style}>{tr('nav.timetable')}</NavLink>
          <NavLink to={tp('/exams')} className={link} style={style}>{tr('nav.exams')}</NavLink>
          <NavLink to={tp('/fees')} className={link} style={style}>{tr('nav.fees')}</NavLink>
          <NavLink to={tp('/accounts')} className={link} style={style}>{tr('nav.accounts')}</NavLink>
          <NavLink to={tp('/hr')} className={link} style={style}>{tr('nav.hr')}</NavLink>
          <NavLink to={tp('/admissions')} className={link} style={style}>{tr('nav.admissions')}</NavLink>
          <NavLink to={tp('/operations')} className={link} style={style}>{tr('nav.operations')}</NavLink>
          <NavLink to={tp('/learning')} className={link} style={style}>{tr('nav.learning')}</NavLink>
          <NavLink to={tp('/community')} className={link} style={style}>{tr('nav.community')}</NavLink>
          <NavLink to={tp('/institution')} className={link} style={style}>{tr('nav.institution')}</NavLink>
          <NavLink to={tp('/insights')} className={link} style={style}>{tr('nav.insights')}</NavLink>
          <NavLink to={tp('/college')} className={link} style={style}>{tr('nav.college')}</NavLink>
          <NavLink to={tp('/group')} className={link} style={style}>{tr('nav.group')}</NavLink>
          <NavLink to={tp('/platform')} className={link} style={style}>{tr('nav.platform')}</NavLink>
          <NavLink to={tp('/diary')} className={link} style={style}>{tr('nav.diary')}</NavLink>
          <NavLink to={tp('/chat')} className={link} style={style}>{tr('nav.chat')}</NavLink>
          <NavLink to={tp('/syllabus')} className={link} style={style}>{tr('nav.syllabus')}</NavLink>
          <NavLink to={tp('/calendar')} className={link} style={style}>{tr('nav.calendar')}</NavLink>
          <NavLink to={tp('/import')} className={link} style={style}>{tr('nav.import')}</NavLink>
          <NavLink to={tp('/website')} className={link} style={style}>{tr('nav.website')}</NavLink>
          {d.canAutomation && <NavLink to={tp('/automation')} className={link} style={style}>{tr('nav.automation')}</NavLink>}
        </nav>
        <div className="hidden sm:mt-auto sm:block">
          <div className="text-xs" style={{ color: 'var(--muted)' }}>{d.user.name} · {d.roles[0] ?? d.user.type}</div>
          <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{d.engine} · {d.mode}</div>
          <Form method="post" action={tp('/logout')}><button className="btn btn-ghost btn-sm mt-2 px-0">{tr('nav.logout')}</button></Form>
        </div>
        <Form method="post" action={tp('/logout')} className="sm:hidden"><button className="btn btn-ghost btn-sm">{tr('nav.logout')}</button></Form>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar locale={d.locale} timeZone={d.timeZone} year={d.year} notifications={d.unread} />
        <main className="flex-1 p-4 sm:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
