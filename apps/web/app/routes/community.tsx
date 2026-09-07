import { useState } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/community';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, formatMoney, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id;
  const [outlets, products, sales, orders, funds, awards, campaigns, donors, donations, alumni, batches, mentorships, jobs, competitions, students] = await Promise.all([
    context.app.commerce.outlets(sid), context.app.commerce.products(sid), context.app.commerce.sales(sid), context.app.commerce.orders(sid),
    context.app.giving.funds(sid), context.app.giving.awards(sid), context.app.giving.campaigns(sid), context.app.giving.donors(sid), context.app.giving.donations(sid),
    context.app.alumni.directory(sid), context.app.alumni.batches(sid), context.app.alumni.pairs(sid, { activeOnly: true }), context.app.alumni.jobBoard(sid),
    context.app.engagement.competitions(sid), context.app.people.students(sid, { limit: 300 }),
  ]);
  const dayBook = outlets[0] ? await context.app.commerce.dayBook(sid, String(outlets[0].id)) : null;
  return { locale: (user.locale as Locale) || context.locale, outlets, products, sales, orders, funds, awards, campaigns, donors, donations, alumni, batches, mentorships, jobs, competitions, students: students.rows, dayBook };
}
export function meta() { return [{ title: 'Pathshala — Community' }]; }

