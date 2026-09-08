import { useEffect, useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/attendance';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Select, Tabs, api, formatDate, formatDateTime, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

type Status = 'present' | 'absent' | 'late' | 'half_day' | 'excused';
type Tab = 'today' | 'section' | 'staff' | 'leave' | 'devices' | 'policies';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
  const year = await context.app.academic.currentYear(sid);
  const sections = year ? await context.app.academic.sections(sid, String(year.id)) : [];
  const sectionId = url.searchParams.get('sectionId') ?? (sections[0] ? String(sections[0].id) : null);
  const [register, policies, devices, staffRegister, today, leaves, leaveTypes, balances, classes] = await Promise.all([
    sectionId ? context.app.attendance.register(sid, sectionId, date) : null,
    context.app.attendance.policies(sid), context.app.attendance.devices(sid, date),
    context.app.attendance.staffRegister(sid, date),
    context.app.attendance.today(sid, date),
    context.app.attendance.leaves(sid),
    context.app.db.findMany<{ id: string; name: string; audience: string }>('leave_types', { school_id: sid }, { orderBy: 'audience ASC, name ASC' }),
    context.app.hr.leaveBalances(sid).catch(() => [] as Awaited<ReturnType<typeof context.app.hr.leaveBalances>>),
    context.app.academic.classes(sid),
  ]);
  const shifts = await context.app.academic.shifts(sid).catch(() => []);
  return { locale: (user.locale as Locale) || context.locale, date, sections, sectionId, register, policies, devices, staffRegister, today, leaves, leaveTypes, balances, classes, shifts };
}
export function meta() { return [{ title: 'Pathshala — Attendance' }]; }

