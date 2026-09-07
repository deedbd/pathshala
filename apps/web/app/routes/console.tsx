import { Form, NavLink, Outlet, useLoaderData } from 'react-router';
import type { Route } from './+types/console';
import { t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const school = await context.app.db.findOne<{ name: string; name_bn: string | null }>('schools', { id: user.school_id });
  const access = await context.app.rbac.accessFor(user.id);
  return { locale: (user.locale as Locale) || context.locale, user: { name: user.display_name, type: user.user_type }, school, roles: access.roles, canAutomation: access.roles.includes('super_admin') || access.permissions.has('platform.view'), mode: context.app.adapters.mode, engine: context.app.db.engine };
}

export default function Console() {
  const d = useLoaderData<typeof loader>();
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
          <NavLink to="/dashboard" className={link} style={style}>{tr('nav.dashboard')}</NavLink>
          <NavLink to="/academic" className={link} style={style}>{tr('nav.academic')}</NavLink>
          <NavLink to="/students" className={link} style={style}>{tr('nav.students')}</NavLink>
          <NavLink to="/staff" className={link} style={style}>{tr('nav.staff')}</NavLink>
          <NavLink to="/attendance" className={link} style={style}>{tr('nav.attendance')}</NavLink>
          <NavLink to="/timetable" className={link} style={style}>{tr('nav.timetable')}</NavLink>
          <NavLink to="/exams" className={link} style={style}>{tr('nav.exams')}</NavLink>
          <NavLink to="/fees" className={link} style={style}>{tr('nav.fees')}</NavLink>
          <NavLink to="/accounts" className={link} style={style}>{tr('nav.accounts')}</NavLink>
          <NavLink to="/hr" className={link} style={style}>{tr('nav.hr')}</NavLink>
          <NavLink to="/admissions" className={link} style={style}>{tr('nav.admissions')}</NavLink>
          <NavLink to="/operations" className={link} style={style}>{tr('nav.operations')}</NavLink>
          <NavLink to="/learning" className={link} style={style}>{tr('nav.learning')}</NavLink>
          <NavLink to="/community" className={link} style={style}>{tr('nav.community')}</NavLink>
          <NavLink to="/institution" className={link} style={style}>{tr('nav.institution')}</NavLink>
          <NavLink to="/insights" className={link} style={style}>{tr('nav.insights')}</NavLink>
          <NavLink to="/platform" className={link} style={style}>{tr('nav.platform')}</NavLink>
          <NavLink to="/diary" className={link} style={style}>{tr('nav.diary')}</NavLink>
          <NavLink to="/chat" className={link} style={style}>{tr('nav.chat')}</NavLink>
          <NavLink to="/syllabus" className={link} style={style}>{tr('nav.syllabus')}</NavLink>
          <NavLink to="/calendar" className={link} style={style}>{tr('nav.calendar')}</NavLink>
          <NavLink to="/import" className={link} style={style}>{tr('nav.import')}</NavLink>
          <NavLink to="/website" className={link} style={style}>{tr('nav.website')}</NavLink>
          {d.canAutomation && <NavLink to="/automation" className={link} style={style}>{tr('nav.automation')}</NavLink>}
        </nav>
        <div className="hidden sm:mt-auto sm:block">
          <div className="text-xs" style={{ color: 'var(--muted)' }}>{d.user.name} · {d.roles[0] ?? d.user.type}</div>
          <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{d.engine} · {d.mode}</div>
          <Form method="post" action="/logout"><button className="btn btn-ghost btn-sm mt-2 px-0">{tr('nav.logout')}</button></Form>
        </div>
        <Form method="post" action="/logout" className="sm:hidden"><button className="btn btn-ghost btn-sm">{tr('nav.logout')}</button></Form>
      </aside>
      <main className="flex-1 p-4 sm:p-6"><Outlet /></main>
    </div>
  );
}
