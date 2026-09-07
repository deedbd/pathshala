import type { Request, Response, Router } from 'express';
import { type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const currency = z.string().length(3);

/**
 * Year 4 API: multi-school groups, the consolidated view, inter-school transfers, exchange rates, and
 * the guardian's cross-school family view.
 *
 * Two rules run through every route here. A console endpoint is scoped to the caller's own school and
 * the service decides whether that school may see the others — `requirePerm` cannot, because a school
 * administrator legitimately holds `platform.*` inside their own school and must still be refused the
 * next school's figures. And the family view sits under `/api/portal/*`, authorised by the guardian's
 * own account, so no permission a school can grant reaches across the group.
 */
export function mountPhase16(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User, requireUser: (req: Request) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);

  // ---------- the group ----------
  api.get('/groups', wrap(async req => { const u = requirePerm(req, 'platform.view'); return app.groups.groups(u.school_id); }));
  api.post('/groups', wrap(async req => {
    const u = requirePerm(req, 'platform.settings');
    const b = z.object({ name: z.string().min(2).max(160), nameBn: z.string().max(160).optional().nullable(), ownerUserId: z.string().optional().nullable(), baseCurrency: currency.optional().nullable(), schoolIds: z.array(z.string()).max(50).optional() }).parse(req.body);
    const r = await app.groups.createGroup(u.school_id, b);
    await app.audit.log({ action: 'create', entityType: 'core.school_group', entityId: r.id, after: { name: r.name, schools: r.schools, baseCurrency: r.baseCurrency } });
    return r;
  }));

  // exchange rates and transfers are literal paths that share a shape with /groups/:id/… — Express
  // matches in order, so they are registered before anything parameterised
  api.get('/groups/rates', wrap(async req => { requirePerm(req, 'accounting.view'); return app.groups.rates({ baseCcy: q(req, 'baseCcy'), quoteCcy: q(req, 'quoteCcy') }); }));
  api.post('/groups/rates', wrap(async req => {
    const u = requirePerm(req, 'accounting.edit');
    const b = z.object({ baseCcy: currency, quoteCcy: currency, rate: z.coerce.number().positive().max(1_000_000), asOf: dateSchema.optional(), source: z.string().max(60).optional().nullable() }).parse(req.body);
    const r = await app.groups.setRate(u.school_id, b);
    await app.audit.log({ action: r.updated ? 'update' : 'create', entityType: 'core.currency_rate', entityId: r.id, after: b });
    return r;
  }));
  api.get('/groups/transfers', wrap(async req => { const u = requirePerm(req, 'people.view'); return app.groups.transfers(u.school_id); }));
  api.post('/groups/transfers', wrap(async req => {
    // the transfer is always *out of* the caller's own school: a school cannot pull a child out of another
    const u = requirePerm(req, 'people.edit');
    const b = z.object({ studentId: z.string(), toSchoolId: z.string(), toClassId: z.string().optional().nullable(), reason: z.string().max(255).optional().nullable() }).parse(req.body);
    const r = await app.groups.transferStudent(u.school_id, { ...b, byUserId: u.id });
    await app.audit.log({ action: 'update', entityType: 'people.student', entityId: b.studentId, after: { transferredTo: b.toSchoolId, toStudentId: r.toStudentId, dues: r.dues } });
    return r;
  }));

  api.get('/groups/:id/schools', wrap(async req => { const u = requirePerm(req, 'platform.view'); await app.groups.requireHead(req.params.id as string, u.school_id); return app.groups.memberSchools(req.params.id as string); }));
  api.post('/groups/:id/schools', wrap(async req => {
    const u = requirePerm(req, 'platform.settings');
    const b = z.object({ schoolId: z.string() }).parse(req.body);
    const r = await app.groups.addSchool(req.params.id as string, u.school_id, b.schoolId);
    await app.audit.log({ action: 'create', entityType: 'core.school_group_member', entityId: r.id, after: { groupId: req.params.id, schoolId: b.schoolId } });
    return r;
  }));
  api.post('/groups/:id/schools/:schoolId/remove', wrap(async req => { const u = requirePerm(req, 'platform.settings'); return app.groups.removeSchool(req.params.id as string, u.school_id, req.params.schoolId as string); }));

  api.get('/groups/:id/consolidated', wrap(async req => {
    const u = requirePerm(req, 'platform.view');
    // an unparsed date reaches `new Date` and throws a RangeError as a 500; every other module
    // validates its dates at the door, and this one had the schema imported and unused
    const b = z.object({ day: dateSchema.optional(), days: z.coerce.number().int().min(1).max(180).optional() })
      .parse({ day: q(req, 'day'), days: q(req, 'days') });
    return app.groups.consolidated(req.params.id as string, u.school_id, b);
  }));
  api.get('/groups/:id/staff', wrap(async req => {
    const u = requirePerm(req, 'hr.view');
    return app.groups.staffPool(req.params.id as string, u.school_id, { q: q(req, 'q'), category: q(req, 'category') });
  }));

  // ---------- the parent super-app ----------
  // one guardian login, every child of theirs in this installation; the service refuses any account
  // that is not a guardian, so a staff session cannot read it
  api.get('/portal/family', wrap(async req => { const u = requireUser(req); return app.groups.familyChildren(u); }));
}
