import { useEffect, useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/students';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Select, Tabs, api, formatDate, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';
import { useTenantPath } from '~/tenant';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const sid = user.school_id; const url = new URL(request.url);
  const year = await context.app.academic.currentYear(sid);
  const yid = year ? String(year.id) : undefined;
  const page = Number(url.searchParams.get('page') ?? 0);
  const f = { yearId: yid, classId: url.searchParams.get('classId') ?? undefined, sectionId: url.searchParams.get('sectionId') ?? undefined, q: url.searchParams.get('q') ?? undefined, limit: 50, offset: page * 50 };
  // the guardian directory pages on its own search param, so switching tabs does not reset the roll
  const gPage = Number(url.searchParams.get('gpage') ?? 0);
  const [list, classes, sections, guardians] = await Promise.all([
    context.app.people.students(sid, f), context.app.academic.classes(sid), yid ? context.app.academic.sections(sid, yid) : [],
    context.app.people.guardians(sid, { q: url.searchParams.get('gq') ?? undefined, limit: 50, offset: gPage * 50 }),
  ]);
  return { locale: (user.locale as Locale) || context.locale, list, classes, sections, page, filters: f, hasYear: !!year, guardians, gPage };
}
export function meta() { return [{ title: 'Pathshala — Students' }]; }

type StudentRow = { id: string; admission_no: string; first_name: string; last_name: string | null; name_bn: string | null; gender: string; class_name: string | null; section_name: string | null; current_roll_no: string | null; guardian_phone: string | null; status: string; current_class_id: string | null };
type GuardianChild = { id: string; first_name: string; last_name: string | null; admission_no: string; class_name: string | null; section_name: string | null; relation: string };
type GuardianRow = { id: string; full_name: string; phone: string; alt_phone: string | null; email: string | null; occupation: string | null; children: number; hasAccount: boolean; lastLoginAt: string | null; is_active: unknown; childRows: GuardianChild[] };

