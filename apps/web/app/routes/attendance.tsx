import { useEffect, useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/attendance';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Select, Tabs, api, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

type Status = 'present' | 'absent' | 'late' | 'half_day' | 'excused';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
  const year = await context.app.academic.currentYear(sid);
  const sections = year ? await context.app.academic.sections(sid, String(year.id)) : [];
  const sectionId = url.searchParams.get('sectionId') ?? (sections[0] ? String(sections[0].id) : null);
  const [register, policies, devices, staffRegister, summary] = await Promise.all([
    sectionId ? context.app.attendance.register(sid, sectionId, date) : null,
    context.app.attendance.policies(sid), context.app.attendance.devices(sid),
    context.app.attendance.staffRegister(sid, date),
    context.app.attendance.summary(sid, { from: date, to: date }),
  ]);
  return { locale: (user.locale as Locale) || context.locale, date, sections, sectionId, register, policies, devices, staffRegister, summary };
}
export function meta() { return [{ title: 'Pathshala — Attendance' }]; }

export default function Attendance() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'section' | 'staff' | 'devices' | 'policies'>('section');
  const [marks, setMarks] = useState<Record<string, Status>>({});
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false);
  const [drawer, setDrawer] = useState(false); const [newKey, setNewKey] = useState<string | null>(null);
  useEffect(() => {
    const init: Record<string, Status> = {};
    for (const s of d.register?.students ?? []) if (s.status) init[String(s.student_id)] = String(s.status) as Status;
    setMarks(init); setSaved(false);
  }, [d.register]);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const students = d.register?.students ?? [];
  const set = (id: string, s: Status) => setMarks(m => ({ ...m, [id]: s }));
  const allPresent = () => { const m: Record<string, Status> = {}; for (const s of students) m[String(s.student_id)] = (s.on_leave ? 'excused' : 'present') as Status; setMarks(m); };
  const save = () => run(async () => { await api('/api/attendance/mark', { method: 'POST', json: { sectionId: d.sectionId, onDate: d.date, marks: Object.entries(marks).map(([studentId, status]) => ({ studentId, status })) } }); setSaved(true); });
  const counts = Object.values(marks).reduce<Record<string, number>>((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {});
  const label: Record<Status, string> = { present: tr('att.present'), absent: tr('att.absent'), late: tr('att.late'), half_day: tr('att.halfDay'), excused: tr('att.excused') };
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set(k, v); setSp(n); };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('att.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('att.purpose')}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={d.date} onChange={e => setParam('date', e.target.value)} className="max-w-[170px]" />
          <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/attendance/auto-absent?date=${d.date}`, { method: 'POST', json: {} }))} disabled={busy}>{tr('att.autoAbsent')}</Button>
        </div>
      </div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {saved && <div className="mt-4"><Banner kind="ok">{tr('att.saved')}</Banner></div>}
      {d.register?.holiday && <div className="mt-4"><Banner kind="warn">{tr('att.holiday')}</Banner></div>}
      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[{ key: 'section', label: tr('common.section') }, { key: 'staff', label: tr('att.staff') }, { key: 'devices', label: tr('att.devices'), count: d.devices.length }, { key: 'policies', label: tr('att.policies'), count: d.policies.length }]} /></div>

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

      {tab === 'staff' && <div className="mt-4"><DataTable locale={d.locale} rows={d.staffRegister} columns={[{ key: 'employee_no', label: tr('staff.employeeNo'), className: 'num' }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` }, { key: 'staff_category', label: tr('staff.category') }, { key: 'check_in', label: 'In', className: 'num', render: r => String(r.check_in ?? '').slice(11, 16) }, { key: 'status', label: tr('common.status'), render: r => r.status ? <Chip status={String(r.status) === 'present' ? 'active' : String(r.status)}>{String(r.status)}</Chip> : <div className="flex gap-1">{['present', 'absent'].map(s => <Button key={s} size="sm" variant="secondary" onClick={() => run(() => api('/api/attendance/staff', { method: 'POST', json: { staffId: r.staff_id, onDate: d.date, status: s } }))}>{s === 'present' ? tr('att.present') : tr('att.absent')}</Button>)}</div> }]} /></div>}

      {tab === 'devices' && <div className="mt-4">
        {newKey && <div className="mb-3"><Banner kind="warn">{tr('att.deviceKey')}: <code className="num">{newKey}</code></Banner></div>}
        <DataTable locale={d.locale} rows={d.devices} toolbar={<Button size="sm" onClick={() => setDrawer(true)}>{tr('common.new')}</Button>}
          columns={[{ key: 'name', label: tr('common.name') }, { key: 'device_type', label: 'Type' }, { key: 'location', label: 'Location' }, { key: 'direction', label: 'Direction' }, { key: 'last_seen_at', label: 'Last seen', render: r => String(r.last_seen_at ?? '—').slice(0, 16) }, { key: 'is_active', label: tr('common.status'), render: r => <Chip status={Number(r.is_active) ? 'active' : 'inactive'} /> }]} />
        <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>Devices POST to <code>/api/attendance/punch</code> with header <code>X-Device-Key</code> and a body of <code>{'{ punches: [{ identifier, punchedAt }] }'}</code>.</p>
      </div>}

      {tab === 'policies' && <div className="mt-4"><DataTable locale={d.locale} searchable={false} rows={d.policies} columns={[{ key: 'audience', label: 'Audience' }, { key: 'auto_absent_at', label: tr('att.cutoff'), className: 'num' }, { key: 'late_after_minutes', label: 'Late after (min)', className: 'num' }, { key: 'min_attendance_pct', label: tr('att.pct'), className: 'num' }, { key: 'notify_on_absent', label: 'SMS on absent', render: r => Number(r.notify_on_absent) ? '✓' : '' }]}
        toolbar={<Button size="sm" variant="secondary" onClick={() => run(() => api('/api/attendance/policies', { method: 'PUT', json: { audience: 'student', autoAbsentAt: prompt('Auto-absent time (HH:MM)', '10:30') + ':00' } }))}>{tr('att.cutoff')}</Button>} /></div>}

      <Drawer open={drawer} onClose={() => setDrawer(false)} title={tr('att.devices')}>
        <form className="grid gap-3" onSubmit={async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; setBusy(true); try { const r = await api<{ apiKey: string }>('/api/attendance/devices', { method: 'POST', json: { name: f.name, deviceType: f.deviceType, location: f.location, direction: f.direction } }); setNewKey(r.apiKey); setDrawer(false); rv.revalidate(); } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); } }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field>
          <Field label="Type"><Select name="deviceType" options={[{ value: 'biometric', label: 'Biometric (ZKTeco/Hikvision)' }, { value: 'rfid', label: 'RFID' }, { value: 'face', label: 'Face' }, { value: 'qr', label: 'QR' }, { value: 'mobile_app', label: 'Mobile app' }]} /></Field>
          <Field label="Location"><Input name="location" placeholder="Main gate" /></Field>
          <Field label="Direction"><Select name="direction" options={[{ value: 'both', label: 'Both' }, { value: 'in', label: 'In' }, { value: 'out', label: 'Out' }]} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
