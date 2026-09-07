import type { Request, Response, Router } from 'express';
import type { App } from '@pathshala/core';
import { z } from '@pathshala/schemas';

type Wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: (e?: unknown) => void) => void;
type User = { id: string; school_id: string; user_type: string };

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/**
 * Phase 17 API: the year-4/5 forecasts — fees and cash flow, staffing, and the wellbeing
 * early-warning watchlist.
 *
 * Every route here is a read. Nothing on this router raises an invoice, hires anybody, messages a
 * guardian or changes a record; the one POST recomputes scores in `risk_scores` and even that only
 * puts names in front of a person. Each response carries its own `assumptions`, `blindSpots` and
 * `disclaimer`, and the routes never strip them: a client is free to hide the working, but the API
 * will not hand out a projection that has none.
 *
 * The gates follow the data being projected rather than a new module of their own — the cash flow
 * is fee data (`fees.view`), the staffing forecast is HR and timetable data (`hr.view`), and the
 * wellbeing score lives in `risk_scores`, so it is gated exactly as `/analytics/risks` is.
 */
export function mountPhase17(api: Router, app: App, wrap: Wrap, requirePerm: (req: Request, perm: string) => User) {
  const q = (req: Request, k: string) => (typeof req.query[k] === 'string' ? String(req.query[k]) : undefined);
  const num = (req: Request, k: string) => (q(req, k) != null && q(req, k) !== '' ? Number(q(req, k)) : undefined);

  // ---------- money: what will be billed, what is likely to arrive, what goes out ----------
  api.get('/forecast/cash-flow', wrap(async req => {
    const u = requirePerm(req, 'fees.view');
    const p = z.object({ months: z.coerce.number().int().min(3).max(6).optional(), historyMonths: z.coerce.number().int().min(3).max(24).optional(), asOf: dateSchema.optional(), academicYearId: z.string().optional() })
      .parse({ months: num(req, 'months'), historyMonths: num(req, 'historyMonths'), asOf: q(req, 'asOf'), academicYearId: q(req, 'academicYearId') });
    return app.forecast.cashFlow(u.school_id, p);
  }));

  // ---------- people: which subjects have periods with nobody to teach them ----------
  api.get('/forecast/staffing', wrap(async req => {
    const u = requirePerm(req, 'hr.view');
    const p = z.object({ asOf: dateSchema.optional(), horizonDays: z.coerce.number().int().min(30).max(365).optional(), maxPeriodsPerWeek: z.coerce.number().int().min(6).max(48).optional(), academicYearId: z.string().optional() })
      .parse({ asOf: q(req, 'asOf'), horizonDays: num(req, 'horizonDays'), maxPeriodsPerWeek: num(req, 'maxPeriodsPerWeek'), academicYearId: q(req, 'academicYearId') });
    return app.forecast.staffing(u.school_id, p);
  }));

  // ---------- wellbeing: the early-warning watchlist ----------
  // Express matches in order, so the literal `/wellbeing/compute` goes in first: the day this router
  // grows a `/forecast/:kind` or a `/forecast/wellbeing/:id`, a route registered above it would
  // swallow `compute` as a parameter — the same trap `/exams/annual/compute` fell into.
  api.post('/forecast/wellbeing/compute', wrap(async req => {
    const u = requirePerm(req, 'analytics.edit');
    const b = z.object({ asOf: dateSchema.optional(), notifyAbove: z.coerce.number().int().min(1).max(100).optional(), windowDays: z.coerce.number().int().min(14).max(365).optional() }).parse(req.body ?? {});
    return app.forecast.computeWellbeing(u.school_id, b);
  }));
  api.get('/forecast/wellbeing', wrap(async req => {
    const u = requirePerm(req, 'analytics.view');
    return app.forecast.wellbeingWatchlist(u.school_id, num(req, 'minScore') ?? 40);
  }));
}
