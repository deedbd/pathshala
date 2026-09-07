import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/group';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, formatMoney, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const groups = await context.app.groups.groups(sid);
  const groupId = url.searchParams.get('groupId') ?? (groups.find(g => Number(g.is_head)) ?? groups[0])?.id;
  const gid = groupId ? String(groupId) : null;
  // one page of a trust's staff and of its transfers at a time: twenty schools have thousands of both
  const page = Math.max(0, Number(url.searchParams.get('page') ?? 0) || 0);
  const perPage = 100;
  const [consolidated, pool, members, transfers, rates, students, addable] = await Promise.all([
    // only the head school of a group may read the others; every other member gets its own page and a plain reason
    gid ? context.app.groups.consolidated(gid, sid).catch(() => null) : null,
    gid ? context.app.groups.staffPool(gid, sid, { limit: perPage, offset: page * perPage }).catch(() => null) : null,
    gid ? context.app.groups.memberSchools(gid).catch(() => []) : [],
    context.app.groups.transfers(sid, { limit: perPage, offset: page * perPage }),
    context.app.groups.rates({}),
    context.app.people.students(sid, { limit: 200 }),
    // only the founder school may be told which other schools exist on this installation
    gid ? context.app.groups.addableSchools(gid, sid).catch(() => []) : [],
  ]);
  return { locale: (user.locale as Locale) || context.locale, schoolId: sid, groups, groupId: gid, page, perPage, consolidated, pool, members, transfers, rates, students: students.rows, addable };
}
export function meta() { return [{ title: 'Pathshala — Group' }]; }

