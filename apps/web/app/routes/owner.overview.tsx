import { Link, useLoaderData } from 'react-router';
import type { Route } from './+types/owner.overview';
import { Banner, Chip, Kpi, formatMoney, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';
import { ownerApi, ownerLoad } from '~/owner-api';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const overview = await ownerLoad(() => ownerApi(context).overview());
  return { locale: (user.locale as Locale) || context.locale, overview };
}
export function meta() { return [{ title: 'Pathshala — Owner overview' }]; }

export default function OwnerOverview() {
  const d = useLoaderData<typeof loader>();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const o = d.overview;
  if (!o) return <Banner kind="warn">{t('own.refused', d.locale)}</Banner>;
  const num = (n: number) => formatNumber(n, d.locale);
  const money = (n: number) => formatMoney(n, d.locale);
  const health = [
    { key: 'failedJobs', label: tr('own.failedJobs'), n: o.health.failedJobs },
    { key: 'staleBackups', label: tr('own.staleBackups'), n: o.health.staleBackups },
    { key: 'stuckEvents', label: tr('own.stuckEvents'), n: o.health.stuckEvents },
  ];
  const wrong = health.reduce((a, h) => a + h.n, 0);

  return (
    <div>
      <div><h1 className="text-2xl">{tr('own.overview')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('own.purpose')}</p></div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={tr('own.schools')} value={o.schools.total} locale={d.locale} />
        <Kpi label={tr('own.students')} value={o.students} locale={d.locale} />
        <Kpi label={tr('own.staff')} value={o.staff} locale={d.locale} />
        <div className="kpi"><div className="kpi-label">{tr('own.mrr')}</div><div className="kpi-value num">{money(o.mrr)}</div><div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{o.currency}</div></div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="kpi"><div className="kpi-label">{tr('own.live')}</div><div className="kpi-value num">{num(o.schools.active)}</div></div>
        <div className="kpi"><div className="kpi-label">{tr('own.trial')}</div><div className="kpi-value num">{num(o.schools.trial)}</div></div>
        <div className="kpi"><div className="kpi-label">{tr('own.pastDue')}</div><div className="kpi-value num">{num(o.schools.pastDue)}</div></div>
        <div className="kpi"><div className="kpi-label">{tr('own.suspended')}</div><div className="kpi-value num">{num(o.schools.suspended)}</div></div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="kpi"><div className="kpi-label">{tr('own.outstanding')}</div><div className="kpi-value num">{money(o.invoicesOutstanding)}</div></div>
        <Kpi label={tr('own.ticketsOpen')} value={o.ticketsOpen} locale={d.locale} />
      </div>

      <h2 className="mt-6 text-base">{tr('own.health')}</h2>
      <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('own.healthNote')}</p>
      <div className="mt-2 card p-4">
        {wrong === 0 ? <p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('own.allWell')}</p>
          : <div className="flex flex-wrap gap-2">{health.filter(h => h.n > 0).map(h => <Chip key={h.key} status="failed">{h.label}: {num(h.n)}</Chip>)}</div>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Link className="btn btn-secondary btn-sm" to="/owner/health">{tr('own.health')}</Link>
          <Link className="btn btn-secondary btn-sm" to="/owner/billing">{tr('own.billing')}</Link>
          <Link className="btn btn-sm" to="/owner/schools">{tr('own.schools')}</Link>
        </div>
      </div>
    </div>
  );
}
