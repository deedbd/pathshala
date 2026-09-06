import type { App, UserRow, SessionRow } from '@pathshala/core';

declare module 'react-router' {
  interface AppLoadContext {
    app: App;
    user: UserRow | null;
    session: SessionRow | null;
    locale: 'bn' | 'en';
    requestId: string;
    setSessionCookie: (req: unknown, res: unknown, token: string, expiresAt: string) => void;
  }
}
