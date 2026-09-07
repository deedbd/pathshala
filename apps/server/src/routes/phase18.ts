import type { Request, Response, Router } from 'express';
import { HttpError, type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

/**
 * Year 5 API: the voice line a guardian rings.
 *
 * The webhook is not behind the console session — nobody is signed in, an IVR gateway is calling on
 * behalf of somebody holding a phone. Like `/api/fees/ipn/:gatewayId` it authenticates itself: the
 * school is named in the path, the shared secret comes in a header (or the body, for a gateway that
 * cannot set headers) and is compared in constant time, and everything else — who the caller is,
 * what they may hear — is decided from the caller ID against `guardians.phone`.
 */
export function mountPhase18(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User) {
  // literal paths before the parameterised one, or `calls` is read as a school code
  api.get('/ivr/calls', wrap(async req => { const u = requirePerm(req, 'frontoffice.view'); return app.ivr.calls(u.school_id); }));
  api.get('/ivr/menu', wrap(async req => {
    const u = requirePerm(req, 'platform.view');
    const school = await app.db.findOne('schools', { id: u.school_id });
    if (!school) throw new HttpError(404, 'school not found', 'not_found');
    return app.ivr.menu(school);
  }));
  /** Sets the secret the gateway will send. Written encrypted; never read back out. */
  api.post('/ivr/secret', wrap(async req => {
    const u = requirePerm(req, 'platform.settings');
    const b = z.object({ secret: z.string().min(12).max(200) }).parse(req.body);
    const r = await app.ivr.setSecret(u.school_id, b.secret);
    await app.audit.log({ action: 'update', entityType: 'ivr.secret', entityId: u.school_id, after: { configured: true } });
    return { ...r, webhookUrl: `${app.config.appUrl}/api/ivr/${u.school_id}/step` };
  }));

  /**
   * One step of a call. The gateway posts the caller's number, its own call id and the keys pressed,
   * and gets back what to say, which digits to accept next, and whether to hang up.
   *
   * Keys arrive either way round: a gateway that collects one digit at a time posts `digits` and
   * hands back the `keys` we returned last time (which is what `next` is for), and one that keeps
   * the whole path itself posts it all in `digits`. Nothing is remembered between requests, so a
   * Passenger process recycled mid-call does not drop the caller.
   */
  api.post('/ivr/:school/step', wrap(async (req, res) => {
    const b = z.object({
      callId: z.string().min(1).max(120).optional(), call_id: z.string().min(1).max(120).optional(),
      from: z.string().min(3).max(30).optional(), caller: z.string().min(3).max(30).optional(), phone: z.string().min(3).max(30).optional(),
      keys: z.string().max(40).optional(), digits: z.string().max(40).optional(), input: z.string().max(40).optional(),
      secret: z.string().max(200).optional(),
    }).parse(req.body ?? {});
    const q = (k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);
    const school = await app.ivr.resolveSchool(req.params.school as string);
    if (!school) { res.status(404); return { error: 'unknown school' }; }
    // a header where the gateway can set one, the body where it cannot; an empty header falls through
    await app.ivr.authenticate(String(school.id), String(req.headers['x-ivr-secret'] || b.secret || q('secret') || ''));

    const callId = b.callId ?? b.call_id ?? q('callId');
    const from = b.from ?? b.caller ?? b.phone ?? q('from');
    if (!callId || !from) throw new HttpError(400, 'callId and from are required', 'bad_request');
    const keys = `${b.keys ?? q('keys') ?? ''}${b.digits ?? b.input ?? q('digits') ?? ''}`;
    const reply = await app.ivr.step(school, { callId, from, keys });
    return { ...reply, next: reply.end ? null : `${app.config.appUrl}/api/ivr/${req.params.school}/step?keys=${reply.keys}` };
  }));
}
