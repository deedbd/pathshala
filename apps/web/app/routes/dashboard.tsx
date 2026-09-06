import { useLoaderData } from 'react-router';
import type { Route } from './+types/dashboard';
import { chipClass, feedClass, formatDateTime, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const { db } = context.app;
  const sid = user.school_id;
  const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  const [students, tasks, approvals, runs, recent, jobs] = await Promise.all([
    db.count('students', { school_id: sid, status: 'active' }).catch(() => 0),
    db.count('tasks', { school_id: sid, status: 'open' }),
    db.count('approval_requests', { school_id: sid, status: 'pending' }),
    db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM automation_runs WHERE school_id = ? AND started_at >= ?`, [sid, since]).then(r => Number(r[0]?.n ?? 0)),
    db.query<{ id: string; status: string; started_at: string; code: string; name: string; error: string | null }>(`SELECT r.id, r.status, r.started_at, r.error, a.code, a.name FROM automation_runs r JOIN automation_rules a ON a.id = r.rule_id WHERE r.school_id = ? ORDER BY r.started_at DESC LIMIT 10`, [sid]),
    db.findMany<{ id: string; job_name: string; status: string; created_at: string; error: string | null }>('background_jobs', { school_id: sid }, { orderBy: 'created_at DESC', limit: 10 }),
  ]);
  return { locale: (user.locale as Locale) || context.locale, name: user.display_name, students, tasks, approvals, runs, recent, jobs };
}

export function meta() { return [{ title: 'Pathshala — Dashboard' }]; }

export default function Dashboard() {
  const d = useLoaderData<typeof loader>();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const feed = [
    ...d.recent.map(r => ({ id: r.id, kind: 'rule' as const, at: r.started_at, title: `${r.code} · ${r.name}`, status: r.status, error: r.error })),
    ...d.jobs.map(j => ({ id: j.id, kind: 'system' as const, at: j.created_at, title: j.job_name, status: j.status, error: j.error })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 12);
  return (
    <div>
      <h1 className="text-2xl">{tr('dash.welcome')}, {d.name}</h1>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {([['dash.students', d.students], ['dash.openTasks', d.tasks], ['dash.pendingApprovals', d.approvals], ['dash.automationRuns', d.runs]] as const).map(([k, v]) => (
          <div className="kpi" key={k}><div className="kpi-label">{tr(k)}</div><div className="kpi-value num">{formatNumber(v, d.locale)}</div></div>
        ))}
      </div>
      <section className="card mt-6 p-4">
        <h2 className="text-base">{tr('dash.recent')}</h2>
        {feed.length === 0 ? <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>{tr('dash.empty')}</p> : (
          <ul className="mt-2">
            {feed.map(f => (
              <li key={f.id} className="feed-item">
                <span className={feedClass(f.kind)}>{f.kind === 'rule' ? '⚙' : '●'}</span>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm">{f.title}</div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>{formatDateTime(f.at, d.locale)}{f.error ? ` · ${f.error.slice(0, 120)}` : ''}</div>
                </div>
                <span className={chipClass(f.status)}>{t(`status.${f.status}` as never, d.locale)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
