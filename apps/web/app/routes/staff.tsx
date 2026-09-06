import { useState } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/staff';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Select, api, formatDate, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id;
  const [staff, subjects, designations] = await Promise.all([context.app.people.staff(sid), context.app.academic.subjects(sid), context.app.db.findMany<{ id: string; name: string }>('designations', { school_id: sid }, { orderBy: 'level DESC' })]);
  const subjectMap = await context.app.people.staffSubjects(sid);
  return { locale: (user.locale as Locale) || context.locale, staff: staff.map(s => ({ ...s, subjectIds: [...(subjectMap.get(String(s.id)) ?? [])] })), subjects, designations };
}
export function meta() { return [{ title: 'Pathshala — Staff' }]; }

export default function Staff() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [open, setOpen] = useState(false); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
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
      <div className="mt-4"><DataTable<Record<string, unknown>> locale={d.locale} rows={d.staff as unknown as Record<string, unknown>[]} columns={[{ key: 'employee_no', label: tr('staff.employeeNo'), className: 'num' }, { key: 'first_name', label: tr('common.name'), render: r => d.locale === 'bn' && r.name_bn ? String(r.name_bn) : `${r.first_name} ${r.last_name ?? ''}` }, { key: 'designation', label: tr('staff.designation') }, { key: 'staff_category', label: tr('staff.category') }, { key: 'subjectIds', label: tr('staff.subjects'), render: r => (r.subjectIds as string[]).map(subjName).join(', ') }, { key: 'phone', label: tr('common.phone'), className: 'num' }, { key: 'join_date', label: tr('staff.joinDate'), render: r => formatDate(String(r.join_date), d.locale) }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> }]} /></div>
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