export default function Students() {
  const d = useLoaderData<typeof loader>(); const tp = useTenantPath();
  const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [open, setOpen] = useState(false); const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [classId, setClassId] = useState('');
  const [tab, setTab] = useState<'roll' | 'guardians'>('roll');
  useEffect(() => { setClassId(d.filters.classId ?? ''); }, [d.filters.classId]);
  const nameOf = (r: StudentRow) => d.locale === 'bn' && r.name_bn ? r.name_bn : `${r.first_name} ${r.last_name ?? ''}`.trim();
  const openProfile = async (id: string) => { try { setProfile(await api(`/api/people/students/${id}`)); } catch (e) { setErr((e as Error).message); } };
  const create = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
    const guardians = f.guardianPhone ? [{ fullName: f.guardianName, phone: f.guardianPhone, relation: f.relation || 'father', isPrimary: true }] : [];
    try { await api('/api/people/students', { method: 'POST', json: { firstName: f.firstName, lastName: f.lastName, nameBn: f.nameBn, gender: f.gender, dateOfBirth: f.dateOfBirth, classId: f.classId, sectionId: f.sectionId || null, rollNo: f.rollNo || null, admissionNo: f.admissionNo || null, guardians } }); setOpen(false); rv.revalidate(); } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  const p = profile as { first_name?: string; last_name?: string; name_bn?: string; admission_no?: string; gender?: string; date_of_birth?: string; status?: string; guardians?: { id: string; full_name: string; phone: string; relation: string; user_id: string | null }[]; enrollments?: { year_name: string; class_name: string; section_name: string | null; roll_no: string | null; status: string }[]; siblings?: { id: string; first_name: string; last_name: string | null; admission_no: string }[] } | null;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('stu.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{formatNumber(d.list.total, d.locale)} {tr('stu.title').toLowerCase()}</p></div>
        <div className="flex items-center gap-2"><a className="btn btn-secondary btn-sm" href={tp('/import')}>{tr('nav.import')}</a><Button size="sm" onClick={() => setOpen(true)} disabled={!d.hasYear}>{tr('stu.new')}</Button></div>
      </div>
      {!d.hasYear && <div className="mt-4"><Banner kind="warn">{tr('acad.newYear')} → <a href={tp('/academic')}>{tr('nav.academic')}</a></Banner></div>}
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}

      <div className="mt-4"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'roll', label: tr('stu.roll_'), count: d.list.total },
        { key: 'guardians', label: tr('stu.guardians'), count: d.guardians.total },
      ]} /></div>

      {tab === 'guardians' && <div className="mt-4">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('stu.guardiansNote')}</p>
        <form className="mt-3 flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); const next = new URLSearchParams(sp); next.set('gq', String(f.get('gq') ?? '')); next.set('gpage', '0'); setSp(next); }}>
          <Input name="gq" placeholder={tr('stu.guardianSearch')} defaultValue={sp.get('gq') ?? ''} className="max-w-xs" />
          <Button variant="secondary" size="sm">{tr('common.search')}</Button>
        </form>
        <div className="mt-3"><DataTable<GuardianRow> locale={d.locale} searchable={false} rows={d.guardians.rows as GuardianRow[]} total={d.guardians.total} page={d.gPage} pageSize={50} onPage={pg => { const next = new URLSearchParams(sp); next.set('gpage', String(pg)); setSp(next); }}
          columns={[
            { key: 'full_name', label: tr('common.name') },
            { key: 'phone', label: tr('common.phone'), className: 'num' },
            { key: 'occupation', label: tr('stu.occupation'), render: r => r.occupation || '—' },
            { key: 'children', label: tr('stu.children'), className: 'num' },
            { key: 'childRows', label: tr('stu.theirChildren'), render: r => r.childRows.length
              ? <span className="flex flex-wrap gap-1">{r.childRows.map(c => <button key={c.id} type="button" className="chip" onClick={() => openProfile(c.id)}>{`${c.first_name} ${c.last_name ?? ''}`.trim()} · {c.class_name ?? ''} {c.section_name ?? ''}</button>)}</span>
              : '—' },
            { key: 'hasAccount', label: tr('stu.portalAccount'), render: r => r.hasAccount
              ? <Chip status="active">{tr('stu.hasAccount')}</Chip>
              : <Button size="sm" variant="secondary" disabled={busy} onClick={async () => { setBusy(true); setErr(null); try { await api(`/api/people/guardians/${r.id}/account`, { method: 'POST', json: {} }); rv.revalidate(); } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); } }}>{tr('stu.giveAccess')}</Button> },
            { key: 'lastLoginAt', label: tr('stu.lastSignIn'), render: r => !r.hasAccount ? '—' : r.lastLoginAt ? String(r.lastLoginAt).slice(0, 16) : <Chip status="pending">{tr('stu.neverSignedIn')}</Chip> },
          ]} /></div>
      </div>}

      {tab === 'roll' && <>
      <form className="mt-4 flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); const next = new URLSearchParams(); for (const [k, v] of f.entries()) if (v) next.set(k, String(v)); setSp(next); }}>
        <Input name="q" placeholder={tr('common.search')} defaultValue={d.filters.q ?? ''} className="max-w-xs" />
        <Select name="classId" value={classId} onChange={e => setClassId(e.target.value)} placeholder={tr('common.class')} options={d.classes.map(c => ({ value: String(c.id), label: String(d.locale === 'bn' && c.name_bn ? c.name_bn : c.name) }))} className="max-w-[180px]" />
        <Select name="sectionId" defaultValue={d.filters.sectionId ?? ''} placeholder={tr('common.section')} options={d.sections.filter(s => !classId || s.class_id === classId).map(s => ({ value: String(s.id), label: `${s.class_name} ${s.name}` }))} className="max-w-[180px]" />
        <Button variant="secondary" size="sm">{tr('common.search')}</Button>
      </form>
      <div className="mt-4">
        <DataTable<StudentRow> locale={d.locale} searchable={false} rows={d.list.rows as StudentRow[]} total={d.list.total} page={d.page} pageSize={50} onPage={pg => { const next = new URLSearchParams(sp); next.set('page', String(pg)); setSp(next); }} onRowClick={r => openProfile(r.id)}
          columns={[{ key: 'admission_no', label: tr('stu.admissionNo'), className: 'num' }, { key: 'first_name', label: tr('common.name'), render: r => nameOf(r) }, { key: 'class_name', label: tr('common.class'), render: r => `${r.class_name ?? ''} ${r.section_name ?? ''}` }, { key: 'current_roll_no', label: tr('stu.roll'), className: 'num' }, { key: 'gender', label: tr('stu.gender') }, { key: 'guardian_phone', label: tr('stu.guardianPhone'), className: 'num' }, { key: 'status', label: tr('common.status'), render: r => <Chip status={r.status} /> }]} />
      </div>
      </>}

      <Drawer open={open} onClose={() => setOpen(false)} title={tr('stu.new')}>
        <form className="grid gap-3" onSubmit={create}>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('stu.firstName')}><Input name="firstName" required autoFocus /></Field><Field label={tr('stu.lastName')}><Input name="lastName" /></Field></div>
          <Field label={tr('stu.nameBn')}><Input name="nameBn" lang="bn" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('stu.gender')}><Select name="gender" required options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} /></Field><Field label={tr('stu.dob')}><Input name="dateOfBirth" type="date" required /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.class')}><Select name="classId" required placeholder="—" options={d.classes.map(c => ({ value: String(c.id), label: String(c.name) }))} onChange={e => setClassId(e.target.value)} /></Field><Field label={tr('common.section')} hint="auto by capacity when empty"><Select name="sectionId" placeholder="auto" options={d.sections.filter(s => !classId || s.class_id === classId).map(s => ({ value: String(s.id), label: `${s.class_name} ${s.name}` }))} /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('stu.admissionNo')} hint="auto when empty"><Input name="admissionNo" className="num" /></Field><Field label={tr('stu.roll')}><Input name="rollNo" className="num" /></Field></div>
          <hr style={{ borderColor: 'var(--line)' }} />
          <Field label={tr('stu.guardianName')}><Input name="guardianName" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('stu.guardianPhone')}><Input name="guardianPhone" inputMode="tel" placeholder="01XXXXXXXXX" className="num" /></Field><Field label={tr('stu.relation')}><Select name="relation" options={[{ value: 'father', label: 'Father' }, { value: 'mother', label: 'Mother' }, { value: 'legal_guardian', label: 'Legal guardian' }, { value: 'other', label: 'Other' }]} /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={!!profile} onClose={() => setProfile(null)} title={tr('stu.profile')}>
        {p && <div className="grid gap-4 text-sm">
          <div><div className="display text-lg">{d.locale === 'bn' && p.name_bn ? p.name_bn : `${p.first_name} ${p.last_name ?? ''}`}</div><div style={{ color: 'var(--muted)' }}>{tr('stu.admissionNo')} <span className="num">{p.admission_no}</span> · {p.gender} · {formatDate(p.date_of_birth, d.locale)} · <Chip status={p.status} /></div></div>
          <section><h3 className="text-sm">{tr('stu.guardian')}</h3><ul className="mt-1">{(p.guardians ?? []).map(g => <li key={g.id} className="flex items-center justify-between py-1"><span>{g.full_name} <span style={{ color: 'var(--muted)' }}>({g.relation})</span> · <span className="num">{g.phone}</span></span>{!g.user_id && <Button size="sm" variant="secondary" onClick={async () => { await api(`/api/people/guardians/${g.id}/account`, { method: 'POST', json: {} }); openProfile(String((profile as { id: string }).id)); }}>Portal access</Button>}</li>)}</ul></section>
          <section><h3 className="text-sm">{tr('acad.years')}</h3><ul className="mt-1">{(p.enrollments ?? []).map((e, i) => <li key={i} className="py-1">{e.year_name}: {e.class_name} {e.section_name ?? ''} · {tr('stu.roll')} <span className="num">{e.roll_no ?? '—'}</span> · <Chip status={e.status} /></li>)}</ul></section>
          {!!p.siblings?.length && <section><h3 className="text-sm">{tr('stu.siblings')}</h3><ul className="mt-1">{p.siblings.map(s => <li key={s.id}><button className="btn btn-ghost btn-sm px-0" onClick={() => openProfile(s.id)}>{s.first_name} {s.last_name ?? ''} · <span className="num">{s.admission_no}</span></button></li>)}</ul></section>}
        </div>}
      </Drawer>
    </div>
  );
}
