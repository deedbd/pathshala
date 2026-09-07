import { useLoaderData } from 'react-router';
import type { Route } from './+types/owner.health';
import { Banner, Chip, DataTable, formatDate, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';
import { num, ownerApi, ownerLoad, requireOwnerOr404, str, type OwnerHealthReport, type Row } from '~/owner-api';

export async function loader({ context, request }: Route.LoaderArgs) {
  await requireOwnerOr404(context);
  const user = requireUser(context, request);
  const health = await ownerLoad(() => ownerApi(context).health());
  return { locale: (user.locale as Locale) || context.locale, denied: health === null, health };
}
export function meta() { return [{ title: 'Pathshala — Owner health' }]; }

interface Finding { id: string; school: string; kind: string; detail: string; count: number | null; checkedAt: string }

/**
 * The watchdog reports per school, and a school's entry may carry its findings in a nested list.
 * Both shapes are flattened to one line per finding; a report that names its own kinds
 * (failedJobs / staleBackups / stuckEvents) is read the same way.
 */
function flatten(report: OwnerHealthReport | Row[] | null): Finding[] {
  if (!report) return [];
  const out: Finding[] = [];
  const push = (school: string, kind: string, r: Row, i: number) => out.push({
    id: `${school}:${kind}:${i}`,
    school,
    kind: str(r.kind ?? r.check_key ?? kind) || kind,
    detail: str(r.detail ?? r.message ?? r.status),
    count: r.count == null ? null : num(r.count),
    checkedAt: str(r.checked_at ?? r.checkedAt ?? ''),
  });
  const walk = (rows: Row[], kind: string) => rows.forEach((row, i) => {
    const school = str(row.school_name ?? row.school ?? row.name ?? row.school_id);
    const nested = row.findings ?? row.problems;
    if (Array.isArray(nested)) (nested as Row[]).forEach((f, j) => push(school, kind, f, i * 100 + j));
    else push(school, kind, row, i);
  });
  if (Array.isArray(report)) { walk(report, 'finding'); return out; }
  walk(report.rows ?? report.schools ?? report.findings ?? [], 'finding');
  walk(report.failedJobs ?? [], 'scheduled_job');
  walk(report.staleBackups ?? [], 'backup');
  walk(report.stuckEvents ?? [], 'outbox');
  return out;
}

export default function OwnerHealth() {
  const d = useLoaderData<typeof loader>();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  if (d.denied) return <Banner kind="warn">{tr('own.refused')}</Banner>;
  const findings = flatten(d.health as OwnerHealthReport | Row[] | null);
  const kinds = [...new Set(findings.map(f => f.kind))];

  return (
    <div>
      <div><h1 className="text-2xl">{tr('own.health')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('own.healthNote')}</p></div>
      {findings.length === 0 ? <div className="mt-4"><Banner kind="ok">{tr('own.allWell')}</Banner></div> : (
        <>
          <div className="mt-4 flex flex-wrap gap-2">
            {kinds.map(k => <Chip key={k} status="failed">{k}: {formatNumber(findings.filter(f => f.kind === k).length, d.locale)}</Chip>)}
          </div>
          <div className="mt-3">
            <DataTable<Finding> locale={d.locale} rows={findings} searchPlaceholder={tr('own.searchSchools')} columns={[
              { key: 'school', label: tr('own.school'), render: r => r.school || '—' },
              { key: 'kind', label: tr('own.kind'), render: r => <Chip status="failed">{r.kind}</Chip> },
              { key: 'detail', label: tr('own.finding'), render: r => r.detail || '—' },
              { key: 'count', label: tr('own.count'), className: 'num', render: r => (r.count == null ? '—' : formatNumber(r.count, d.locale)) },
              { key: 'checkedAt', label: tr('own.checkedAt'), render: r => (r.checkedAt ? formatDate(r.checkedAt, d.locale) : '—') },
            ]} />
          </div>
        </>
      )}
    </div>
  );
}
