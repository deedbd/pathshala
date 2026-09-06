import { Form, useLoaderData, useNavigation } from 'react-router';
import type { Route } from './+types/automation';
import { chipClass, formatDateTime, t, type Locale } from '@pathshala/ui';
import { assertSameOrigin, formString, requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  context.app.rbac.require('platform.view', await context.app.rbac.accessFor(user.id));
  const { db } = context.app; const sid = user.school_id;
  const [runs, jobs, scheduled, rules] = await Promise.all([
    db.query<{ id: string; status: string; started_at: string; error: string | null; aggregate_type: string; code: string; name: string; module: string }>(`SELECT r.id, r.status, r.started_at, r.error, r.aggregate_type, a.code, a.name, a.module FROM automation_runs r JOIN automation_rules a ON a.id = r.rule_id WHERE r.school_id = ? ORDER BY r.started_at DESC LIMIT 30`, [sid]),
    db.findMany<{ id: string; job_name: string; queue: string; status: string; attempts: number; progress_pct: number; scheduled_for: string; error: string | null }>('background_jobs', { school_id: sid }, { orderBy: 'created_at DESC', limit: 30 }),
    db.findMany<{ id: string; job_key: string; cron_expr: string; next_run_at: string | null; last_run_at: string | null; last_status: string | null; is_active: unknown }>('scheduled_jobs', { school_id: sid }, { orderBy: 'next_run_at ASC' }),
    db.findMany<{ id: string; code: string; name: string; module: string; event_type: string | null; is_active: unknown; run_count: number; preview_until: string | null }>('automation_rules', { school_id: sid }, { orderBy: 'module ASC, code ASC' }),
  ]);
  return { locale: (user.locale as Locale) || context.locale, runs, jobs, scheduled, rules, mode: context.app.adapters.mode, canEdit: context.app.rbac.can('platform.automation', await context.app.rbac.accessFor(user.id)) };
}

export async function action({ context, request }: Route.ActionArgs) {
  const user = requireUser(context, request);
  assertSameOrigin(request, context.app.config.appUrl);
  context.app.rbac.require('platform.automation', await context.app.rbac.accessFor(user.id));
  const fd = await request.formData();
  const intent = formString(fd, 'intent');
  if (intent === 'tick') return { tick: await context.app.tick() };
  if (intent === 'toggle') {
    const id = formString(fd, 'id'); const active = formString(fd, 'active') === '1';
    await context.app.db.update('automation_rules', { is_active: active }, { id, school_id: user.school_id });
    await context.app.audit.log({ action: 'update', entityType: 'automation_rule', entityId: id, after: { is_active: active } });
    return { ok: true };
  }
  return null;
}

export function meta() { return [{ title: 'Pathshala — Automation' }]; }

export default function Automation() {
  const d = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const st = (s: string | null | undefined) => <span className={chipClass(s)}>{s ? t(`status.${s}` as never, d.locale) : '—'}</span>;
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('auto.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('auto.purpose')}</p></div>
        <div className="flex items-center gap-3">
          <span className="chip chip-cron">{tr('auto.mode')}: {d.mode}</span>
          {d.canEdit && <Form method="post"><button name="intent" value="tick" className="btn btn-secondary btn-sm" disabled={nav.state !== 'idle'}>{tr('auto.tick')}</button></Form>}
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <section className="card overflow-x-auto p-4">
          <h2 className="text-base" style={{ color: 'var(--auto)' }}>{tr('auto.runs')}</h2>
          <table className="table mt-2"><thead><tr><th>Rule</th><th>Aggregate</th><th>{tr('auto.lastRun')}</th><th>{tr('auto.status')}</th></tr></thead>
            <tbody>{d.runs.map(r => <tr key={r.id}><td><span className="num text-xs">{r.code}</span> {r.name}</td><td className="text-xs">{r.aggregate_type}</td><td className="text-xs">{formatDateTime(r.started_at, d.locale)}</td><td>{st(r.status)}{r.error && <div className="text-xs" style={{ color: 'var(--bad)' }}>{r.error.slice(0, 100)}</div>}</td></tr>)}
              {d.runs.length === 0 && <tr><td colSpan={4} className="text-xs" style={{ color: 'var(--muted)' }}>{tr('dash.empty')}</td></tr>}</tbody></table>
        </section>
        <section className="card overflow-x-auto p-4">
          <h2 className="text-base">{tr('auto.jobs')}</h2>
          <table className="table mt-2"><thead><tr><th>Job</th><th>Queue</th><th>%</th><th>{tr('auto.status')}</th></tr></thead>
            <tbody>{d.jobs.map(j => <tr key={j.id}><td>{j.job_name}<div className="text-xs" style={{ color: 'var(--muted)' }}>{formatDateTime(j.scheduled_for, d.locale)} · ×{j.attempts}</div></td><td className="text-xs">{j.queue}</td><td className="num text-xs">{Number(j.progress_pct)}</td><td>{st(j.status)}{j.error && <div className="text-xs" style={{ color: 'var(--bad)' }}>{j.error.slice(0, 100)}</div>}</td></tr>)}
              {d.jobs.length === 0 && <tr><td colSpan={4} className="text-xs" style={{ color: 'var(--muted)' }}>—</td></tr>}</tbody></table>
        </section>
        <section className="card overflow-x-auto p-4">
          <h2 className="text-base" style={{ color: 'var(--cron)' }}>{tr('auto.scheduled')}</h2>
          <table className="table mt-2"><thead><tr><th>Job</th><th>Cron</th><th>{tr('auto.nextRun')}</th><th>{tr('auto.lastRun')}</th></tr></thead>
            <tbody>{d.scheduled.map(s => <tr key={s.id}><td>{s.job_key}</td><td className="num text-xs whitespace-nowrap">{s.cron_expr}</td><td className="text-xs">{formatDateTime(s.next_run_at, d.locale)}</td><td className="text-xs">{formatDateTime(s.last_run_at, d.locale)} {s.last_status && st(s.last_status)}</td></tr>)}</tbody></table>
        </section>
        <section className="card overflow-x-auto p-4">
          <h2 className="text-base">{tr('auto.rules')}</h2>
          <table className="table mt-2"><thead><tr><th>#</th><th>Rule</th><th>Trigger</th><th>Runs</th><th></th></tr></thead>
            <tbody>{d.rules.map(r => <tr key={r.id}><td className="num text-xs">{r.code}</td><td>{r.name}<div className="text-xs" style={{ color: 'var(--muted)' }}>{r.module}</div></td><td className="text-xs">{r.event_type ?? '—'}</td><td className="num text-xs">{Number(r.run_count)}</td>
              <td>{d.canEdit ? <Form method="post"><input type="hidden" name="intent" value="toggle" /><input type="hidden" name="id" value={r.id} /><input type="hidden" name="active" value={Number(r.is_active) ? '0' : '1'} /><button className={`chip ${Number(r.is_active) ? 'chip-ok' : ''}`}>{Number(r.is_active) ? 'on' : 'off'}</button></Form> : st(Number(r.is_active) ? 'active' : 'inactive')}</td></tr>)}</tbody></table>
        </section>
      </div>
    </div>
  );
}
