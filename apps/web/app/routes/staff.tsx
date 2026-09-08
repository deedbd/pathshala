import { useState } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/staff';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Select, Tabs, api, formatDate, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id;
  const [staff, subjects, designations, departments] = await Promise.all([
    context.app.people.staff(sid), context.app.academic.subjects(sid),
    context.app.db.findMany<{ id: string; name: string }>('designations', { school_id: sid }, { orderBy: 'level DESC' }),
    context.app.people.departmentSummary(sid),
  ]);
  const subjectMap = await context.app.people.staffSubjects(sid);
  return { locale: (user.locale as Locale) || context.locale, staff: staff.map(s => ({ ...s, subjectIds: [...(subjectMap.get(String(s.id)) ?? [])] }) as Record<string, unknown> & { subjectIds: string[] }), subjects, designations, departments };
}
export function meta() { return [{ title: 'Pathshala — Staff' }]; }

export default function Staff() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [open, setOpen] = useState(false); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'list' | 'departments'>('list');
  const [dept, setDept] = useState<null | 'new' | string>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDept(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const num = (n: number) => formatNumber(n, d.locale);
  const subjName = (id: string) => { const s = d.subjects.find(x => x.id === id); return s ? String(d.locale === 'bn' && s.name_bn ? s.name_bn : s.name) : id; };
  const create = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const fd = new FormData(e.currentTarget); const f = Object.fromEntries(fd.entries()) as Record<string, string>;
    try { await api('/api/people/staff', { method: 'POST', json: { firstName: f.firstName, lastName: f.lastName, nameBn: f.nameBn, gender: f.gender || null, phone: f.phone || null, email: f.email || null, employeeNo: f.employeeNo || null, joinDate: f.joinDate || undefined, staffCategory: f.staffCategory, designationId: f.designationId || null, subjectIds: fd.getAll('subjectIds').map(String), createAccount: f.createAccount === 'on' } }); setOpen(false); rv.revalidate(); } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl">{tr('staff.title')}</h1></div><Button size="sm" onClick={() => setOpen(true)}>{tr('staff.new')}</Button></div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[{ key: 'list', label: tr('staff.people'), count: d.staff.length }, { key: 'departments', label: tr('staff.departments'), count: d.departments.length }]} /></div>
      {tab === 'list' && <div className="mt-4"><DataTable<Record<string, unknown>> locale={d.locale} rows={d.staff as unknown as Record<string, unknown>[]} columns={[{ key: 'employee_no', label: tr('staff.employeeNo'), className: 'num' }, { key: 'first_name', label: tr('common.name'), render: r => d.locale === 'bn' && r.name_bn ? String(r.name_bn) : `${r.first_name} ${r.last_name ?? ''}` }, { key: 'designation', label: tr('staff.designation') }, { key: 'department', label: tr('common.department'), render: r => r.department ? String(r.department) : <span style={{ color: 'var(--muted)' }}>—</span> }, { key: 'staff_category', label: tr('staff.category') }, { key: 'subjectIds', label: tr('staff.subjects'), render: r => (r.subjectIds as string[]).map(subjName).join(', ') }, { key: 'phone', label: tr('common.phone'), className: 'num' }, { key: 'join_date', label: tr('staff.joinDate'), render: r => formatDate(String(r.join_date), d.locale) }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> }]} /></div>}

      {tab === 'departments' && <div className="mt-4"><DataTable locale={d.locale} searchable={false} rows={d.departments.map(x => ({ ...x, id: x.id || 'unassigned' }))}
        toolbar={<Button size="sm" onClick={() => setDept('new')}>{tr('staff.newDepartment')}</Button>}
        columns={[
          { key: 'name', label: tr('common.name'), render: r => r.kind === 'unassigned' ? <span style={{ color: 'var(--muted)' }}>{tr('staff.unassigned')}</span> : String(r.name) },
          { key: 'kind', label: tr('common.type'), render: r => r.kind === 'unassigned' ? '' : <span className="chip">{String(r.kind)}</span> },
          { key: 'head', label: tr('staff.head'), render: r => r.kind === 'unassigned' ? '' : r.head ? String(r.head) : <Chip status="pending">{tr('staff.noHead')}</Chip> },
          { key: 'headcount', label: tr('staff.headcount'), className: 'num', render: r => num(Number(r.headcount)) },
          { key: 'teaching', label: tr('staff.teachingCount'), className: 'num', render: r => r.kind === 'unassigned' ? '' : num(Number(r.teaching)) },
          { key: 'on_leave', label: tr('staff.onLeaveToday'), className: 'num', render: r => r.kind === 'unassigned' ? '' : Number(r.on_leave) ? <span style={{ color: 'var(--warn)' }}>{num(Number(r.on_leave))}</span> : num(0) },
          { key: 'id', label: '', render: r => r.kind === 'unassigned' ? null : <Button size="sm" variant="secondary" onClick={() => setDept(String(r.id))}>{tr('staff.setHead')}</Button> },
        ]} /></div>}

      <Drawer open={dept === 'new'} onClose={() => setDept(null)} title={tr('staff.newDepartment')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/people/departments', { method: 'POST', json: { name: f.name, kind: f.kind } })); }}>
          <Field label={tr('common.name')}><Input name="name" required placeholder="Science" /></Field>
          <Field label={tr('common.type')}><Select name="kind" options={[{ value: 'academic', label: 'academic' }, { value: 'admin', label: 'admin' }, { value: 'support', label: 'support' }]} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={!!dept && dept !== 'new'} onClose={() => setDept(null)} title={tr('staff.setHead')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api(`/api/people/departments/${dept}/head`, { method: 'POST', json: { staffId: f.staffId || null } })); }}>
          <Field label={tr('staff.head')} hint={tr('staff.noHead')}><Select name="staffId" placeholder="—" options={d.staff.filter(s => String(s.department_id ?? '') === String(dept ?? '')).map(s => ({ value: String(s.id), label: `${s.employee_no} · ${s.first_name} ${s.last_name ?? ''}` }))} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={open} onClose={() => setOpen(false)} title={tr('staff.new')}>
        <form className="grid gap-3" onSubmit={create}>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('stu.firstName')}><Input name="firstName" required autoFocus /></Field><Field label={tr('stu.lastName')}><Input name="lastName" /></Field></div>
          <Field label={tr('stu.nameBn')}><Input name="nameBn" lang="bn" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.phone')}><Input name="phone" inputMode="tel" className="num" placeholder="01XXXXXXXXX" /></Field><Field label="Email"><Input name="email" type="email" /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('staff.category')}><Select name="staffCategory" options={[{ value: 'teaching', label: 'Teaching' }, { value: 'non_teaching', label: 'Non-teaching' }, { value: 'admin', label: 'Admin' }, { value: 'support', label: 'Support' }]} /></Field><Field label={tr('staff.designation')}><Select name="designationId" placeholder="—" options={d.designations.map(x => ({ value: x.id, label: x.name }))} /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('staff.employeeNo')} hint="auto when empty"><Input name="employeeNo" className="num" /></Field><Field label={tr('staff.joinDate')}><Input name="joinDate" type="date" /></Field></div>
          <Field label={tr('staff.subjects')}><div className="grid grid-cols-2 gap-1">{d.subjects.map(s => <label key={String(s.id)} className="flex items-center gap-2 text-sm"><input type="checkbox" name="subjectIds" value={String(s.id)} /> {subjName(String(s.id))}</label>)}</div></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="createAccount" defaultChecked /> Create login (OTP by phone)</label>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