export default function Group() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'consolidated' | 'schools' | 'staff' | 'transfers' | 'rates'>('consolidated');
  const [drawer, setDrawer] = useState<null | 'group' | 'school' | 'transfer' | 'rate'>(null);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); setMsg(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  const num = (n: unknown) => formatNumber(Number(n ?? 0), d.locale);
  const money = (n: unknown) => formatMoney(Number(n ?? 0), d.locale);
  const name = (r: { first_name?: unknown; last_name?: unknown }) => `${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim();
  const group = d.groups.find(g => String(g.id) === d.groupId) ?? null;
  const isHead = !!(group && Number(group.is_head));
  // the loader's catch() widens these to an empty tuple, which loses the row shape
  const members = d.members as Record<string, unknown>[];
  const poolStaff = (d.pool?.staff ?? []) as Record<string, unknown>[];
  const others = members.filter(m => String(m.school_id) !== d.schoolId);
  const addable = d.addable as Record<string, unknown>[];
  const pageOf = (rows: unknown[], total?: number) => ({ from: d.page * d.perPage + (rows.length ? 1 : 0), to: d.page * d.perPage + rows.length, total: total ?? null });
  const goPage = (n: number) => setParam('page', n <= 0 ? '' : String(n));
  const total = d.consolidated?.money ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('grp.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('grp.purpose')}</p></div>
        <div className="flex flex-wrap gap-2">
          {d.groups.length > 1 && <Select value={d.groupId ?? ''} onChange={e => setParam('groupId', e.target.value)} options={d.groups.map(g => ({ value: String(g.id), label: String(g.name) }))} className="max-w-[220px]" />}
          <Button size="sm" onClick={() => setDrawer('group')}>{tr('grp.newGroup')}</Button>
        </div>
      </div>

      {d.groups.length === 0 && <div className="mt-4"><Banner kind="info">{tr('grp.noGroup')}</Banner></div>}
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}

      {group && <>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label={tr('grp.schools')} value={num(group.schools)} locale={d.locale} />
          <Kpi label={tr('grp.roll')} value={num(d.consolidated?.totals.roll ?? 0)} locale={d.locale} />
          <Kpi label={tr('grp.attendance')} value={d.consolidated?.totals.attendancePct == null ? '—' : `${num(d.consolidated.totals.attendancePct)}%`} locale={d.locale} />
          <Kpi label={tr('grp.collected')} value={total?.collected == null ? '—' : money(total.collected)} locale={d.locale} />
        </div>
        {!isHead && <div className="mt-4"><Banner kind="info">{tr('grp.notHead')}</Banner></div>}
        {total?.error && <div className="mt-4"><Banner kind="warn">{total.error}</Banner></div>}

        <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
          { key: 'consolidated', label: tr('grp.consolidated') },
          { key: 'schools', label: tr('grp.schools'), count: members.length },
          { key: 'staff', label: tr('grp.staffPool'), count: poolStaff.length },
          { key: 'transfers', label: tr('grp.transfers'), count: d.transfers.length },
          { key: 'rates', label: tr('grp.rates'), count: d.rates.length },
        ]} /></div>
      </>}

      {group && tab === 'consolidated' && <div className="mt-4">
        {!d.consolidated ? <Banner kind="info">{tr('grp.notHead')}</Banner> : <>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('grp.window')}: {formatDate(d.consolidated.from, d.locale)} – {formatDate(d.consolidated.day, d.locale)} · {tr('grp.base')} {d.consolidated.baseCurrency}</p>
          <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.consolidated.schools.map(s => ({ ...s, id: s.schoolId }))} columns={[
            { key: 'schoolName', label: tr('grp.school'), render: r => <>{r.schoolName} {r.isHead && <Chip status="active">{tr('grp.head')}</Chip>}</> },
            { key: 'roll', label: tr('grp.roll'), className: 'num', render: r => num(r.roll) },
            { key: 'staff', label: tr('nav.staff'), className: 'num', render: r => num(r.staff) },
            { key: 'attendancePct', label: tr('grp.attendance'), className: 'num', render: r => r.attendancePct == null ? '—' : `${num(r.attendancePct)}%` },
            { key: 'collected', label: tr('fee.collected'), className: 'num money', render: r => `${money(r.collected)} ${r.currency}` },
            { key: 'outstanding', label: tr('fee.outstanding'), className: 'num money', render: r => `${money(r.outstanding)} ${r.currency}` },
            { key: 'collectedBase', label: `${tr('fee.collected')} · ${d.consolidated!.baseCurrency}`, className: 'num money', render: r => r.collectedBase == null ? tr('grp.noRate') : money(r.collectedBase) },
            { key: 'rate', label: tr('grp.rate'), className: 'num', render: r => r.rate == null ? '—' : `${num(r.rate)} · ${formatDate(String(r.rateAsOf), d.locale)}` },
            { key: 'daysCovered', label: tr('grp.days'), className: 'num', render: r => num(r.daysCovered) },
          ]} /></div>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label={`${tr('fee.collected')} · ${d.consolidated.baseCurrency}`} value={total?.collected == null ? '—' : money(total.collected)} locale={d.locale} />
            <Kpi label={`${tr('fee.outstanding')} · ${d.consolidated.baseCurrency}`} value={total?.outstanding == null ? '—' : money(total.outstanding)} locale={d.locale} />
            <Kpi label={tr('grp.roll')} value={num(d.consolidated.totals.roll)} locale={d.locale} />
            <Kpi label={tr('nav.staff')} value={num(d.consolidated.totals.staff)} locale={d.locale} />
          </div>
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('grp.consolidatedNote')}</p>
          {total && total.rates.length > 0 && <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('grp.ratesUsed')}: {total.rates.map(r => `${r.from}→${r.to} ${num(r.rate)} (${formatDate(r.asOf, d.locale)})`).join(' · ')}</p>}
        </>}
      </div>}

      {group && tab === 'schools' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setDrawer('school')} disabled={!isHead || addable.length === 0}>{tr('grp.addSchool')}</Button></div>
        <DataTable locale={d.locale} searchable={false} rows={members.map(m => ({ ...m, id: m.school_id })) as Record<string, unknown>[]} columns={[
          { key: 'name', label: tr('grp.school'), render: r => <>{String(r.name)} {Number(r.is_head) ? <Chip status="active">{tr('grp.head')}</Chip> : null}</> },
          { key: 'code', label: tr('col.code'), className: 'num' },
          { key: 'currency', label: tr('grp.currency'), render: r => String(r.currency ?? '—') },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)}>{String(r.status)}</Chip> },
          { key: 'school_id', label: '', render: r => Number(r.is_head) ? null : <Button size="sm" variant="secondary" disabled={busy || !isHead} onClick={() => run(() => api(`/api/groups/${d.groupId}/schools/${r.school_id}/remove`, { method: 'POST', json: {} }))}>{tr('grp.remove')}</Button> },
        ]} />
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('grp.schoolsNote')}</p>
      </div>}

      {group && tab === 'staff' && <div className="mt-4">
        {!d.pool ? <Banner kind="info">{tr('grp.notHead')}</Banner> : <>
          <DataTable locale={d.locale} rows={poolStaff} columns={[
            { key: 'employee_no', label: tr('staff.employeeNo'), className: 'num' },
            { key: 'first_name', label: tr('common.name'), render: r => name(r) },
            { key: 'school_name', label: tr('grp.school') },
            { key: 'designation', label: tr('staff.designation'), render: r => String(r.designation ?? '—') },
            { key: 'department', label: tr('col.department'), render: r => String(r.department ?? '—') },
            { key: 'periods', label: tr('grp.periods'), className: 'num', render: r => num(r.periods) },
            { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)}>{String(r.status)}</Chip> },
          ]} />
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('grp.staffNote')}</p>
        <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          <Button size="sm" variant="secondary" disabled={d.page === 0} onClick={() => goPage(d.page - 1)}>{tr('grp.prev')}</Button>
          <span>{num(pageOf(poolStaff, d.pool.total).from)}–{num(pageOf(poolStaff, d.pool.total).to)} / {num(d.pool.total)}</span>
          <Button size="sm" variant="secondary" disabled={(d.page + 1) * d.perPage >= Number(d.pool.total)} onClick={() => goPage(d.page + 1)}>{tr('grp.next')}</Button>
        </div>
        </>}
      </div>}

      {group && tab === 'transfers' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setDrawer('transfer')} disabled={others.length === 0}>{tr('grp.newTransfer')}</Button></div>
        <DataTable locale={d.locale} rows={d.transfers} columns={[
          { key: 'admission_no', label: tr('stu.admissionNo'), className: 'num' },
          { key: 'first_name', label: tr('common.name'), render: r => name(r) },
          { key: 'from_school', label: tr('grp.from') },
          { key: 'to_school', label: tr('grp.to') },
          { key: 'dues_at_transfer', label: tr('grp.duesLeft'), className: 'num money', render: r => money(r.dues_at_transfer) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'completed' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'transferred_at', label: tr('common.date'), render: r => formatDate(String(r.transferred_at), d.locale) },
        ]} />
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('grp.transferNote')}</p>
        {(d.page > 0 || d.transfers.length === d.perPage) && <div className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          <Button size="sm" variant="secondary" disabled={d.page === 0} onClick={() => goPage(d.page - 1)}>{tr('grp.prev')}</Button>
          <span>{num(pageOf(d.transfers).from)}–{num(pageOf(d.transfers).to)}</span>
          <Button size="sm" variant="secondary" disabled={d.transfers.length < d.perPage} onClick={() => goPage(d.page + 1)}>{tr('grp.next')}</Button>
        </div>}
      </div>}

      {group && tab === 'rates' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setDrawer('rate')}>{tr('grp.newRate')}</Button></div>
        <DataTable locale={d.locale} rows={d.rates} columns={[
          { key: 'base_ccy', label: tr('grp.from') },
          { key: 'quote_ccy', label: tr('grp.to') },
          { key: 'rate', label: tr('grp.rate'), className: 'num', render: r => num(r.rate) },
          { key: 'as_of', label: tr('grp.asOf'), render: r => formatDate(String(r.as_of), d.locale) },
          { key: 'source', label: tr('grp.source'), render: r => String(r.source ?? '—') },
        ]} />
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('grp.rateNote')}</p>
      </div>}

      <Drawer open={drawer === 'group'} onClose={() => setDrawer(null)} title={tr('grp.newGroup')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { const r = await api<{ schools: number }>('/api/groups', { method: 'POST', json: { name: f.name, nameBn: f.nameBn || undefined, baseCurrency: f.baseCurrency || undefined } }); setMsg(`${num(r.schools)} ${tr('grp.schools').toLowerCase()}`); }); }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field>
          <Field label={tr('stu.nameBn')}><Input name="nameBn" /></Field>
          <Field label={tr('grp.base')} hint={tr('grp.baseHint')}><Input name="baseCurrency" defaultValue="BDT" maxLength={3} className="num" /></Field>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('grp.newGroupNote')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'school'} onClose={() => setDrawer(null)} title={tr('grp.addSchool')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api(`/api/groups/${d.groupId}/schools`, { method: 'POST', json: { schoolId: f.schoolId } })); }}>
          <Field label={tr('grp.school')} hint={tr('grp.addSchoolHint')}>
            <Select name="schoolId" required placeholder="—" options={addable.map(x => ({ value: String(x.id), label: `${x.name} · ${x.code}${x.currency && String(x.currency) !== 'BDT' ? ` · ${x.currency}` : ''}` }))} />
          </Field>
          {addable.length === 0 && <Banner kind="info">{tr('grp.nothingToAdd')}</Banner>}
          <Button disabled={busy || addable.length === 0}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'transfer'} onClose={() => setDrawer(null)} title={tr('grp.newTransfer')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { const r = await api<{ admissionNo: string; dues: number }>('/api/groups/transfers', { method: 'POST', json: { studentId: f.studentId, toSchoolId: f.toSchoolId, reason: f.reason || undefined } }); setMsg(`${r.admissionNo}${r.dues > 0 ? ` · ${tr('grp.duesLeft')} ${money(r.dues)}` : ''}`); }); }}>
          <Field label={tr('nav.students')}><Select name="studentId" required placeholder="—" options={d.students.map(s => ({ value: String(s.id), label: `${s.admission_no} · ${name(s)}` }))} /></Field>
          <Field label={tr('grp.to')}><Select name="toSchoolId" required placeholder="—" options={others.map(m => ({ value: String(m.school_id), label: String(m.name) }))} /></Field>
          <Field label={tr('grp.reason')}><Input name="reason" /></Field>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('grp.transferNote')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'rate'} onClose={() => setDrawer(null)} title={tr('grp.newRate')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/groups/rates', { method: 'POST', json: { baseCcy: f.baseCcy, quoteCcy: f.quoteCcy, rate: Number(f.rate), asOf: f.asOf || undefined, source: f.source || undefined } })); }}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('grp.from')}><Input name="baseCcy" required maxLength={3} defaultValue="USD" className="num" /></Field>
            <Field label={tr('grp.to')}><Input name="quoteCcy" required maxLength={3} defaultValue="BDT" className="num" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('grp.rate')}><Input name="rate" type="number" step="0.000001" min="0" required className="num" /></Field>
            <Field label={tr('grp.asOf')}><Input name="asOf" type="date" /></Field>
          </div>
          <Field label={tr('grp.source')} hint={tr('grp.sourceHint')}><Input name="source" /></Field>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('grp.rateNote')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
