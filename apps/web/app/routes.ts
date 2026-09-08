import { type RouteConfig, type RouteConfigEntry, index, layout, prefix, route } from '@react-router/dev/routes';

/**
 * Everything a school's own people use: the console, sign-in, the public site and the guardian portal.
 *
 * It is mounted twice from this one definition, because a school is reachable at two shapes of
 * address and both must serve the same app:
 *   - at the root, for a school that brought its own domain (`https://saranjaischool.edu.bd/`)
 *   - under `/:school`, for a school on the installation's own host (`…/saranjai`)
 * React Router needs a unique id per route, so each copy is given its own prefix; `id('dashboard')`
 * is `dashboard` in the root copy and `tenant-dashboard` in the other. The path is a route param and
 * never a build-time basename, so assets stay at `/assets` and nothing about the build changes.
 */
function schoolApp(id: (name: string) => string): RouteConfigEntry[] {
  return [
    index('routes/index.tsx', { id: id('index') }),
    // The school's own sign-in, behind an address generated when the school was created and emailed
    // to it. There is no `/login` here any more: a generic sign-in page is the one address every
    // scanner already tries, and the owner wants a client's console to be unfindable. The vendor's
    // own door has exactly the same shape at the installation's root, and `routes/door.tsx` tells
    // them apart by whether a school owns the address.
    route('x/:door', 'routes/door.tsx', { id: id('door') }),
    route('logout', 'routes/logout.tsx', { id: id('logout') }),
    layout('routes/console.tsx', { id: id('console') }, [
      route('dashboard', 'routes/dashboard.tsx', { id: id('dashboard') }),
      route('automation', 'routes/automation.tsx', { id: id('automation') }),
      route('academic', 'routes/academic.tsx', { id: id('academic') }),
      route('students', 'routes/students.tsx', { id: id('students') }),
      route('staff', 'routes/staff.tsx', { id: id('staff') }),
      route('import', 'routes/import.tsx', { id: id('import') }),
      route('timetable', 'routes/timetable.tsx', { id: id('timetable') }),
      route('syllabus', 'routes/syllabus.tsx', { id: id('syllabus') }),
      route('calendar', 'routes/calendar.tsx', { id: id('calendar') }),
      route('website', 'routes/website.tsx', { id: id('website') }),
      route('attendance', 'routes/attendance.tsx', { id: id('attendance') }),
      route('diary', 'routes/diary.tsx', { id: id('diary') }),
      route('chat', 'routes/chat.tsx', { id: id('chat') }),
      route('communication', 'routes/communication.tsx', { id: id('communication') }),
      route('exams', 'routes/exams.tsx', { id: id('exams') }),
      route('fees', 'routes/fees.tsx', { id: id('fees') }),
      route('accounts', 'routes/accounts.tsx', { id: id('accounts') }),
      route('hr', 'routes/hr.tsx', { id: id('hr') }),
      route('admissions', 'routes/admissions.tsx', { id: id('admissions') }),
      route('operations', 'routes/operations.tsx', { id: id('operations') }),
      route('learning', 'routes/learning.tsx', { id: id('learning') }),
      route('community', 'routes/community.tsx', { id: id('community') }),
      route('institution', 'routes/institution.tsx', { id: id('institution') }),
      route('insights', 'routes/insights.tsx', { id: id('insights') }),
      route('college', 'routes/college.tsx', { id: id('college') }),
      route('group', 'routes/group.tsx', { id: id('group') }),
      route('platform', 'routes/platform.tsx', { id: id('platform') }),
      route('settings', 'routes/settings.tsx', { id: id('settings') }),
    ]),
    route('teach', 'routes/teach.tsx', { id: id('teach') }),
    ...prefix('site', [
      index('routes/site.tsx', { id: id('site-home') }),
      route(':slug', 'routes/site.tsx', { id: id('site-page') }),
    ]),
    ...prefix('portal', [
      index('routes/portal.tsx', { id: id('portal') }),
      // Families keep a sign-in page they can find. A link printed on a card and sent home to five
      // hundred households is not a secret, and a guardian who cannot sign in is a school that stops
      // using the software — so only the console, where the whole register lives, moved behind a
      // door. This page refuses staff and admin accounts, which is what keeps that door meaningful.
      route('login', 'routes/portal-login.tsx', { id: id('portal-login') }),
      route('child/:id', 'routes/portal-child.tsx', { id: id('portal-child') }),
    ]),
  ];
}

export default [
  // the root copy: a school that resolved from the host, and the installation's founder school on
  // the vendor's own host. Static segments outrank `:school`, so `/install`, `/owner` and the door
  // below are never read as a slug.
  ...schoolApp(name => name),
  // the same app under the school's slug on the installation's shared host
  ...prefix(':school', schoolApp(name => `tenant-${name}`)),

  route('install', 'routes/install.tsx'),
  // Pathshala's own console: its own layout, outside the school console, gated by the owner service.
  // It is deliberately absent from schoolApp — the vendor's console never appears under a school's address.
  route('owner', 'routes/owner.tsx', [
    index('routes/owner.overview.tsx'),
    route('schools', 'routes/owner.schools.tsx'),
    route('billing', 'routes/owner.billing.tsx'),
    route('health', 'routes/owner.health.tsx'),
    route('support', 'routes/owner.support.tsx'),
  ]),
] satisfies RouteConfig;
