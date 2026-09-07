import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/owner.schools';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Select, Tabs, api, formatDate, formatMoney, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';
import { num, ownerApi, ownerLoad, requireOwnerOr404, str, type OwnerSchoolRow, type Row } from '~/owner-api';

const PER_PAGE = 25;
const TYPES = ['school', 'college', 'school_college', 'madrasa', 'kindergarten', 'coaching', 'university'];
const STATUSES = ['active', 'trial', 'past_due', 'suspended'];

export async function loader({ context, request }: Route.LoaderArgs) {
  await requireOwnerOr404(context);
  const user = requireUser(context, request);
  const url = new URL(request.url);
  const q = url.searchParams.get('q') ?? '';
  const status = url.searchParams.get('status') ?? '';
  const planId = url.searchParams.get('planId') ?? '';
  const page = Math.max(0, Number(url.searchParams.get('page') ?? 0) || 0);
  const selected = url.searchParams.get('school');
  const list = await ownerLoad(() => ownerApi(context).schools({ q: q || undefined, status: status || undefined, planId: planId || undefined, limit: PER_PAGE, offset: page * PER_PAGE }));
  // the row a click opened: server data, so it travels in the URL and is read here
  const detail = list && selected ? await ownerLoad(() => ownerApi(context).school(selected)) : null;
  // plans come from the subscription service the owner API bills through; only ever read once the
  // owner API has already answered, so a refused caller learns nothing from this page either
  const plans = list ? await context.app.saas.plans() : [];
  return { locale: (user.locale as Locale) || context.locale, denied: list === null, q, status, planId, page, rows: list?.rows ?? [], total: list?.total ?? 0, selected, detail, plans };
}
export function meta() { return [{ title: 'Pathshala — Owner schools' }]; }

interface Handover { name: string; code: string; url: string; adminEmail: string; password: string }

