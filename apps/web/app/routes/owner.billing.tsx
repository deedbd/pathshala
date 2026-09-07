import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/owner.billing';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Select, Tabs, api, formatDate, formatMoney, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';
import { num, ownerApi, ownerLoad, requireOwnerOr404, str, type OwnerBuckets, type Row } from '~/owner-api';

const INVOICE_STATUSES = ['draft', 'unpaid', 'overdue', 'paid', 'void'];

export async function loader({ context, request }: Route.LoaderArgs) {
  await requireOwnerOr404(context);
  const user = requireUser(context, request);
  const status = new URL(request.url).searchParams.get('status') ?? '';
  const billing = await ownerLoad(() => ownerApi(context).billing({ status: status || undefined }));
  return { locale: (user.locale as Locale) || context.locale, denied: billing === null, status, billing };
}
export function meta() { return [{ title: 'Pathshala — Owner billing' }]; }

/** Dunning buckets arrive either as rows or as an age → figure map; both are read, neither is invented. */
function bucketList(b: OwnerBuckets): { label: string; count: number | null; amount: number | null }[] {
  if (!b) return [];
  const one = (label: string, v: number | Row) => typeof v === 'number'
    ? { label, count: null, amount: v }
    : { label: str(v.bucket ?? v.label ?? v.age) || label, count: v.count == null ? null : num(v.count), amount: v.amount == null && v.total == null ? null : num(v.amount ?? v.total) };
  return Array.isArray(b) ? b.map((r, i) => one(str(r.bucket ?? r.label ?? r.age) || String(i), r)) : Object.entries(b).map(([k, v]) => one(k, v));
}

export default function OwnerBilling() {
  const d = useLoaderData<typeof loader>();
  const rv = useRevalidator();
  const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'invoices' | 'partners'>('invoices');
  const [paying, setPaying] = useState<Row | null>(null);
  const [partner, setPartner] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  const money = (v: unknown) => formatMoney(num(v), d.locale);
  const date = (v: unknown) => (v ? formatDate(str(v), d.locale) : '—');

  if (d.denied || !d.billing) return <Banner kind="warn">{tr('own.refused')}</Banner>;
  const buckets = bucketList(d.billing.buckets);

  return (
    <div>
      <div><h1 className="text-2xl">{tr('own.billing')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('own.billingPurpose')}</p></div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}

      <h2 className="mt-4 text-base">{tr('own.dunning')}</h2>
      <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {buckets.length === 0 && <p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('own.nothingYet')}</p>}
        {buckets.map(b => (
          <div key={b.label} className="kpi">
            <div className="kpi-label">{b.label}</div>
            <div className="kpi-value num">{b.amount == null ? formatNumber(b.count ?? 0, d.locale) : money(b.amount)}</div>
            {b.count != null && b.amount != null && <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{formatNumber(b.count, d.locale)} {tr('own.count')}</div>}
          </div>
        ))}
      </div>

      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'invoices', label: tr('own.invoices'), count: d.billing.invoices.length },
        { key: 'partners', label: tr('own.partners'), count: d.billing.partners.length },
      ]} /></div>

      {tab === 'invoices' && <div className="mt-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Select value={d.status} onChange={e => setParam('status', e.target.value)} placeholder={tr('own.anyStatus')} options={INVOICE_STATUSES.map(s => ({ value: s, label: s }))} className="max-w-[200px]" />
        </div>
        <DataTable<Row> locale={d.locale} rows={d.billing.invoices} searchPlaceholder={tr('own.searchSchools')} columns={[
          { key: 'school', label: tr('own.school'), render: r => str(r.school_name ?? r.school ?? r.school_id) },
          { key: 'invoice_no', label: tr('fee.invoiceNo'), className: 'num', render: r => str(r.invoice_no) },
          { key: 'period_start', label: tr('plat.period'), render: r => `${date(r.period_start)} — ${date(r.period_end)}` },
          { key: 'total', label: tr('own.amount'), className: 'num money', render: r => money(r.total) },
          { key: 'due_date', label: tr('fee.due'), render: r => date(r.due_date) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={str(r.status) === 'paid' ? 'paid' : str(r.status) === 'overdue' ? 'overdue' : 'pending'}>{str(r.status)}</Chip> },
          { key: 'id', label: '', render: r => str(r.status) === 'paid' ? null : <Button size="sm" variant="secondary" onClick={() => setPaying(r)}>{tr('own.markPaid')}</Button> },
        ]} />
      </div>}

      {tab === 'partners' && <div className="mt-4">
        <div className="mb-2 flex justify-end"><Button size="sm" onClick={() => setPartner(true)}>{tr('own.newPartner')}</Button></div>
        <DataTable<Row> locale={d.locale} searchable={false} rows={d.billing.partners} columns={[
          { key: 'name', label: tr('common.name'), render: r => str(r.name) },
          { key: 'referral_code', label: tr('own.referralCode'), className: 'num', render: r => str(r.referral_code) },
          { key: 'commission_pct', label: tr('own.commission'), className: 'num', render: r => formatNumber(num(r.commission_pct), d.locale) },
          { key: 'created_at', label: tr('common.date'), render: r => date(r.created_at) },
        ]} />
        <h2 className="mt-6 text-base">{tr('own.payouts')}</h2>
        <div className="mt-2"><DataTable<Row> locale={d.locale} searchable={false} rows={d.billing.payouts} columns={[
          { key: 'partner', label: tr('own.partners'), render: r => str(r.partner_name ?? r.partner_id) },
          { key: 'amount', label: tr('own.amount'), className: 'num money', render: r => money(r.amount) },
          { key: 'period', label: tr('plat.period'), render: r => date(r.period_start ?? r.period) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={str(r.status) === 'paid' ? 'paid' : 'pending'}>{str(r.status)}</Chip> },
          { key: 'id', label: '', render: r => str(r.status) === 'paid' ? null : <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => api(`/api/saas/payouts/${str(r.id)}/paid`, { method: 'POST', json: {} }))}>{tr('own.markPaid')}</Button> },
        ]} /></div>
      </div>}

      <Drawer open={!!paying} onClose={() => setPaying(null)} title={tr('own.markPaid')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); const id = str(paying?.id); run(async () => { await api(`/api/saas/invoices/${id}/paid`, { method: 'POST', json: { ...(f.reference ? { reference: f.reference } : {}) } }); setPaying(null); }); }}>
          <div className="text-sm">{str(paying?.invoice_no)} · {money(paying?.total)}</div>
          <Field label={tr('own.reference')} hint={tr('own.referenceHint')}><Input name="reference" maxLength={120} /></Field>
          <Button disabled={busy}>{tr('own.markPaid')}</Button>
        </form>
      </Drawer>

      <Drawer open={partner} onClose={() => setPartner(false)} title={tr('own.newPartner')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { await api('/api/saas/partners', { method: 'POST', json: { name: f.name, ...(f.commissionPct ? { commissionPct: Number(f.commissionPct) } : {}), ...(f.referralCode ? { referralCode: f.referralCode } : {}) } }); setPartner(false); }); }}>
          <Field label={tr('common.name')}><Input name="name" required minLength={2} maxLength={160} /></Field>
          <Field label={tr('own.commission')}><Input name="commissionPct" type="number" min={0} max={50} /></Field>
          <Field label={tr('own.referralCode')}><Input name="referralCode" maxLength={30} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
