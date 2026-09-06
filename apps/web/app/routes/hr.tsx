import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/hr';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, formatMoney, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const runs = await context.app.hr.runs(sid);
  const runId = url.searchParams.get('runId') ?? (runs[0] ? String(runs[0].id) : null);
  const [detail, staff, components, loans, postings, applicants, exits] = await Promise.all([
    runId ? context.app.hr.run(sid, runId).catch(() => null) : null,
    context.app.db.query(`SELECT s.id, s.employee_no, s.first_name, s.last_name, s.staff_category, s.status, ss.basic, ss.mpo_portion FROM staff s LEFT JOIN salary_structures ss ON ss.staff_id = s.id AND (ss.effective_to IS NULL OR ss.effective_to >= ?) WHERE s.school_id = ? AND s.status IN ('active','probation','on_leave') ORDER BY s.employee_no LIMIT 500`, [new Date().toISOString().slice(0, 10), sid]),
    context.app.hr.components(sid), context.app.hr.loans(sid), context.app.hr.postings(sid), context.app.hr.applicants(sid),
    context.app.db.query(`SELECT e.*, s.first_name, s.last_name, s.employee_no FROM staff_exits e JOIN staff s ON s.id = e.staff_id WHERE e.school_id = ? ORDER BY e.last_working_day DESC LIMIT 100`, [sid]),
  ]);
  return { locale: (user.locale as Locale) || context.locale, runs, runId, detail, staff, components, loans, postings, applicants, exits };
}
export function meta() { return [{ title: 'Pathshala — HR & payroll' }]; }