export default function OwnerSchools() {
  const d = useLoaderData<typeof loader>();
  const rv = useRevalidator();
  const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [drawer, setDrawer] = useState<'new' | null>(null);
  const [action, setAction] = useState<'plan' | 'suspend' | 'reactivate' | 'admin' | null>(null);
  const [created, setCreated] = useState<Handover | null>(null);
  const [admin, setAdmin] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page' && k !== 'school') n.delete('page'); setSp(n); };
  const money = (n: unknown) => formatMoney(num(n), d.locale);
  const date = (v: unknown) => (v ? formatDate(str(v), d.locale) : tr('own.never'));
  // a one-time password lives here and nowhere else: not in the loader, not in storage, not in the URL
  const copy = async (what: string, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(what); } catch { setErr(tr('own.copyFailed')); } };
  const closeNew = () => { setDrawer(null); setCreated(null); setCopied(null); setErr(null); };
  const closeSchool = () => { setParam('school', ''); setAction(null); setAdmin(null); setCopied(null); setErr(null); };

  if (d.denied) return <Banner kind="warn">{tr('own.refused')}</Banner>;

  const plans = d.plans as Row[];
  const planOptions = plans.map(p => ({ value: str(p.id), label: `${str(p.name)} · ${formatMoney(num(p.price_monthly), d.locale)}` }));
  const detail = d.detail;
  const school = (detail?.school ?? null) as Row | null;
  const sub = (detail?.subscription ?? null) as Row | null;
  const usage = (detail?.usage ?? {}) as Row;
  const counts = (detail?.counts ?? {}) as Row;
  const rawHealth = detail?.health ?? null;
  const findings: Row[] = Array.isArray(rawHealth) ? rawHealth : rawHealth ? [rawHealth] : [];
  const selectedRow = d.rows.find(r => r.id === d.selected) ?? null;
  const title = str(school?.name) || selectedRow?.name || tr('own.schools');
  const suspended = str(school?.status ?? selectedRow?.status) === 'suspended';
  const meters = [
    { key: 'students', label: tr('own.students'), used: num(usage.students), limit: sub?.student_limit == null ? null : num(sub.student_limit) },
    { key: 'sms', label: tr('own.messages'), used: num(usage.sms), limit: sub?.sms_included == null ? null : num(sub.sms_included) },
    { key: 'storage_mb', label: tr('own.storage'), used: num(usage.storage_mb), limit: sub?.storage_gb == null ? null : num(sub.storage_gb) * 1024 },
  ];

  return (
    <div>
      <div><h1 className="text-2xl">{tr('own.schools')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('own.schoolsPurpose')}</p></div>
      {err && !drawer && !d.selected && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}

      <form className="mt-4 flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); setParam('q', str(new FormData(e.currentTarget).get('q'))); }}>
        <Input name="q" defaultValue={d.q} placeholder={tr('own.searchSchools')} className="max-w-[240px]" />
        <Button size="sm" variant="secondary">{tr('common.search')}</Button>
        <Select value={d.status} onChange={e => setParam('status', e.target.value)} placeholder={tr('own.anyStatus')} options={STATUSES.map(s => ({ value: s, label: s.replace('_', ' ') }))} className="max-w-[180px]" />
        <Select value={d.planId} onChange={e => setParam('planId', e.target.value)} placeholder={tr('own.anyPlan')} options={planOptions} className="max-w-[220px]" />
        <div className="ml-auto"><Button type="button" size="sm" onClick={() => { setCreated(null); setDrawer('new'); }}>{tr('own.newSchool')}</Button></div>
      </form>

      <div className="mt-3">
        <DataTable<OwnerSchoolRow>
          locale={d.locale} searchable={false} rows={d.rows} total={d.total} page={d.page} pageSize={PER_PAGE}
          onPage={p => setParam('page', p <= 0 ? '' : String(p))}
          onRowClick={r => { setAction(null); setAdmin(null); setParam('school', r.id); }}
          columns={[
            { key: 'name', label: tr('common.name'), render: r => <div><div>{r.name}</div><div className="text-xs num" style={{ color: 'var(--muted)' }}>{r.code} · {r.institutionType.replace('_', ' + ')}</div></div> },
            { key: 'students', label: tr('own.students'), className: 'num', render: r => formatNumber(num(r.students), d.locale) },
            { key: 'staff', label: tr('own.staff'), className: 'num', render: r => formatNumber(num(r.staff), d.locale) },
            { key: 'plan', label: tr('own.plan'), render: r => <div><div>{r.plan ?? '—'}</div>{r.subscriptionStatus && <div className="text-xs" style={{ color: 'var(--muted)' }}>{r.subscriptionStatus}</div>}</div> },
            { key: 'status', label: tr('common.status'), render: r => <Chip status={r.status === 'active' ? 'active' : r.status === 'suspended' ? 'suspended' : 'pending'}>{r.status}</Chip> },
            { key: 'outstanding', label: tr('own.outstanding'), className: 'num money', render: r => money(r.outstanding) },
            { key: 'lastActivityAt', label: tr('own.lastActivity'), render: r => date(r.lastActivityAt) },
          ]}
        />
      </div>

      {/* Taking on a client: one form, and a handover shown once. */}
      <Drawer open={drawer === 'new'} onClose={closeNew} title={tr('own.newSchool')}>
        {created ? (
          <div className="grid gap-3">
            <Banner kind="ok">{tr('own.handover')}</Banner>
            <div className="card p-4">
              <div className="display text-base">{created.name}</div>
              <dl className="mt-3 grid gap-2 text-sm">
                <div className="flex justify-between gap-3"><dt style={{ color: 'var(--muted)' }}>{tr('own.code')}</dt><dd className="num">{created.code}</dd></div>
                <div className="flex justify-between gap-3"><dt style={{ color: 'var(--muted)' }}>{tr('own.signInAt')}</dt><dd className="num break-all">{created.url}</dd></div>
                <div className="flex justify-between gap-3"><dt style={{ color: 'var(--muted)' }}>{tr('own.headEmail')}</dt><dd className="num break-all">{created.adminEmail}</dd></div>
                <div className="flex justify-between gap-3"><dt style={{ color: 'var(--muted)' }}>{tr('own.password')}</dt><dd className="num">{created.password}</dd></div>
              </dl>
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" onClick={() => copy('new', `${created.name}\n${tr('own.code')}: ${created.code}\n${tr('own.signInAt')}: ${created.url}\n${tr('own.headEmail')}: ${created.adminEmail}\n${tr('own.password')}: ${created.password}`)}>{tr('own.copy')}</Button>
                {copied === 'new' && <span className="chip chip-ok">{tr('own.copied')}</span>}
              </div>
            </div>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('own.shownOnce')}</p>
            {err && <Banner kind="bad">{err}</Banner>}
            <Button variant="secondary" onClick={closeNew}>{tr('common.cancel')}</Button>
          </div>
        ) : (
          <form className="grid gap-3" onSubmit={e => {
            e.preventDefault(); const f = form(e);
            run(async () => {
              const body: Record<string, unknown> = { schoolName: f.schoolName, institutionType: f.institutionType, locale: f.locale, adminName: f.adminName, adminPhone: f.adminPhone };
              if (f.schoolNameBn) body.schoolNameBn = f.schoolNameBn;
              if (f.schoolCode) body.schoolCode = f.schoolCode;
              if (f.adminEmail) body.adminEmail = f.adminEmail;
              if (f.planId) body.planId = f.planId;
              if (f.trialDays) body.trialDays = Number(f.trialDays);
              const r = await api<{ code: string; adminEmail: string; password: string; url: string }>('/api/owner/schools', { method: 'POST', json: body });
              setCreated({ name: f.schoolName, code: r.code, url: r.url, adminEmail: r.adminEmail || f.adminEmail || '', password: r.password });
            });
          }}>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('own.newSchoolNote')}</p>
            {err && <Banner kind="bad">{err}</Banner>}
            <Field label={tr('own.schoolName')}><Input name="schoolName" required minLength={2} maxLength={160} /></Field>
            <Field label={tr('own.schoolNameBn')}><Input name="schoolNameBn" maxLength={160} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={tr('own.type')}><Select name="institutionType" defaultValue="school" options={TYPES.map(v => ({ value: v, label: v.replace('_', ' + ') }))} /></Field>
              <Field label={tr('own.language')}><Select name="locale" defaultValue="bn" options={[{ value: 'bn', label: 'বাংলা' }, { value: 'en', label: 'English' }]} /></Field>
            </div>
            <Field label={tr('own.code')} hint={tr('own.codeHint')}><Input name="schoolCode" maxLength={12} /></Field>
            <Field label={tr('own.headName')}><Input name="adminName" required minLength={2} maxLength={160} /></Field>
            <Field label={tr('own.headPhone')}><Input name="adminPhone" required inputMode="tel" placeholder="01XXXXXXXXX" /></Field>
            <Field label={tr('own.headEmail')}><Input name="adminEmail" type="email" /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={tr('own.plan')}><Select name="planId" placeholder={tr('common.none')} options={planOptions} /></Field>
              <Field label={tr('own.trialDays')}><Input name="trialDays" type="number" min={0} max={365} /></Field>
            </div>
            <Button disabled={busy}>{tr('own.create')}</Button>
          </form>
        )}
      </Drawer>

      {/* One school: what it is on, what it uses, what it owes, who runs it, what is broken. */}
      <Drawer open={!!d.selected} onClose={closeSchool} title={title}>
        {!detail ? <Banner kind="warn">{tr('own.nothingYet')}</Banner> : (
          <div className="grid gap-4">
            {err && <Banner kind="bad">{err}</Banner>}
            <div className="flex flex-wrap gap-2">
              <Chip status={suspended ? 'suspended' : 'active'}>{str(school?.status ?? selectedRow?.status) || '—'}</Chip>
              {sub && <Chip status={str(sub.status) === 'active' ? 'active' : str(sub.status) === 'past_due' ? 'failed' : 'pending'}>{str(sub.plan_name) || str(sub.status)}</Chip>}
              {Object.entries(counts).map(([k, v]) => <span key={k} className="chip">{k}: {formatNumber(num(v), d.locale)}</span>)}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => { setAdmin(null); setAction(action === 'plan' ? null : 'plan'); }}>{tr('own.changePlan')}</Button>
              {suspended
                ? <Button size="sm" variant="secondary" onClick={() => { setAdmin(null); setAction(action === 'reactivate' ? null : 'reactivate'); }}>{tr('own.reactivate')}</Button>
                : <Button size="sm" variant="danger" onClick={() => { setAdmin(null); setAction(action === 'suspend' ? null : 'suspend'); }}>{tr('own.suspend')}</Button>}
              <Button size="sm" variant="secondary" onClick={() => { setAdmin(null); setAction(action === 'admin' ? null : 'admin'); }}>{tr('own.addAdmin')}</Button>
            </div>

            {action === 'plan' && <form className="card grid gap-3 p-4" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { await api(`/api/owner/schools/${d.selected}/plan`, { method: 'POST', json: { planId: f.planId, billingCycle: f.billingCycle, ...(f.trialDays ? { trialDays: Number(f.trialDays) } : {}), ...(f.discountPct ? { discountPct: Number(f.discountPct) } : {}) } }); setAction(null); }); }}>
              <Field label={tr('own.plan')}><Select name="planId" required defaultValue={str(sub?.plan_id)} options={planOptions} placeholder={tr('own.anyPlan')} /></Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={tr('own.billingCycle')}><Select name="billingCycle" defaultValue={str(sub?.billing_cycle) || 'monthly'} options={[{ value: 'monthly', label: tr('own.monthly') }, { value: 'yearly', label: tr('own.yearly') }]} /></Field>
                <Field label={tr('own.trialDays')}><Input name="trialDays" type="number" min={0} max={365} /></Field>
                <Field label={tr('own.discount')}><Input name="discountPct" type="number" min={0} max={100} /></Field>
              </div>
              <Button size="sm" disabled={busy}>{tr('common.save')}</Button>
            </form>}

            {(action === 'suspend' || action === 'reactivate') && <form className="card grid gap-3 p-4" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { await api(`/api/owner/schools/${d.selected}/status`, { method: 'POST', json: { status: action === 'suspend' ? 'suspended' : 'active', reason: f.reason } }); setAction(null); }); }}>
              <Field label={tr('own.reason')} hint={tr('own.reasonHint')}><Input name="reason" required minLength={3} maxLength={400} /></Field>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('own.suspendNote')}</p>
              <Button size="sm" variant={action === 'suspend' ? 'danger' : 'primary'} disabled={busy}>{action === 'suspend' ? tr('own.suspend') : tr('own.reactivate')}</Button>
            </form>}

            {action === 'admin' && (admin
              ? <div className="card grid gap-2 p-4">
                <Banner kind="ok">{tr('own.adminReady')}</Banner>
                <div className="text-sm num break-all">{admin.email}</div>
                <div className="text-sm num">{tr('own.password')}: {admin.password}</div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => copy('admin', `${tr('own.signInAt')}: ${window.location.origin}/login\n${admin.email}\n${tr('own.password')}: ${admin.password}`)}>{tr('own.copy')}</Button>
                  {copied === 'admin' && <span className="chip chip-ok">{tr('own.copied')}</span>}
                </div>
                <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('own.shownOnce')}</p>
              </div>
              : <form className="card grid gap-3 p-4" onSubmit={e => { e.preventDefault(); const f = form(e); run(async () => { const r = await api<{ email: string; password: string }>(`/api/owner/schools/${d.selected}/admin`, { method: 'POST', json: { name: f.name, phone: f.phone, ...(f.email ? { email: f.email } : {}) } }); setAdmin(r); }); }}>
                <Field label={tr('common.name')}><Input name="name" required minLength={2} maxLength={160} /></Field>
                <Field label={tr('common.phone')}><Input name="phone" required inputMode="tel" placeholder="01XXXXXXXXX" /></Field>
                <Field label={tr('own.headEmail')}><Input name="email" type="email" /></Field>
                <Button size="sm" disabled={busy}>{tr('own.addAdmin')}</Button>
              </form>)}

            <SchoolTabs
              locale={d.locale} sub={sub} meters={meters} invoices={detail.invoices} admins={detail.admins} findings={findings}
              trialEnds={selectedRow?.trialEndsAt ?? null} lastBackup={selectedRow?.lastBackupAt ?? null}
            />
          </div>
        )}
      </Drawer>
    </div>
  );
}

