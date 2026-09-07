import type { Request, Response, Router } from 'express';
import { type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

/** Phase 9 API: the school's own data (backup, restore), the onboarding checklist, and platform health. */
export function mountPhase9(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User) {
  api.get('/platform/onboarding', wrap(async req => { const u = requirePerm(req, 'platform.view'); return app.platform.onboarding(u.school_id); }));
  api.get('/platform/health', wrap(async req => { const u = requirePerm(req, 'platform.view'); return app.platform.health(u.school_id); }));
  api.get('/platform/backups', wrap(async req => { const u = requirePerm(req, 'platform.hosting'); return app.platform.backups(u.school_id); }));
  api.post('/platform/backups', wrap(async req => {
    const u = requirePerm(req, 'platform.hosting');
    const b = z.object({ kind: z.enum(['database', 'files', 'full']).optional(), target: z.enum(['local', 'dropbox', 'gdrive', 's3']).optional() }).parse(req.body ?? {});
    const r = await app.platform.backup(u.school_id, b);
    await app.audit.log({ action: 'backup', entityType: 'platform.backup', entityId: r.id, after: { sizeBytes: r.sizeBytes, target: r.target } });
    return r;
  }));
  /** Restoring is the one action that can undo a school's day, so it is audited and never silent. */
  api.post('/platform/restore', wrap(async req => {
    const u = requirePerm(req, 'platform.hosting');
    const b = z.object({ file: z.string().min(3).max(500), truncate: z.coerce.boolean().optional() }).parse(req.body);
    const r = await app.platform.restore(b.file, { truncate: b.truncate });
    await app.audit.log({ action: 'restore', entityType: 'platform.backup', after: { ...r, file: b.file } });
    await app.notifications.notifyRole(u.school_id, 'admin', { channels: ['in_app', 'email'], eventKey: 'platform.restored', title: 'A backup was restored', body: `${r.rows} rows across ${r.tables} tables were restored from ${b.file}.`, entityType: 'platform.backup' });
    return r;
  }));
}