export default function Community() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'shop' | 'giving' | 'alumni' | 'cocurricular'>('shop');
  const [drawer, setDrawer] = useState<null | 'topup' | 'outlet' | 'product' | 'sale' | 'fund' | 'award' | 'campaign' | 'donation' | 'job' | 'competition'>(null);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  const money = (n: unknown) => formatMoney(Number(n ?? 0), d.locale);
  const studentOptions = d.students.map(s => ({ value: String(s.id), label: `${s.admission_no} · ${s.first_name} ${s.last_name ?? ''}` }));
  const raised = d.campaigns.reduce((a, c) => a + Number(c.raised_amount), 0);
  const held = d.funds.reduce((a, f) => a + Number(f.balance), 0);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('com.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('com.purpose')}</p></div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={tr('com.today')} value={money(d.dayBook?.total ?? 0)} locale={d.locale} />
        <Kpi label={tr('com.funds')} value={money(held)} locale={d.locale} />
        <Kpi label={tr('com.raised')} value={money(raised)} locale={d.locale} />
        <Kpi label={tr('com.alumni')} value={d.alumni.length} locale={d.locale} />
      </div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}

      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'shop', label: tr('com.shop'), count: d.sales.length },
        { key: 'giving', label: tr('com.giving'), count: d.funds.length },
        { key: 'alumni', label: tr('com.alumni'), count: d.alumni.length },
        { key: 'cocurricular', label: tr('com.cocurricular'), count: d.competitions.length },
      ]} /></div>

      {tab === 'shop' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('outlet')}>{tr('com.newOutlet')}</Button>
          <Button size="sm" variant="secondary" onClick={() => setDrawer('product')}>{tr('com.newProduct')}</Button>
          <Button size="sm" variant="secondary" onClick={() => setDrawer('topup')}>{tr('com.topup')}</Button>
          <Button size="sm" onClick={() => setDrawer('sale')}>{tr('com.sell')}</Button>
        </div>
        {d.dayBook && <div className="card mb-3 p-4 text-sm">
          <div className="flex flex-wrap gap-4">
            <span><strong>{tr('com.today')}</strong> {money(d.dayBook.total)}</span>
            {d.dayBook.byMethod.map(m => <span key={String(m.paid_by)} className="chip">{String(m.paid_by)} {money(m.total)}</span>)}
          </div>
          {d.dayBook.bestSellers.length > 0 && <div className="mt-2" style={{ color: 'var(--muted)' }}>{tr('com.bestSellers')}: {d.dayBook.bestSellers.map(b => `${b.name} (${Number(b.qty)})`).join(', ')}</div>}
        </div>}
        <DataTable locale={d.locale} rows={d.sales} columns={[
          { key: 'sale_no', label: tr('com.saleNo'), className: 'num' },
          { key: 'created_at', label: tr('common.date'), render: r => formatDate(String(r.created_at), d.locale) },
          { key: 'outlet_name', label: tr('com.outlet') },
          { key: 'first_name', label: tr('common.name'), render: r => r.first_name ? `${r.first_name} ${r.last_name ?? ''}` : '—' },
          { key: 'paid_by', label: tr('fee.method'), render: r => <Chip status="active">{String(r.paid_by)}</Chip> },
          { key: 'total', label: tr('fee.amount'), className: 'num money', render: r => money(r.total) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'completed' ? 'active' : 'failed'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => String(r.status) === 'completed' ? <Button size="sm" variant="secondary" onClick={() => { const why = prompt(tr('com.refundWhy')); if (why) run(() => api(`/api/commerce/sales/${r.id}/refund`, { method: 'POST', json: { reason: why } })); }}>{tr('com.refund')}</Button> : null },
        ]} />
        <h2 className="mt-6 text-base">{tr('com.orders')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.orders} searchable={false} columns={[
          { key: 'order_no', label: tr('com.orderNo'), className: 'num' },
          { key: 'items', label: tr('com.items'), render: r => ((r.items as unknown as { name: string; quantity: number }[] | null) ?? []).map(i => `${i.name} ×${i.quantity}`).join(', ') },
          { key: 'total', label: tr('fee.amount'), className: 'num money', render: r => money(r.total) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'delivered' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => ['paid', 'ready'].includes(String(r.status)) ? <Button size="sm" onClick={() => run(() => api(`/api/commerce/orders/${r.id}/status`, { method: 'POST', json: { status: String(r.status) === 'paid' ? 'ready' : 'delivered' } }))}>{String(r.status) === 'paid' ? tr('com.markReady') : tr('com.markDelivered')}</Button> : null },
        ]} /></div>
      </div>}

      {tab === 'giving' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('fund')}>{tr('com.newFund')}</Button>
          <Button size="sm" variant="secondary" onClick={() => setDrawer('campaign')}>{tr('com.newCampaign')}</Button>
          <Button size="sm" variant="secondary" onClick={() => setDrawer('award')}>{tr('com.newAward')}</Button>
          <Button size="sm" onClick={() => setDrawer('donation')}>{tr('com.newDonation')}</Button>
        </div>
        <DataTable locale={d.locale} rows={d.funds} searchable={false} columns={[
          { key: 'name', label: tr('com.fund') },
          { key: 'kind', label: tr('common.type'), render: r => <Chip status="active">{String(r.kind)}</Chip> },
          { key: 'balance', label: tr('com.balance'), className: 'num money', render: r => money(r.balance) },
          { key: 'awards', label: tr('com.awards'), className: 'num' },
        ]} />
        <h2 className="mt-6 text-base">{tr('com.awards')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.awards} columns={[
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
          { key: 'fund_name', label: tr('com.fund') },
          { key: 'amount', label: tr('fee.amount'), className: 'num money', render: r => money(r.amount) },
          { key: 'frequency', label: 'Frequency' },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'active' ? 'active' : String(r.status) === 'proposed' ? 'pending' : 'done'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => String(r.status) === 'proposed'
            ? <div className="flex gap-1"><Button size="sm" onClick={() => run(() => api(`/api/giving/awards/${r.id}/decide`, { method: 'POST', json: { decision: 'approved' } }))}>{tr('lv.approve')}</Button><Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/giving/awards/${r.id}/decide`, { method: 'POST', json: { decision: 'rejected' } }))}>{tr('lv.reject')}</Button></div>
            : String(r.status) === 'active' ? <Button size="sm" variant="secondary" onClick={() => { const why = prompt(tr('com.endWhy')); if (why) run(() => api(`/api/giving/awards/${r.id}/end`, { method: 'POST', json: { reason: why } })); }}>{tr('com.endAward')}</Button> : null },
        ]} /></div>
        <h2 className="mt-6 text-base">{tr('com.campaigns')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.campaigns} searchable={false} columns={[
          { key: 'title', label: tr('common.name') },
          { key: 'goal_amount', label: tr('com.goal'), className: 'num money', render: r => money(r.goal_amount) },
          { key: 'raised_amount', label: tr('com.raised'), className: 'num money', render: r => money(r.raised_amount) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'live' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'slug', label: '', render: r => <div className="flex gap-1">
            {String(r.status) !== 'live' && <Button size="sm" onClick={() => run(() => api(`/api/giving/campaigns/${r.id}/status`, { method: 'POST', json: { status: 'live' } }))}>{tr('com.goLive')}</Button>}
            {String(r.status) === 'live' && <a className="btn btn-secondary btn-sm" href={`/api/public/site/appeals/${r.slug}`} target="_blank" rel="noreferrer">{tr('com.publicPage')}</a>}
          </div> },
        ]} /></div>
        <h2 className="mt-6 text-base">{tr('com.donations')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.donations} columns={[
          { key: 'donor_name', label: tr('com.donor') },
          { key: 'campaign_title', label: tr('com.campaign'), render: r => String(r.campaign_title ?? '—') },
          { key: 'amount', label: tr('fee.amount'), className: 'num money', render: r => money(r.amount) },
          { key: 'kind', label: tr('common.type'), render: r => <Chip status={String(r.kind) === 'received' ? 'active' : 'pending'}>{String(r.kind)}</Chip> },
          { key: 'id', label: '', render: r => String(r.kind) === 'pledge'
            ? <Button size="sm" onClick={() => run(() => api(`/api/giving/donations/${r.id}/receive`, { method: 'POST', json: { method: 'cash' } }))}>{tr('com.markReceived')}</Button>
            : r.receipt_doc_id ? <Button size="sm" variant="secondary" onClick={async () => { const doc = await api<{ file_id: string }>(`/api/documents/issued/${r.receipt_doc_id}`).catch(() => null); if (doc?.file_id) { const u = await api<{ url: string }>(`/api/files/${doc.file_id}/url`); window.open(u.url, '_blank'); } }}>{tr('fee.receipt')}</Button> : null },
        ]} /></div>
      </div>}

      {tab === 'alumni' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('job')}>{tr('com.postJob')}</Button>
        </div>
        <DataTable locale={d.locale} rows={d.alumni} columns={[
          { key: 'full_name', label: tr('common.name') },
          { key: 'graduation_year', label: tr('com.batch'), className: 'num' },
          { key: 'current_organisation', label: tr('com.organisation'), render: r => String(r.current_organisation ?? '—') },
          { key: 'city', label: tr('com.city'), render: r => String(r.city ?? '—') },
          { key: 'is_mentor', label: tr('com.mentor'), render: r => Number(r.is_mentor) ? <Chip status="active">{tr('common.yes')}</Chip> : '—' },
          { key: 'is_public', label: tr('com.listed'), render: r => Number(r.is_public) ? tr('common.yes') : tr('common.no') },
        ]} />
        <h2 className="mt-6 text-base">{tr('com.mentorships')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.mentorships} searchable={false} columns={[
          { key: 'mentor_name', label: tr('com.mentor') },
          { key: 'first_name', label: tr('nav.students'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
          { key: 'topic', label: tr('com.topic'), render: r => String(r.topic ?? '—') },
          { key: 'started_on', label: tr('common.date'), render: r => formatDate(String(r.started_on), d.locale) },
          { key: 'id', label: '', render: r => <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/alumni/mentorships/${r.id}/end`, { method: 'POST', json: {} }))}>{tr('com.endPair')}</Button> },
        ]} /></div>
        <h2 className="mt-6 text-base">{tr('com.jobs')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.jobs} searchable={false} columns={[
          { key: 'title', label: tr('common.name') },
          { key: 'company', label: tr('com.organisation') },
          { key: 'location', label: tr('com.city') },
          { key: 'posted_by', label: tr('com.postedBy'), render: r => String(r.posted_by ?? tr('com.school')) },
          { key: 'id', label: '', render: r => <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/alumni/jobs/${r.id}/close`, { method: 'POST', json: {} }))}>{tr('com.closePost')}</Button> },
        ]} /></div>
      </div>}

      {tab === 'cocurricular' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setDrawer('competition')}>{tr('com.newCompetition')}</Button></div>
        <DataTable locale={d.locale} rows={d.competitions} columns={[
          { key: 'name', label: tr('common.name') },
          { key: 'kind', label: tr('common.type'), render: r => <Chip status="active">{String(r.kind)}</Chip> },
          { key: 'level', label: tr('com.level') },
          { key: 'held_on', label: tr('common.date'), render: r => r.held_on ? formatDate(String(r.held_on), d.locale) : '—' },
          { key: 'entries', label: tr('com.entries'), className: 'num' },
        ]} />
      </div>}

      <Drawer open={drawer === 'topup'} onClose={() => setDrawer(null)} title={tr('com.topup')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { const r = await api<{ balanceAfter: number }>(`/api/commerce/wallets/${f.studentId}/topup`, { method: 'POST', json: { amount: Number(f.amount), method: f.method } }); setMsg(`${tr('com.balance')}: ${money(r.balanceAfter)}`); }); }}>
          <Field label={tr('nav.students')}><Select name="studentId" required placeholder="—" options={studentOptions} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('fee.amount')}><Input name="amount" type="number" step="0.01" min="1" required className="num" /></Field><Field label={tr('fee.method')}><Select name="method" options={[{ value: 'cash', label: 'Cash' }, { value: 'bkash', label: 'bKash' }, { value: 'nagad', label: 'Nagad' }, { value: 'bank_transfer', label: 'Bank' }]} /></Field></div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('com.topupNote')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'outlet'} onClose={() => setDrawer(null)} title={tr('com.newOutlet')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/commerce/outlets', { method: 'POST', json: { name: f.name, kind: f.kind } })); }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field>
          <Field label={tr('common.type')}><Select name="kind" options={['canteen', 'bookshop', 'uniform', 'stationery', 'other'].map(k => ({ value: k, label: k }))} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'product'} onClose={() => setDrawer(null)} title={tr('com.newProduct')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/commerce/products', { method: 'POST', json: { outletId: f.outletId, name: f.name, price: Number(f.price), category: f.category || null } })); }}>
          <Field label={tr('com.outlet')}><Select name="outletId" required placeholder="—" options={d.outlets.map(o => ({ value: String(o.id), label: String(o.name) }))} /></Field>
          <Field label={tr('common.name')}><Input name="name" required /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('com.price')}><Input name="price" type="number" step="0.01" min="0" required className="num" /></Field><Field label={tr('com.category')}><Input name="category" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'sale'} onClose={() => setDrawer(null)} title={tr('com.sell')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { const r = await api<{ saleNo: string; total: number }>('/api/commerce/sales', { method: 'POST', json: { outletId: f.outletId, studentId: f.studentId || null, paidBy: f.paidBy, lines: [{ productId: f.productId, quantity: Number(f.quantity) || 1 }] } }); setMsg(`${r.saleNo} · ${money(r.total)}`); }); }}>
          <Field label={tr('com.outlet')}><Select name="outletId" required placeholder="—" options={d.outlets.map(o => ({ value: String(o.id), label: String(o.name) }))} /></Field>
          <Field label={tr('com.product')}><Select name="productId" required placeholder="—" options={d.products.map(p => ({ value: String(p.id), label: `${p.name} · ${Number(p.price)}` }))} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('com.quantity')}><Input name="quantity" type="number" min="1" defaultValue={1} className="num" /></Field><Field label={tr('fee.method')}><Select name="paidBy" options={[{ value: 'wallet', label: 'Wallet' }, { value: 'cash', label: 'Cash' }, { value: 'bkash', label: 'bKash' }, { value: 'invoice', label: 'On the fee bill' }]} /></Field></div>
          <Field label={tr('nav.students')}><Select name="studentId" placeholder="—" options={studentOptions} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'fund'} onClose={() => setDrawer(null)} title={tr('com.newFund')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/giving/funds', { method: 'POST', json: { name: f.name, kind: f.kind, opening: Number(f.opening) || 0 } })); }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.type')}><Select name="kind" options={['internal', 'donor', 'zakat', 'alumni', 'government_stipend'].map(k => ({ value: k, label: k.replace('_', ' ') }))} /></Field><Field label={tr('com.opening')}><Input name="opening" type="number" step="0.01" min="0" className="num" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'award'} onClose={() => setDrawer(null)} title={tr('com.newAward')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/giving/awards', { method: 'POST', json: { fundId: f.fundId, studentId: f.studentId, amount: Number(f.amount), frequency: f.frequency, needBased: f.needBased === 'on' } })); }}>
          <Field label={tr('com.fund')}><Select name="fundId" required placeholder="—" options={d.funds.map(f2 => ({ value: String(f2.id), label: `${f2.name} · ${Number(f2.balance)}` }))} /></Field>
          <Field label={tr('nav.students')}><Select name="studentId" required placeholder="—" options={studentOptions} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('fee.amount')}><Input name="amount" type="number" step="0.01" min="1" required className="num" /></Field><Field label="Frequency"><Select name="frequency" options={[{ value: 'yearly', label: 'Yearly' }, { value: 'monthly', label: 'Monthly' }, { value: 'one_time', label: 'One time' }]} /></Field></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="needBased" /> {tr('com.needBased')}</label>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('com.awardNote')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'campaign'} onClose={() => setDrawer(null)} title={tr('com.newCampaign')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/giving/campaigns', { method: 'POST', json: { title: f.title, goalAmount: Number(f.goalAmount), description: f.description || null } })); }}>
          <Field label={tr('common.name')}><Input name="title" required /></Field>
          <Field label={tr('com.goal')}><Input name="goalAmount" type="number" step="0.01" min="1" required className="num" /></Field>
          <Field label={tr('common.description')}><textarea name="description" className="input" rows={4} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'donation'} onClose={() => setDrawer(null)} title={tr('com.newDonation')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => {
          const donorId = f.donorId || (await api<{ id: string }>('/api/giving/donors', { method: 'POST', json: { name: f.donorName, phone: f.donorPhone || null, isAnonymous: f.anonymous === 'on' } })).id;
          await api('/api/giving/donations', { method: 'POST', json: { donorId, amount: Number(f.amount), campaignId: f.campaignId || null, fundId: f.fundId || null, kind: f.kind, method: f.method } });
        }); }}>
          <Field label={tr('com.donor')}><Select name="donorId" placeholder={tr('com.newDonor')} options={d.donors.map(o => ({ value: String(o.id), label: String(o.name) }))} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('com.donorName')}><Input name="donorName" /></Field><Field label={tr('common.phone')}><Input name="donorPhone" /></Field></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="anonymous" /> {tr('com.anonymous')}</label>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('fee.amount')}><Input name="amount" type="number" step="0.01" min="1" required className="num" /></Field><Field label={tr('common.type')}><Select name="kind" options={[{ value: 'received', label: 'Received' }, { value: 'pledge', label: 'Pledge' }]} /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('com.campaign')}><Select name="campaignId" placeholder="—" options={d.campaigns.map(c => ({ value: String(c.id), label: String(c.title) }))} /></Field><Field label={tr('com.fund')}><Select name="fundId" placeholder="—" options={d.funds.map(f2 => ({ value: String(f2.id), label: String(f2.name) }))} /></Field></div>
          <Field label={tr('fee.method')}><Select name="method" options={['cash', 'bkash', 'bank_transfer', 'cheque'].map(m => ({ value: m, label: m }))} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'job'} onClose={() => setDrawer(null)} title={tr('com.postJob')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/alumni/jobs', { method: 'POST', json: { title: f.title, company: f.company || null, location: f.location || null, applyUrl: f.applyUrl || null, expiresAt: f.expiresAt || null } })); }}>
          <Field label={tr('common.name')}><Input name="title" required /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('com.organisation')}><Input name="company" /></Field><Field label={tr('com.city')}><Input name="location" /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('com.applyUrl')}><Input name="applyUrl" /></Field><Field label={tr('com.expires')}><Input name="expiresAt" type="date" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'competition'} onClose={() => setDrawer(null)} title={tr('com.newCompetition')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/engagement/competitions', { method: 'POST', json: { name: f.name, kind: f.kind, level: f.level, heldOn: f.heldOn || null, venue: f.venue || null } })); }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.type')}><Select name="kind" options={['sports', 'academic', 'cultural', 'science', 'debate', 'olympiad', 'other'].map(k => ({ value: k, label: k }))} /></Field><Field label={tr('com.level')}><Select name="level" options={['intra', 'inter_school', 'district', 'national', 'international'].map(k => ({ value: k, label: k.replace('_', ' ') }))} /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.date')}><Input name="heldOn" type="date" /></Field><Field label={tr('com.venue')}><Input name="venue" /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
