import { type RouteConfig, index, layout, route } from '@react-router/dev/routes';

export default [
  index('routes/index.tsx'),
  route('install', 'routes/install.tsx'),
  route('login', 'routes/login.tsx'),
  route('logout', 'routes/logout.tsx'),
  layout('routes/console.tsx', [
    route('dashboard', 'routes/dashboard.tsx'),
    route('automation', 'routes/automation.tsx'),
  ]),
] satisfies RouteConfig;
