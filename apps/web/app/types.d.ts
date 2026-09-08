import type { App, UserRow, SessionRow } from '@pathshala/core';
import type { Tenant } from './tenant';

declare module 'react-router' {
  interface AppLoadContext {
    app: App;
    user: UserRow | null;
    session: SessionRow | null;
    locale: 'bn' | 'en';
    /** Which school the host and path named, or null on the vendor's own host-and-root. */
    tenant: Tenant | null;
    requestId: string;
    setSessionCookie: (req: unknown, res: unknown, token: string, expiresAt: string) => void;
  }
}