export default function Hr() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'payroll' | 'salary' | 'loans' | 'hiring' | 'exits'>('payroll');
  const [drawer, setDrawer] = useState<null | 'run' | 'structure' | 'loan' | 'posting' | 'exit'>(null);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set(k, v); setSp(n); };
  const cur = d.detail?.run;
  const money = (n: unknown) => formatMoney(Number(n ?? 0), d.locale);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('hr.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('hr.purpose')}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {d.runs.length > 0 && <Select value={d.runId ?? ''} onChange={e => setParam('runId', e.target.value)} options={d.runs.map(r => ({ value: String(r.id), label: `${String(r.period_month).slice(0, 7)} (${r.status})` }))} className="max-w-[220px]" />}
          <Button size="sm" onClick={() => setDrawer('run')}>{tr('hr.draftRun')}</Button>
        </div>
      </div>

      {cur && <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label={tr('hr.staff')} value={Number(cur.staff_count)} locale={d.locale} />
        <div className="kpi"><div className="kpi-label">{tr('hr.gross')}</div><div className="kpi-value num">{money(cur.total_gross)}</div></div>
        <div className="kpi"><div className="kpi-label">{tr('hr.deductions')}</div><div className="kpi-value num">{money(cur.total_deductions)}</div></div>
        <div className="kpi"><div className="kpi-label">{tr('hr.net')}</div><div className="kpi-value num">{money(cur.total_net)}</div></div>
        <div className="kpi"><div className="kpi-label">{tr('common.status')}</div><div className="mt-1"><Chip status={String(cur.status) === 'paid' ? 'active' : String(cur.status)}>{String(cur.status)}</Chip></div></div>
      </div>}
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}

      {cur && <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy || String(cur.status) !== 'calculated'} onClick={() => run(async () => { await api(`/api/hr/payroll/${d.runId}/approve`, { method: 'POST', json: {} }); setMsg(tr('hr.approvedMsg')); })}>{tr('hr.approve')}</Button>
        <Button size="sm" disabled={busy || String(cur.status) !== 'approved'} onClick={() => run(async () => { const r = await api<{ amount: number }>(`/api/hr/payroll/${d.runId}/pay`, { method: 'POST', json: {} }); setMsg(`${tr('hr.paid')}: ${money(r.amount)}`); })}>{tr('hr.pay')}</Button>
        {cur.bank_file_id ? <Button size="sm" variant="secondary" onClick={async () => { const u = await api<{ url: string }>(`/api/files/${cur.bank_file_id}/url`); window.open(u.url, '_blank'); }}>{tr('hr.bankFile')}</Button> : null}
      </div>}

      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'payroll', label: tr('hr.payslips'), count: d.detail?.payslips.length ?? 0 },
        { key: 'salary', label: tr('hr.structures'), count: d.staff.length },
        { key: 'loans', label: tr('hr.loans'), count: d.loans.length },
        { key: 'hiring', label: tr('hr.hiring'), count: d.applicants.length },
        { key: 'exits', label: tr('hr.exits'), count: d.exits.length },
      ]} /></div>

      {tab === 'payroll' && <div className="mt-4"><DataTable locale={d.locale} rows={d.detail?.payslips ?? []} columns={[
        { key: 'employee_no', label: tr('hr.employeeNo'), className: 'num' },
        { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
        { key: 'working_days', label: tr('hr.workingDays'), className: 'num' },
        { key: 'lop_days', label: tr('hr.lop'), className: 'num' },
        { key: 'gross', label: tr('hr.gross'), className: 'num', render: r => money(r.gross) },
        { key: 'total_deductions', label: tr('hr.deductions'), className: 'num', render: r => money(r.total_deductions) },
        { key: 'tax', label: tr('hr.tax'), className: 'num', render: r => money(r.tax) },
        { key: 'net_pay', label: tr('hr.net'), className: 'num', render: r => money(r.net_pay) },
        { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'paid' ? 'active' : String(r.status)}>{String(r.status)}</Chip> },
        { key: 'payslip_file_id', label: tr('hr.payslip'), render: r => r.payslip_file_id ? <Button size="sm" variant="secondary" onClick={async () => { const u = await api<{ url: string }>(`/api/files/${r.payslip_file_id}/url`); window.open(u.url, '_blank'); }}>PDF</Button> : null },
      ]} /></div>}

      {tab === 'salary' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setDrawer('structure')}>{tr('hr.setStructure')}</Button></div>
        <DataTable locale={d.locale} rows={d.staff} columns={[
          { key: 'employee_no', label: tr('hr.employeeNo'), className: 'num' },
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
          { key: 'staff_category', label: tr('hr.category') },
          { key: 'basic', label: tr('hr.basic'), className: 'num', render: r => r.basic == null ? <Chip status="pending">{tr('hr.noStructure')}</Chip> : money(r.basic) },
          { key: 'mpo_portion', label: tr('hr.mpo'), className: 'num', render: r => money(r.mpo_portion) },
        ]} />
      </div>}

      {tab === 'loans' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setDrawer('loan')}>{tr('hr.newLoan')}</Button></div>
        <DataTable locale={d.locale} rows={d.loans} columns={[
          { key: 'staff_id', label: tr('hr.staff') },
          { key: 'loan_type', label: tr('common.type') },
          { key: 'principal', label: tr('hr.principal'), className: 'num', render: r => money(r.principal) },
          { key: 'monthly_deduction', label: tr('hr.instalment'), className: 'num', render: r => money(r.monthly_deduction) },
          { key: 'balance', label: tr('hr.balance'), className: 'num', render: r => money(r.balance) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'active' ? 'active' : String(r.status)}>{String(r.status)}</Chip> },
        ]} />
      </div>}

      {tab === 'hiring' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" onClick={() => setDrawer('posting')}>{tr('hr.newPosting')}</Button></div>
        <DataTable locale={d.locale} rows={d.postings} columns={[
          { key: 'title', label: tr('common.name') },
          { key: 'vacancies', label: tr('hr.vacancies'), className: 'num' },
          { key: 'closes_at', label: tr('hr.closes'), render: r => r.closes_at ? formatDate(String(r.closes_at), d.locale) : '—' },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'open' ? 'active' : String(r.status)}>{String(r.status)}</Chip> },
        ]} />
        <h2 className="mt-6 text-lg">{tr('hr.applicants')}</h2>
        <DataTable locale={d.locale} rows={d.applicants} columns={[
          { key: 'full_name', label: tr('common.name') },
          { key: 'phone', label: tr('common.phone'), className: 'num' },
          { key: 'stage', label: tr('hr.stage'), render: r => <Chip status={String(r.stage) === 'hired' ? 'active' : String(r.stage) === 'rejected' ? 'failed' : 'pending'}>{String(r.stage)}</Chip> },
          { key: 'id', label: '', render: r => String(r.stage) === 'hired' ? null : <Button size="sm" variant="secondary" onClick={() => run(async () => { await api(`/api/hr/applicants/${r.id}/stage`, { method: 'POST', json: { stage: nextStage(String(r.stage)) } }); setMsg(tr('hr.stageMoved')); })}>{tr('hr.advance')}</Button> },
        ]} />
      </div>}

      {tab === 'exits' && <div className="mt-4">
        <div className="mb-3 flex justify-end"><Button size="sm" variant="secondary" onClick={() => setDrawer('exit')}>{tr('hr.newExit')}</Button></div>
        <DataTable locale={d.locale} rows={d.exits} columns={[
          { key: 'employee_no', label: tr('hr.employeeNo'), className: 'num' },
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
          { key: 'exit_type', label: tr('common.type') },
          { key: 'last_working_day', label: tr('hr.lastDay'), render: r => formatDate(String(r.last_working_day), d.locale) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'settled' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => String(r.status) === 'settled' ? null : <Button size="sm" onClick={() => run(async () => { const s = await api<{ net: number }>(`/api/hr/exits/${r.id}/settle`, { method: 'POST', json: {} }); setMsg(`${tr('hr.settled')}: ${money(s.net)}`); })}>{tr('hr.settle')}</Button> },
        ]} />
      </div>}

      <Drawer open={drawer === 'run'} onClose={() => setDrawer(null)} title={tr('hr.draftRun')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { await api('/api/hr/payroll', { method: 'POST', json: { periodMonth: f.periodMonth } }); setMsg(tr('hr.queued')); }); }}>
          <Field label={tr('hr.month')} hint={tr('hr.monthHint')}><Input name="periodMonth" type="month" required defaultValue={new Date().toISOString().slice(0, 7)} /></Field>
          <Button disabled={busy}>{tr('hr.draftRun')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'structure'} onClose={() => setDrawer(null)} title={tr('hr.setStructure')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/hr/structures', { method: 'POST', json: { staffId: f.staffId, effectiveFrom: f.effectiveFrom, basic: Number(f.basic), mpoPortion: f.mpoPortion ? Number(f.mpoPortion) : 0, bankAccount: { bankName: f.bankName, accountNo: f.accountNo, branch: f.branch } } })); }}>
          <Field label={tr('hr.staff')}><Select name="staffId" required options={d.staff.map(s => ({ value: String(s.id), label: `${s.employee_no} · ${s.first_name} ${s.last_name ?? ''}` }))} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('hr.effectiveFrom')}><Input name="effectiveFrom" type="date" required /></Field>
            <Field label={tr('hr.basic')}><Input name="basic" type="number" className="num" required /></Field>
          </div>
          <Field label={tr('hr.mpo')} hint={tr('hr.mpoHint')}><Input name="mpoPortion" type="number" className="num" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('hr.bank')}><Input name="bankName" /></Field><Field label={tr('hr.accountNo')}><Input name="accountNo" className="num" /></Field></div>
          <Field label={tr('hr.branch')}><Input name="branch" /></Field>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{d.components.map(c => `${c.name} (${c.calc_type === 'percent_of_basic' ? `${Number(c.default_value)}%` : Number(c.default_value)})`).join(' · ')}</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'loan'} onClose={() => setDrawer(null)} title={tr('hr.newLoan')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/hr/loans', { method: 'POST', json: { staffId: f.staffId, loanType: f.loanType, principal: Number(f.principal), monthlyDeduction: Number(f.monthlyDeduction), startsFrom: f.startsFrom } })); }}>
          <Field label={tr('hr.staff')}><Select name="staffId" required options={d.staff.map(s => ({ value: String(s.id), label: `${s.employee_no} · ${s.first_name}` }))} /></Field>
          <Field label={tr('common.type')}><Select name="loanType" options={[{ value: 'loan', label: 'Loan' }, { value: 'advance', label: 'Advance' }, { value: 'pf_loan', label: 'PF loan' }]} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('hr.principal')}><Input name="principal" type="number" className="num" required /></Field><Field label={tr('hr.instalment')}><Input name="monthlyDeduction" type="number" className="num" required /></Field></div>
          <Field label={tr('hr.startsFrom')}><Input name="startsFrom" type="date" required /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'posting'} onClose={() => setDrawer(null)} title={tr('hr.newPosting')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/hr/postings', { method: 'POST', json: { title: f.title, vacancies: Number(f.vacancies || 1), salaryRange: f.salaryRange, closesAt: f.closesAt || null, description: f.description, status: 'open' } })); }}>
          <Field label={tr('common.name')}><Input name="title" required placeholder="Assistant teacher (Mathematics)" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('hr.vacancies')}><Input name="vacancies" type="number" className="num" defaultValue="1" /></Field><Field label={tr('hr.closes')}><Input name="closesAt" type="date" /></Field></div>
          <Field label={tr('hr.salaryRange')}><Input name="salaryRange" placeholder="15,000 – 22,000" /></Field>
          <Field label={tr('common.description')}><textarea name="description" className="input" rows={4} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'exit'} onClose={() => setDrawer(null)} title={tr('hr.newExit')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/hr/exits', { method: 'POST', json: { staffId: f.staffId, exitType: f.exitType, lastWorkingDay: f.lastWorkingDay, noticeDate: f.noticeDate || null } })); }}>
          <Field label={tr('hr.staff')}><Select name="staffId" required options={d.staff.map(s => ({ value: String(s.id), label: `${s.employee_no} · ${s.first_name}` }))} /></Field>
          <Field label={tr('common.type')}><Select name="exitType" options={[{ value: 'resignation', label: 'Resignation' }, { value: 'termination', label: 'Termination' }, { value: 'retirement', label: 'Retirement' }, { value: 'end_of_contract', label: 'End of contract' }]} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('hr.noticeDate')}><Input name="noticeDate" type="date" /></Field><Field label={tr('hr.lastDay')}><Input name="lastWorkingDay" type="date" required /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}

const nextStage = (s: string) => ({ applied: 'shortlisted', shortlisted: 'interview', interview: 'offered', offered: 'hired' } as Record<string, string>)[s] ?? 'hired';
