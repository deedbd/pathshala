import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useRouteError } from 'react-router';
import type { Route } from './+types/root';
import './app.css';

export async function loader({ context }: Route.LoaderArgs) {
  // Every in-app link is built from tenantPrefix: '' under a custom domain (or on the vendor's own
  // host) and '/<slug>' when the path named the school. useTenantPath() reads it back from here.
  const tenant = context.tenant ?? null;
  return { locale: context.locale, appName: 'Pathshala', tenantPrefix: tenant?.prefix ?? '', tenant };
}

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useLoaderData<typeof loader>() as { locale?: 'bn' | 'en' } | undefined;
  const locale = data?.locale ?? 'bn';
  return (
    <html lang={locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#2B5FA8" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%232B5FA8'/%3E%3Cpath d='M8 9h16M8 15h16M8 21h11' stroke='%23fff' stroke-width='2.5' stroke-linecap='round'/%3E%3Cpath d='M11 5v22' stroke='%23B9352F' stroke-width='2'/%3E%3C/svg%3E" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href={`https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&${locale === 'bn' ? 'family=Noto+Sans+Bengali:wght@400;500;600;700&' : ''}display=swap`} rel="stylesheet" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() { return <Outlet />; }

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : 'Unexpected error';
  const detail = error instanceof Error && import.meta.env.DEV ? error.stack : null;
  return (
    <main className="mx-auto max-w-lg p-6">
      <div className="banner banner-bad">
        <h1 className="text-lg">Something went wrong</h1>
        <p className="mt-1">{message}</p>
        {detail && <pre className="mt-3 overflow-x-auto text-xs">{detail}</pre>}
        <a className="btn btn-secondary btn-sm mt-3" href="/">Home</a>
      </div>
    </main>
  );
}