/** A thin fill bar. `pct` is null when nothing has been marked, and then no bar is drawn at all. */
function Fill({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  return <div className="h-2 w-full min-w-[70px] overflow-hidden rounded-[999px]" style={{ background: 'var(--surface-2)' }}><div className="h-2 rounded-[999px]" style={{ width: `${Math.min(100, pct)}%`, background: pct < 88 ? 'var(--warn)' : 'var(--ok)' }} /></div>;
}

export default function Attendance() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0], vars?: Record<string, string | number>) => t(k, d.locale, vars);
  const [tab, setTab] = useState<Tab>('today');
  const [marks, setMarks] = useState<Record<string, Status>>({});
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<null | 'device' | 'leave' | 'policy'>(null); const [newKey, setNewKey] = useState<string | null>(null);
  const [staffFilter, setStaffFilter] = useState(''); const [leaveFilter, setLeaveFilter] = useState('');
  useEffect(() => {
    const init: Record<string, Status> = {};
    for (const s of d.register?.students ?? []) if (s.status) init[String(s.student_id)] = String(s.status) as Status;
    setMarks(init); setSaved(false);
  }, [d.register]);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const students = d.register?.students ?? [];
  const set = (id: string, s: Status) => setMarks(m => ({ ...m, [id]: s }));
  const allPresent = () => { const m: Record<string, Status> = {}; for (const s of students) m[String(s.student_id)] = (s.on_leave ? 'excused' : 'present') as Status; setMarks(m); };
  const save = () => run(async () => { await api('/api/attendance/mark', { method: 'POST', json: { sectionId: d.sectionId, onDate: d.date, marks: Object.entries(marks).map(([studentId, status]) => ({ studentId, status })) } }); setSaved(true); });
  const counts = Object.values(marks).reduce<Record<string, number>>((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {});
  const label: Record<Status, string> = { present: tr('att.present'), absent: tr('att.absent'), late: tr('att.late'), half_day: tr('att.halfDay'), excused: tr('att.excused') };
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set(k, v); setSp(n); };
  const num = (n: number) => formatNumber(n, d.locale);
  const tod = d.today;
  const c = (k: string) => Number(tod.counts[k] ?? 0);
  const maxCheckIn = Math.max(1, ...tod.checkIns.map(x => x.n));
  const pending = d.leaves.filter(l => String(l.status) === 'pending').length;
  const staffRows = staffFilter ? d.staffRegister.filter(r => String(r.status ?? '') === staffFilter) : d.staffRegister;
  const leaveRows = leaveFilter ? d.leaves.filter(l => String(l.status) === leaveFilter) : d.leaves;

  // What the cut-off sweep did today, in one sentence — and when it has not run, why not.
  const sweepLine = () => {
    const s = tod.sweep;
    if (!s) return null;
    if (s.lastStatus === 'failed' && !s.absent) return <Banner kind="bad">{tr('att.sweepFailed')}</Banner>;
    if (s.absent) return <Banner kind="warn">{tr('att.sweepDid', { absent: num(s.absent), at: String(s.at ?? '').slice(11, 16) || '—', notified: num(s.notified) })}</Banner>;
    if (!tod.cutoffs.length) return <Banner kind="info">{tr('att.sweepNoCutoff')}</Banner>;
    // the school's own clock decides this, not the browser's: a Dhaka register does not close on a London morning
    if (tod.beforeCutoff) return <Banner kind="info">{tr('att.sweepNotYet', { at: tod.cutoffs.join(', ') })}</Banner>;
    return <Banner kind="ok">{tr('att.sweepNothing')}</Banner>;
  };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('att.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('att.purpose')}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={d.date} onChange={e => setParam('date', e.target.value)} className="max-w-[170px]" />
          <Button size="sm" variant="secondary" onClick={() => run(async () => { const r = await api<{ absent: number; skipped?: string }>(`/api/attendance/auto-absent?date=${d.date}`, { method: 'POST', json: {} }); setMsg(r.skipped ? r.skipped : tr('att.sweepDid', { absent: num(r.absent), at: new Date().toISOString().slice(11, 16), notified: num(r.absent) })); })} disabled={busy}>{tr('att.resendAbsent')}</Button>
        </div>
      </div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}
      {saved && <div className="mt-4"><Banner kind="ok">{tr('att.saved')}</Banner></div>}
      {d.register?.holiday && <div className="mt-4"><Banner kind="warn">{tr('att.holiday')}</Banner></div>}
      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'today', label: tr('att.today') },
        { key: 'section', label: tr('att.markRegister') },
        { key: 'staff', label: tr('att.staff'), count: d.staffRegister.length },
        { key: 'leave', label: tr('att.leaveTab'), count: pending },
        { key: 'devices', label: tr('att.devices'), count: d.devices.length },
        { key: 'policies', label: tr('att.policies'), count: d.policies.length },
      ]} /></div>

      {tab === 'today' && <div className="mt-4">
        <p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('att.todayNote')}</p>
        <div className="mt-3">{sweepLine()}</div>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <div className="kpi"><div className="kpi-label">{tr('att.present')}</div><div className="kpi-value num">{num(c('present'))}</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{tr('att.markedOf', { marked: num(tod.marked), enrolled: num(tod.enrolled) })}</div></div>
          <div className="kpi"><div className="kpi-label">{tr('att.late')}</div><div className="kpi-value num">{num(c('late'))}</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{tr('att.notifyLate')}</div></div>
          <div className="kpi"><div className="kpi-label">{tr('att.absent')}</div><div className="kpi-value num">{num(c('absent'))}</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{tr('att.guardiansTold', { n: num(tod.sweep?.notified ?? 0) })}</div></div>
          <div className="kpi"><div className="kpi-label">{tr('att.onApprovedLeave')}</div><div className="kpi-value num">{num(tod.onLeave)}</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{tr('att.excused')}</div></div>
          <div className="kpi"><div className="kpi-label">{tr('att.unmarked')}</div><div className="kpi-value num">{num(tod.unmarked)}</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{tod.cutoffs.length ? `${tr('att.cutoff')} ${tod.cutoffs.join(', ')}` : tr('att.sweepNoCutoff')}</div></div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div className="card p-4">
            <h2 className="text-base">{tr('att.checkIns')}</h2>
            {tod.checkIns.length === 0
              ? <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>{tr('att.noCheckIns')}</p>
              : <div className="mt-3 flex items-end gap-1" style={{ height: 110 }}>{tod.checkIns.map(b => (
                <div key={b.at} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${b.at} · ${b.n}`}>
                  <div className="w-full rounded-t" style={{ height: `${Math.max(3, (b.n / maxCheckIn) * 90)}px`, background: 'var(--accent)' }} />
                  <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{b.at}</span>
                </div>))}</div>}
          </div>
          <div className="card p-4">
            <div className="flex items-center justify-between"><h2 className="text-base">{tr('att.deviceHealth')}</h2><button className="text-sm" style={{ color: 'var(--accent)' }} onClick={() => setTab('devices')}>{tr('att.devices')}</button></div>
            {d.devices.length === 0
              ? <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>—</p>
              : <ul className="mt-3 grid gap-2">{d.devices.map(dev => (
                <li key={String(dev.id)} className="flex items-center justify-between gap-2 text-sm">
                  <span>{String(dev.name)} <span style={{ color: 'var(--muted)' }}>· {String(dev.device_type)}</span></span>
                  <span className="flex items-center gap-2"><span className="num text-xs" style={{ color: 'var(--muted)' }}>{num(Number(dev.punches_today))} {tr('att.punchesToday').toLowerCase()}</span><Chip status={Number(dev.is_active) ? 'active' : 'inactive'}>{dev.last_seen_at ? formatDateTime(String(dev.last_seen_at), d.locale) : '—'}</Chip></span>
                </li>))}</ul>}
          </div>
        </div>

        <div className="mt-4"><DataTable locale={d.locale} pageSize={40} rows={tod.sections} onRowClick={r => { setParam('sectionId', String(r.id)); setTab('section'); }} columns={[
          { key: 'name', label: tr('common.section'), render: r => `${r.class_name} ${r.name}` },
          { key: 'class_teacher', label: tr('att.classTeacher'), render: r => r.class_teacher ?? <span style={{ color: 'var(--muted)' }}>—</span> },
          { key: 'source', label: tr('att.source'), render: r => r.source ? <span className="chip">{r.source}</span> : <span style={{ color: 'var(--muted)' }}>—</span> },
          { key: 'enrolled', label: tr('att.students'), className: 'num' },
          { key: 'present', label: tr('att.present'), className: 'num' },
          { key: 'late', label: tr('att.late'), className: 'num' },
          { key: 'absent', label: tr('att.absent'), className: 'num', render: r => r.absent ? <span style={{ color: 'var(--bad)' }}>{num(r.absent)}</span> : num(0) },
          {
            key: 'pct', label: tr('att.pct'), sortValue: r => r.pct ?? -1,
            render: r => r.marked === 0
              ? <Chip status="pending">{tr('att.notMarked')}</Chip>
              : <div className="flex items-center gap-2"><Fill pct={r.pct} /><span className="num text-xs">{num(r.pct ?? 0)}%</span>{r.partial && <span className="text-xs" style={{ color: 'var(--muted)' }}>{tr('att.markedOf', { marked: num(r.marked), enrolled: num(r.enrolled) })}</span>}</div>,
          },
        ]} /></div>
      </div>}

      {tab === 'section' && <div className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={d.sectionId ?? ''} onChange={e => setParam('sectionId', e.target.value)} options={d.sections.map(s => ({ value: String(s.id), label: `${s.class_name} ${s.name}` }))} className="max-w-xs" />
          <Button size="sm" variant="secondary" onClick={allPresent}>{tr('att.allPresent')}</Button>
          <div className="ml-auto flex items-center gap-2 text-xs">{(['present', 'absent', 'late', 'excused'] as Status[]).map(s => <Chip key={s} status={s === 'present' ? 'active' : s === 'absent' ? 'failed' : s === 'late' ? 'pending' : ''}>{label[s]} {formatNumber(counts[s] ?? 0, d.locale)}</Chip>)}</div>
          <Button size="sm" onClick={save} disabled={busy || !d.sectionId || d.register?.holiday}>{tr('att.save')}</Button>
        </div>
        <div className="card mt-3 overflow-x-auto">
          <table className="table"><thead><tr><th>{tr('stu.roll')}</th><th>{tr('common.name')}</th><th>{tr('common.status')}</th></tr></thead>
            <tbody>{students.map(s => { const id = String(s.student_id); const cur = marks[id]; return (
              <tr key={id}><td className="num">{String(s.current_roll_no ?? '')}</td>
                <td>{d.locale === 'bn' && s.name_bn ? String(s.name_bn) : `${s.first_name} ${s.last_name ?? ''}`}{s.on_leave ? <span className="chip chip-warn ml-2">{tr('att.onLeave')}</span> : null}</td>
                <td><div className="flex flex-wrap gap-1">{(['present', 'absent', 'late', 'half_day', 'excused'] as Status[]).map(st => (
                  <button key={st} onClick={() => set(id, st)} className="chip" style={cur === st ? { background: st === 'present' ? 'var(--ok)' : st === 'absent' ? 'var(--bad)' : st === 'late' ? 'var(--warn)' : 'var(--accent)', color: '#fff' } : undefined}>{label[st]}</button>
                ))}</div></td></tr>); })}
              {students.length === 0 && <tr><td colSpan={3} className="py-6 text-center text-sm" style={{ color: 'var(--muted)' }}>—</td></tr>}
            </tbody></table>
        </div>
      </div>}

      {tab === 'staff' && <div className="mt-4"><DataTable locale={d.locale} rows={staffRows}
        toolbar={<Select value={staffFilter} onChange={e => setStaffFilter(e.target.value)} placeholder={tr('common.all')} className="max-w-[160px]" options={['present', 'late', 'absent', 'excused'].map(s => ({ value: s, label: s }))} />}
        columns={[
          { key: 'employee_no', label: tr('staff.employeeNo'), className: 'num' },
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
          { key: 'department', label: tr('common.department'), render: r => r.department ? String(r.department) : <span style={{ color: 'var(--muted)' }}>—</span> },
          { key: 'designation', label: tr('staff.designation'), render: r => r.designation ? String(r.designation) : <span style={{ color: 'var(--muted)' }}>—</span> },
          { key: 'check_in', label: 'In', className: 'num', render: r => String(r.check_in ?? '—').slice(11, 16) || '—' },
          { key: 'lates_this_month', label: tr('att.latesThisMonth'), className: 'num', render: r => Number(r.lates_this_month) >= 3 ? <span style={{ color: 'var(--bad)' }}>{num(Number(r.lates_this_month))}</span> : num(Number(r.lates_this_month)) },
          { key: 'status', label: tr('common.status'), render: r => r.status ? <Chip status={String(r.status) === 'present' ? 'active' : String(r.status)}>{String(r.status)}</Chip> : <div className="flex gap-1">{['present', 'absent'].map(s => <Button key={s} size="sm" variant="secondary" onClick={() => run(() => api('/api/attendance/staff', { method: 'POST', json: { staffId: r.staff_id, onDate: d.date, status: s } }))}>{s === 'present' ? tr('att.present') : tr('att.absent')}</Button>)}</div> },
        ]} /></div>}

      {tab === 'leave' && <div className="mt-4">
        <p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('lv.note')}</p>
        <div className="mt-3"><DataTable locale={d.locale} rows={leaveRows}
          toolbar={<><Select value={leaveFilter} onChange={e => setLeaveFilter(e.target.value)} placeholder={tr('common.all')} className="max-w-[160px]" options={['pending', 'approved', 'rejected'].map(s => ({ value: s, label: s }))} /><Button size="sm" onClick={() => setDrawer('leave')}>{tr('lv.apply')}</Button></>}
          columns={[
            { key: 'staff_first', label: tr('lv.applicant'), render: r => r.staff_first ? `${r.staff_first} ${r.staff_last ?? ''}` : r.student_first ? `${r.student_first} ${r.student_last ?? ''}` : '—' },
            { key: 'applicant_type', label: tr('common.type'), render: r => `${r.applicant_type} · ${r.leave_type}` },
            { key: 'from_date', label: tr('lv.dates'), render: r => `${formatDate(String(r.from_date), d.locale)} – ${formatDate(String(r.to_date), d.locale)}` },
            { key: 'days', label: tr('lv.days'), className: 'num' },
            { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'approved' ? 'active' : String(r.status) === 'rejected' ? 'failed' : 'pending'}>{String(r.status)}</Chip> },
            { key: 'id', label: '', render: r => String(r.status) !== 'pending' ? null : <div className="flex gap-1">
              <Button size="sm" onClick={() => run(async () => { await api(`/api/leave/${r.id}/decide`, { method: 'POST', json: { decision: 'approved' } }); setMsg(tr('lv.decided')); })}>{tr('lv.approve')}</Button>
              <Button size="sm" variant="secondary" onClick={() => run(async () => { await api(`/api/leave/${r.id}/decide`, { method: 'POST', json: { decision: 'rejected' } }); setMsg(tr('lv.decided')); })}>{tr('lv.reject')}</Button>
            </div> },
          ]} /></div>
        <h2 className="mt-6 text-lg">{tr('lv.balances')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.balances} empty={tr('lv.noBalances')} columns={[
          { key: 'employee_no', label: tr('staff.employeeNo'), className: 'num' },
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
          { key: 'department', label: tr('common.department'), render: r => r.department ? String(r.department) : <span style={{ color: 'var(--muted)' }}>—</span> },
          { key: 'leave_type', label: tr('lv.type') },
          { key: 'allocated', label: tr('lv.allocated'), className: 'num', render: r => num(Number(r.allocated)) },
          { key: 'carried_forward', label: tr('lv.carried'), className: 'num', render: r => num(Number(r.carried_forward)) },
          { key: 'used', label: tr('lv.used'), className: 'num', render: r => num(Number(r.used)) },
          { key: 'remaining', label: tr('lv.remaining'), className: 'num', render: r => <b>{num(Number(r.remaining))}</b> },
        ]} /></div>
      </div>}

      {tab === 'devices' && <div className="mt-4">
        {newKey && <div className="mb-3"><Banner kind="warn">{tr('att.deviceKey')}: <code className="num">{newKey}</code></Banner></div>}
        <DataTable locale={d.locale} rows={d.devices} toolbar={<Button size="sm" onClick={() => setDrawer('device')}>{tr('common.new')}</Button>}
          columns={[{ key: 'name', label: tr('common.name') }, { key: 'device_type', label: tr('common.type') }, { key: 'location', label: 'Location' }, { key: 'serial_no', label: 'Serial', className: 'num', render: r => String(r.serial_no ?? '—') }, { key: 'direction', label: 'Direction' }, { key: 'punches_today', label: tr('att.punchesToday'), className: 'num', render: r => num(Number(r.punches_today)) }, { key: 'last_seen_at', label: tr('att.lastSeen'), render: r => r.last_seen_at ? formatDateTime(String(r.last_seen_at), d.locale) : <span style={{ color: 'var(--muted)' }}>—</span> }, { key: 'is_active', label: tr('common.status'), render: r => <Chip status={Number(r.is_active) ? 'active' : 'inactive'} /> }]} />
        <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>Devices POST to <code>/api/attendance/punch</code> with header <code>X-Device-Key</code> and a body of <code>{'{ punches: [{ identifier, punchedAt }] }'}</code>.</p>
      </div>}

      {tab === 'policies' && <div className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('att.policyNote')}</p>
          <Button size="sm" onClick={() => setDrawer('policy')}>{tr('common.new')}</Button>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {d.policies.map(p => <PolicyCard key={String(p.id)} p={p} locale={d.locale} classes={d.classes} shifts={d.shifts} busy={busy} onSave={body => run(async () => { await api('/api/attendance/policies', { method: 'PUT', json: body }); setMsg(tr('att.policySaved')); })} />)}
          {d.policies.length === 0 && <p className="text-sm" style={{ color: 'var(--muted)' }}>—</p>}
        </div>
      </div>}

      <Drawer open={drawer === 'device'} onClose={() => setDrawer(null)} title={tr('att.devices')}>
        <form className="grid gap-3" onSubmit={async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; setBusy(true); try { const r = await api<{ apiKey: string }>('/api/attendance/devices', { method: 'POST', json: { name: f.name, deviceType: f.deviceType, location: f.location, direction: f.direction, serialNo: f.serialNo || undefined } }); setNewKey(r.apiKey); setDrawer(null); rv.revalidate(); } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); } }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field>
          <Field label={tr('common.type')}><Select name="deviceType" options={[{ value: 'biometric', label: 'Biometric (ZKTeco/Hikvision)' }, { value: 'rfid', label: 'RFID' }, { value: 'face', label: 'Face' }, { value: 'qr', label: 'QR' }, { value: 'mobile_app', label: 'Mobile app' }]} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Location"><Input name="location" placeholder="Main gate" /></Field><Field label="Serial"><Input name="serialNo" className="num" /></Field></div>
          <Field label="Direction"><Select name="direction" options={[{ value: 'both', label: 'Both' }, { value: 'in', label: 'In' }, { value: 'out', label: 'Out' }]} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'leave'} onClose={() => setDrawer(null)} title={tr('lv.apply')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/leave', { method: 'POST', json: { applicantType: 'staff', staffId: f.staffId, leaveTypeId: f.leaveTypeId, fromDate: f.fromDate, toDate: f.toDate, reason: f.reason } })); }}>
          <Field label={tr('lv.applicant')}><Select name="staffId" required options={d.staffRegister.map(s => ({ value: String(s.staff_id), label: `${s.employee_no ?? ''} · ${s.first_name} ${s.last_name ?? ''}` }))} /></Field>
          <Field label={tr('lv.type')}><Select name="leaveTypeId" required options={d.leaveTypes.filter(x => x.audience === 'staff').map(x => ({ value: String(x.id), label: String(x.name) }))} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('lv.from')}><Input name="fromDate" type="date" required /></Field><Field label={tr('lv.to')}><Input name="toDate" type="date" required /></Field></div>
          <Field label={tr('lv.reason')}><textarea name="reason" className="input" rows={3} required minLength={3} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'policy'} onClose={() => setDrawer(null)} title={tr('att.policies')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { await api('/api/attendance/policies', { method: 'PUT', json: { audience: f.audience, classId: f.classId || null, shiftId: f.shiftId || null, autoAbsentAt: f.autoAbsentAt || null } }); setMsg(tr('att.policySaved')); }); }}>
          <Field label="Audience"><Select name="audience" options={[{ value: 'student', label: tr('att.studentPolicy') }, { value: 'staff', label: tr('att.staffPolicy') }]} /></Field>
          <Field label={tr('common.class')} hint={tr('common.all')}><Select name="classId" placeholder={tr('common.all')} options={d.classes.map(x => ({ value: String(x.id), label: String(x.name) }))} /></Field>
          <Field label="Shift" hint={tr('common.all')}><Select name="shiftId" placeholder={tr('common.all')} options={d.shifts.map(x => ({ value: String(x.id), label: String(x.name) }))} /></Field>
          <Field label={tr('att.cutoff')}><Input name="autoAbsentAt" type="time" defaultValue="10:30" /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}

/** One attendance-policy row as an editable card. Every field the automation reads is here. */
function PolicyCard({ p, locale, classes, shifts, busy, onSave }: { p: Record<string, unknown>; locale: Locale; classes: Record<string, unknown>[]; shifts: Record<string, unknown>[]; busy: boolean; onSave: (body: Record<string, unknown>) => void }) {
  const tr = (k: Parameters<typeof t>[0]) => t(k, locale);
  const staff = String(p.audience) === 'staff';
  const scope = [p.class_id ? classes.find(c => String(c.id) === String(p.class_id))?.name : null, p.shift_id ? shifts.find(s => String(s.id) === String(p.shift_id))?.name : null].filter(Boolean).join(' · ');
  return (
    <form className="card grid gap-3 p-4" onSubmit={e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
      const body: Record<string, unknown> = {
        audience: String(p.audience), classId: p.class_id ?? null, shiftId: p.shift_id ?? null,
        lateAfterMinutes: Number(f.lateAfterMinutes), halfDayAfterMinutes: Number(f.halfDayAfterMinutes),
        autoAbsentAt: f.autoAbsentAt || null,
        notifyOnArrival: f.notifyOnArrival === 'on', notifyOnAbsent: f.notifyOnAbsent === 'on', notifyOnLate: f.notifyOnLate === 'on',
        consecutiveAbsentAlert: Number(f.consecutiveAbsentAlert), minAttendancePct: Number(f.minAttendancePct),
        blockExamBelowMin: f.blockExamBelowMin === 'on',
        lateCountToLop: f.lateCountToLop ? Number(f.lateCountToLop) : null,
      };
      onSave(body);
    }}>
      <h3 className="text-base">{staff ? tr('att.staffPolicy') : tr('att.studentPolicy')}{scope ? <span className="ml-2 text-sm" style={{ color: 'var(--muted)' }}>{scope}</span> : null}</h3>
      <div className="grid grid-cols-2 gap-3">
        <Field label={tr('att.cutoff')}><Input name="autoAbsentAt" type="time" defaultValue={String(p.auto_absent_at ?? '').slice(0, 5)} /></Field>
        <Field label={tr('att.lateAfter')}><Input name="lateAfterMinutes" type="number" className="num" defaultValue={String(p.late_after_minutes ?? 15)} /></Field>
        <Field label={tr('att.halfDayAfter')}><Input name="halfDayAfterMinutes" type="number" className="num" defaultValue={String(p.half_day_after_minutes ?? 120)} /></Field>
        <Field label={tr('att.consecutive')}><Input name="consecutiveAbsentAlert" type="number" className="num" defaultValue={String(p.consecutive_absent_alert ?? 3)} /></Field>
        <Field label={tr('att.minPct')}><Input name="minAttendancePct" type="number" className="num" defaultValue={String(p.min_attendance_pct ?? 75)} /></Field>
        {staff && <Field label={tr('att.lateToLop')} hint="3"><Input name="lateCountToLop" type="number" className="num" defaultValue={p.late_count_to_lop == null ? '' : String(p.late_count_to_lop)} /></Field>}
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="notifyOnArrival" defaultChecked={Number(p.notify_on_arrival) === 1} /> {tr('att.notifyArrival')}</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="notifyOnLate" defaultChecked={Number(p.notify_on_late) === 1} /> {tr('att.notifyLate')}</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="notifyOnAbsent" defaultChecked={Number(p.notify_on_absent) === 1} /> {tr('att.notifyAbsent')}</label>
      {!staff && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="blockExamBelowMin" defaultChecked={Number(p.block_exam_below_min) === 1} /> {tr('att.blockAdmit')}</label>}
      <Button size="sm" disabled={busy}>{tr('att.savePolicy')}</Button>
    </form>
  );
}
