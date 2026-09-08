import type { App, UserRow, SessionRow, RequestTenant } from '@pathshala/core';

declare module 'react-router' {
  interface AppLoadContext {
    app: App;
    user: UserRow | null;
    session: SessionRow | null;
    /**
     * The school this address belongs to, resolved before anybody signed in — a custom domain, or
     * the first path segment against `schools.slug`. `null` is the installation's own root, which is
     * the vendor's space and the only place the owner console exists. `tenant.prefix` is `''` on a
     * school's own domain and `/<slug>` under the installation's host: every link a page builds
     * carries it, or it leaves the school.
     */
    tenant: RequestTenant | null;
    locale: 'bn' | 'en';
    requestId: string;
    setSessionCookie: (req: unknown, res: unknown, token: string, expiresAt: string) => void;
  }
}