function SchoolTabs({ locale, sub, meters, invoices, admins, findings, trialEnds, lastBackup }: {
  locale: Locale; sub: Row | null; meters: { key: string; label: string; used: number; limit: number | null }[];
  invoices: Row[]; admins: Row[]; findings: Row[]; trialEnds: string | null; lastBackup: string | null;
}) {
  const tr = (k: Parameters<typeof t>[0]) => t(k, locale);
  const [tab, setTab] = useState<'plan' | 'invoices' | 'admins' | 'health'>('plan');
  const date = (v: unknown) => (v ? formatDate(str(v), locale) : tr('own.never'));
  return (
    <div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'plan', label: tr('own.subscription') },
        { key: 'invoices', label: tr('own.invoices'), count: invoices.length },
        { key: 'admins', label: tr('own.admins'), count: admins.length },
        { key: 'health', label: tr('own.health'), count: findings.length },
      ]} />

      {tab === 'plan' && <div className="mt-3 grid gap-3">
        <div className="card p-4 text-sm">
          <div className="flex justify-between gap-3"><span style={{ color: 'var(--muted)' }}>{tr('own.plan')}</span><span>{str(sub?.plan_name) || '—'}</span></div>
          <div className="mt-1 flex justify-between gap-3"><span style={{ color: 'var(--muted)' }}>{tr('own.billingCycle')}</span><span>{str(sub?.billing_cycle) || '—'}</span></div>
          <div className="mt-1 flex justify-between gap-3"><span style={{ color: 'var(--muted)' }}>{tr('own.trialEnds')}</span><span>{date(trialEnds ?? sub?.trial_ends_at)}</span></div>
          <div className="mt-1 flex justify-between gap-3"><span style={{ color: 'var(--muted)' }}>{tr('own.lastBackup')}</span><span>{date(lastBackup)}</span></div>
        </div>
        <div className="card p-4">
          <div className="text-sm" style={{ color: 'var(--muted)' }}>{tr('own.usage')}</div>
          <div className="mt-2 grid gap-3">
            {meters.map(m => {
              const pct = m.limit ? Math.min(100, Math.round((m.used / m.limit) * 100)) : 0;
              return (
                <div key={m.key}>
                  <div className="flex justify-between text-sm"><span>{m.label}</span><span className="num">{formatNumber(m.used, locale)} / {m.limit == null ? tr('own.noLimit') : formatNumber(m.limit, locale)}</span></div>
                  {m.limit != null && <div className="mt-1 h-2 rounded-[999px]" style={{ background: 'var(--surface-2)' }}><div className="h-2 rounded-[999px]" style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--bad)' : pct >= 80 ? 'var(--warn)' : 'var(--accent)' }} /></div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>}

      {tab === 'invoices' && <div className="mt-3"><DataTable<Row> locale={locale} searchable={false} rows={invoices} columns={[
        { key: 'invoice_no', label: tr('fee.invoiceNo'), className: 'num', render: r => str(r.invoice_no) },
        { key: 'total', label: tr('own.amount'), className: 'num money', render: r => formatMoney(num(r.total), locale) },
        { key: 'due_date', label: tr('fee.due'), render: r => date(r.due_date) },
        { key: 'status', label: tr('common.status'), render: r => <Chip status={str(r.status) === 'paid' ? 'paid' : str(r.status) === 'overdue' ? 'overdue' : 'pending'}>{str(r.status)}</Chip> },
      ]} /></div>}

      {tab === 'admins' && <div className="mt-3"><DataTable<Row> locale={locale} searchable={false} rows={admins} columns={[
        { key: 'display_name', label: tr('common.name'), render: r => str(r.display_name ?? r.name) },
        { key: 'phone', label: tr('common.phone'), className: 'num', render: r => str(r.phone) },
        { key: 'email', label: tr('own.headEmail'), render: r => str(r.email) },
        { key: 'last_login_at', label: tr('own.lastActivity'), render: r => date(r.last_login_at ?? r.last_seen_at) },
      ]} /></div>}

      {tab === 'health' && <div className="mt-3">
        {findings.length === 0 ? <p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('own.allWell')}</p>
          : <div className="grid gap-2">{findings.map((f, i) => (
            <div key={i} className="card p-3 text-sm">
              <div className="flex items-center justify-between gap-2"><Chip status="failed">{str(f.kind) || tr('own.finding')}</Chip><span className="text-xs num" style={{ color: 'var(--muted)' }}>{date(f.checked_at ?? f.checkedAt)}</span></div>
              <p className="mt-1">{str(f.detail ?? f.message)}</p>
            </div>
          ))}</div>}
      </div>}
    </div>
  );
}
