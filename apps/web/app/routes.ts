import { type RouteConfig, index, layout, prefix, route } from '@react-router/dev/routes';

export default [
  index('routes/index.tsx'),
  route('install', 'routes/install.tsx'),
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),
  layout('routes/console.tsx', [
    route('dashboard', 'routes/dashboard.tsx'),
    route('automation', 'routes/automation.tsx'),
    route('academic', 'routes/academic.tsx'),
    route('students', 'routes/students.tsx'),
    route('staff', 'routes/staff.tsx'),
    route('import', 'routes/import.tsx'),
    route('timetable', 'routes/timetable.tsx'),
    route('syllabus', 'routes/syllabus.tsx'),
    route('calendar', 'routes/calendar.tsx'),
    route('website', 'routes/website.tsx'),
    route('attendance', 'routes/attendance.tsx'),
    route('diary', 'routes/diary.tsx'),
    route('chat', 'routes/chat.tsx'),
    route('exams', 'routes/exams.tsx'),
    route('fees', 'routes/fees.tsx'),
    route('accounts', 'routes/accounts.tsx'),
    route('hr', 'routes/hr.tsx'),
    route('admissions', 'routes/admissions.tsx'),
    route('operations', 'routes/operations.tsx'),
    route('learning', 'routes/learning.tsx'),
    route('community', 'routes/community.tsx'),
    route('institution', 'routes/institution.tsx'),
    route('insights', 'routes/insights.tsx'),
    route('college', 'routes/college.tsx'),
    route('group', 'routes/group.tsx'),
    route('platform', 'routes/platform.tsx'),
  ]),
  // the door: Pathshala's own sign-in, behind a path from .env that nothing links to. A wrong
  // path is a 404 like any other, so a school's site says nothing about a vendor console
  route('x/:door', 'routes/owner-door.tsx'),
  // Pathshala's own console: its own layout, outside the school console, gated by the owner service
  route('owner', 'routes/owner.tsx', [
    index('routes/owner.overview.tsx'),
    route('schools', 'routes/owner.schools.tsx'),
    route('billing', 'routes/owner.billing.tsx'),
    route('health', 'routes/owner.health.tsx'),
    route('support', 'routes/owner.support.tsx'),
  ]),
  route('teach', 'routes/teach.tsx'),
  ...prefix('site', [
    index('routes/site.tsx', { id: 'site-home' }),
    route(':slug', 'routes/site.tsx', { id: 'site-page' }),
  ]),
  ...prefix('portal', [
    index('routes/portal.tsx'),
    route('child/:id', 'routes/portal-child.tsx'),
  ]),
] satisfies RouteConfig;
