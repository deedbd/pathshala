import type { Request, Response, Router } from 'express';
import { type App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The automation console's API, plus the endpoints for the rules the prototype promised and the
 * code did not keep: the invigilator roster, a reissued ID card and the reminder ladder.
 *
 * Reading is `platform.view`; deciding an approval is `platform.approve`; anything that changes what
 * the machine will do on its own is `platform.automation`, which is the permission the rules page
 * has always been gated on.
 */
export function mountAutomation(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User) {
  // ---------- approvals inbox ----------
  api.get('/automation/approvals', wrap(async req => { const u = requirePerm(req, 'platform.view'); return app.automation.pendingApprovals(u.school_id); }));
  api.post('/automation/approvals/:id/decide', wrap(async req => {
    const u = requirePerm(req, 'platform.approve');
    const b = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(500).optional() }).parse(req.body);
    const r = await app.automation.decideApproval(u.school_id, req.params.id as string, b.decision, b.comment);
    await app.audit.log({ action: 'approve', entityType: 'platform.approval', entityId: req.params.id as string, after: { decision: b.decision, comment: b.comment ?? null } });
    return r;
  }));

  // ---------- tasks ----------
  api.get('/automation/tasks', wrap(async req => {
    const u = requirePerm(req, 'platform.view');
    const q = z.object({ assignedTo: z.string().optional(), assignedRole: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return app.automation.openTasks(u.school_id, q);
  }));
  api.post('/automation/tasks', wrap(async req => {
    const u = requirePerm(req, 'platform.edit');
    const b = z.object({ title: z.string().min(2).max(200), description: z.string().max(2000).optional(), assignedRole: z.string().max(60).optional(), assignedTo: z.string().optional(), dueAt: z.string().optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional() }).parse(req.body);
    return { id: await app.tasks.create({ schoolId: u.school_id, ...b, taskType: 'manual', createdBy: u.id }) };
  }));
  api.post('/automation/tasks/:id/complete', wrap(async req => {
    const u = requirePerm(req, 'platform.edit');
    const r = await app.automation.completeTask(u.school_id, req.params.id as string);
    await app.audit.log({ action: 'update', entityType: 'platform.task', entityId: req.params.id as string, after: { status: 'done' } });
    return r;
  }));

  // ---------- rules and their preview ----------
  api.get('/automation/rules', wrap(async req => { const u = requirePerm(req, 'platform.view'); return app.automation.rules(u.school_id); }));
  api.post('/automation/rules/:id/active', wrap(async req => {
    const u = requirePerm(req, 'platform.automation');
    const b = z.object({ active: z.coerce.boolean(), preview: z.coerce.boolean().optional() }).parse(req.body);
    const r = await app.automation.setRuleActive(u.school_id, req.params.id as string, b.active, { preview: b.preview });
    await app.audit.log({ action: 'update', entityType: 'automation_rule', entityId: req.params.id as string, after: { is_active: b.active, preview_until: r.previewUntil } });
    return r;
  }));
  api.post('/automation/rules/:id/go-live', wrap(async req => {
    const u = requirePerm(req, 'platform.automation');
    const r = await app.automation.endPreview(u.school_id, req.params.id as string);
    await app.audit.log({ action: 'update', entityType: 'automation_rule', entityId: req.params.id as string, after: { preview_until: null } });
    return r;
  }));
  api.get('/automation/preview', wrap(async req => {
    const u = requirePerm(req, 'platform.view');
    const q = z.object({ ruleId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return app.automation.previewRuns(u.school_id, q);
  }));

  // ---------- activity ----------
  api.get('/automation/runs', wrap(async req => {
    const u = requirePerm(req, 'platform.view');
    const q = z.object({ ruleId: z.string().optional(), day: day.optional(), status: z.enum(['success', 'failed', 'skipped', 'preview', 'running']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return { summary: await app.automation.activitySummary(u.school_id, q.day), runs: await app.automation.runs(u.school_id, q) };
  }));

  // ---------- scheduled and background jobs ----------
  api.get('/automation/jobs', wrap(async req => {
    const u = requirePerm(req, 'platform.view');
    return { scheduled: await app.automation.scheduledJobs(u.school_id), background: await app.automation.backgroundJobs(u.school_id) };
  }));
  api.post('/automation/jobs/:key/run', wrap(async req => {
    const u = requirePerm(req, 'platform.automation');
    const r = await app.automation.runJobNow(u.school_id, req.params.key as string);
    await app.audit.log({ action: 'update', entityType: 'scheduled_job', entityId: req.params.key as string, after: { ranNow: true, status: r.lastStatus } });
    return r;
  }));
  api.post('/automation/jobs/:key/active', wrap(async req => {
    const u = requirePerm(req, 'platform.automation');
    const b = z.object({ active: z.coerce.boolean() }).parse(req.body);
    const r = await app.automation.setJobActive(u.school_id, req.params.key as string, b.active);
    await app.audit.log({ action: 'update', entityType: 'scheduled_job', entityId: req.params.key as string, after: { is_active: b.active } });
    return r;
  }));

  // ---------- integrations ----------
  api.get('/automation/webhooks', wrap(async req => {
    const u = requirePerm(req, 'platform.view');
    const q = z.object({ webhookId: z.string().optional() }).parse(req.query);
    return { webhooks: await app.automation.webhooks(u.school_id), deliveries: await app.automation.deliveries(u.school_id, q) };
  }));
  api.post('/automation/webhooks/:id/active', wrap(async req => {
    const u = requirePerm(req, 'platform.automation');
    const b = z.object({ active: z.coerce.boolean() }).parse(req.body);
    const r = await app.automation.setWebhookActive(u.school_id, req.params.id as string, b.active);
    await app.audit.log({ action: 'update', entityType: 'platform.webhook', entityId: req.params.id as string, after: { is_active: b.active } });
    return r;
  }));

  // ---------- the rules the prototype promised ----------
  /** The invigilator roster: who stands in which hall for which paper. */
  api.get('/exams/:id/invigilators', wrap(async req => { const u = requirePerm(req, 'assessment.view'); return app.assessment.invigilators(u.school_id, req.params.id as string); }));
  api.post('/exams/:id/invigilators/roster', wrap(async req => {
    const u = requirePerm(req, 'assessment.edit');
    const b = z.object({ perRoom: z.coerce.number().int().min(1).max(4).optional(), staffIds: z.array(z.string()).max(500).optional(), replace: z.coerce.boolean().optional() }).parse(req.body ?? {});
    return app.assessment.rosterInvigilators(u.school_id, req.params.id as string, b);
  }));
  api.post('/exams/:id/invigilators', wrap(async req => {
    const u = requirePerm(req, 'assessment.edit');
    const b = z.object({ scheduleId: z.string(), roomId: z.string(), staffId: z.string() }).parse(req.body);
    return app.assessment.assignInvigilator(u.school_id, b.scheduleId, b.roomId, b.staffId);
  }));
  api.delete('/exams/invigilators/:id', wrap(async req => { const u = requirePerm(req, 'assessment.edit'); return { removed: await app.assessment.removeInvigilator(u.school_id, req.params.id as string) }; }));

  /** A lost card, replaced: the old tag stops working and the replacement fee is invoiced. */
  api.get('/documents/id-cards', wrap(async req => {
    const u = requirePerm(req, 'documents.view');
    const q = z.object({ personType: z.enum(['student', 'staff']).optional(), status: z.string().max(20).optional(), personId: z.string().optional() }).parse(req.query);
    return app.documents.idCards(u.school_id, q);
  }));
  api.post('/documents/id-cards/:id/reissue', wrap(async req => {
    const u = requirePerm(req, 'documents.create');
    const b = z.object({ reason: z.string().max(60).optional(), validTo: day.optional() }).parse(req.body ?? {});
    const r = await app.documents.reissueIdCard(u.school_id, req.params.id as string, { ...b, createdBy: u.id });
    await app.audit.log({ action: 'update', entityType: 'documents.id_card', entityId: req.params.id as string, after: { status: 'lost', replacedBy: r.cardNo } });
    return r;
  }));

  /** The reminder ladder as the console shows it: every stage, when it fired, and the delivery log. */
  api.get('/fees/reminders', wrap(async req => { const u = requirePerm(req, 'fees.view'); return app.fees.reminderLadder(u.school_id); }));
}
