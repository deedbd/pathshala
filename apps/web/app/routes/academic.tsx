import { useState } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/academic';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const a = context.app.academic; const sid = user.school_id;
  const years = await a.years(sid);
  const url = new URL(request.url);
  const year = years.find(y => y.id === url.searchParams.get('yearId')) ?? years.find(y => Number(y.is_current)) ?? years[0] ?? null;
  const yid = year ? String(year.id) : null;
  const [classes, subjects, sections, matrix, periods, rooms, staff] = await Promise.all([a.classes(sid), a.subjects(sid), yid ? a.sections(sid, yid) : [], yid ? a.classSubjects(sid, yid) : [], a.periods(sid), a.rooms(sid), context.app.people.staff(sid, { teachingOnly: true })]);
  const school = await context.app.db.findOne<{ institution_type: string }>('schools', { id: sid });
  return { locale: (user.locale as Locale) || context.locale, years, year, classes, subjects, sections, matrix, periods, rooms, staff, institutionType: school?.institution_type ?? 'school', structure: yid ? await a.structure(sid, yid) : null };
}
export function meta() { return [{ title: 'Pathshala — Academic' }]; }

type Tab = 'classes' | 'sections' | 'subjects' | 'matrix' | 'periods' | 'years';

export default function Academic() {
  const d = useLoaderData<typeof loader>();
  const rv = useRevalidator();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<Tab>('classes');
  const [drawer, setDrawer] = useState<Tab | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const yid = d.year ? String(d.year.id) : '';
  const submit = async (path: string, body: Record<string, unknown>, method = 'POST') => { setBusy(true); setErr(null); try { await api(path, { method, json: body }); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  const name = (r: { name: unknown; name_bn?: unknown }) => d.locale === 'bn' && r.name_bn ? String(r.name_bn) : String(r.name);
  const classOpts = d.classes.map(c => ({ value: String(c.id), label: name(c as never) }));

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('nav.academic')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{d.year ? `${tr('common.year')}: ${d.year.name}` : tr('acad.newYear')}</p></div>
        <div className="flex items-center gap-2">
          {d.years.length > 1 && <Select options={d.years.map(y => ({ value: String(y.id), label: String(y.name) }))} value={yid} onChange={e => { window.location.search = `?yearId=${e.target.value}`; }} />}
          <Button variant="secondary" size="sm" onClick={() => setDrawer('years')}>{tr('acad.newYear')}</Button>
        </div>
      </div>
      {d.structure && <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label={tr('acad.classes')} value={d.structure.classes} locale={d.locale} /><Kpi label={tr('acad.sections')} value={d.structure.sections} locale={d.locale} /><Kpi label={tr('acad.subjects')} value={d.structure.subjects} locale={d.locale} /><Kpi label={tr('acad.matrix')} value={d.structure.classSubjects} locale={d.locale} /><Kpi label={tr('dash.students')} value={d.structure.students} locale={d.locale} />
      </div>}
      {!d.year && <div className="mt-4"><Banner kind="warn">{tr('acad.newYear')} →</Banner></div>}
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[{ key: 'classes', label: tr('acad.classes'), count: d.classes.length }, { key: 'sections', label: tr('acad.sections'), count: d.sections.length }, { key: 'subjects', label: tr('acad.subjects'), count: d.subjects.length }, { key: 'matrix', label: tr('acad.matrix'), count: d.matrix.length }, { key: 'periods', label: tr('acad.periods'), count: d.periods.length }, { key: 'years', label: tr('acad.years'), count: d.years.length }]} /></div>

      <div className="mt-4">
        {tab === 'classes' && <DataTable locale={d.locale} rows={d.classes} columns={[{ key: 'name', label: tr('common.class'), render: r => name(r as never) }, { key: 'numeric_level', label: tr('acad.level'), className: 'num' }, { key: 'stream', label: 'Stream' }]}
          toolbar={<>{d.classes.length === 0 && yid && <Button size="sm" variant="secondary" onClick={() => submit(`/api/academic/years/${yid}/preset`, { institutionType: d.institutionType })}>{tr('acad.preset')}</Button>}<Button size="sm" onClick={() => setDrawer('classes')}>{tr('common.new')}</Button></>} />}
        {tab === 'sections' && <DataTable locale={d.locale} rows={d.sections} columns={[{ key: 'class_name', label: tr('common.class') }, { key: 'name', label: tr('common.section') }, { key: 'enrolled', label: tr('acad.enrolled'), className: 'num', render: r => `${formatNumber(Number(r.enrolled), d.locale)} / ${formatNumber(Number(r.capacity), d.locale)}` }, { key: 'medium', label: 'Medium' }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> }]}
          toolbar={<Button size="sm" onClick={() => setDrawer('sections')} disabled={!yid}>{tr('common.new')}</Button>} />}
        {tab === 'subjects' && <DataTable locale={d.locale} rows={d.subjects} columns={[{ key: 'name', label: tr('common.subject'), render: r => name(r as never) }, { key: 'code', label: 'Code', className: 'num' }, { key: 'subject_type', label: 'Type' }, { key: 'is_optional', label: 'Optional', render: r => Number(r.is_optional) ? '✓' : '' }]} toolbar={<Button size="sm" onClick={() => setDrawer('subjects')}>{tr('common.new')}</Button>} />}
        {tab === 'matrix' && <DataTable locale={d.locale} rows={d.matrix} columns={[{ key: 'class_name', label: tr('common.class') }, { key: 'subject_name', label: tr('common.subject'), render: r => d.locale === 'bn' && r.subject_name_bn ? String(r.subject_name_bn) : String(r.subject_name) }, { key: 'weekly_periods', label: tr('acad.weeklyPeriods'), className: 'num' }, { key: 'full_marks', label: 'Full marks', className: 'num' }, { key: 'is_compulsory', label: 'Compulsory', render: r => Number(r.is_compulsory) ? '✓' : '' }]} toolbar={<Button size="sm" onClick={() => setDrawer('matrix')} disabled={!yid}>{tr('common.new')}</Button>} />}
        {tab === 'periods' && <DataTable locale={d.locale} searchable={false} rows={d.periods} columns={[{ key: 'sequence', label: '#', className: 'num' }, { key: 'name', label: tr('common.name') }, { key: 'start_time', label: 'Start', className: 'num' }, { key: 'end_time', label: 'End', className: 'num' }, { key: 'is_break', label: 'Break', render: r => Number(r.is_break) ? '✓' : '' }]} />}
        {tab === 'years' && <DataTable locale={d.locale} searchable={false} rows={d.years} columns={[{ key: 'name', label: tr('common.year') }, { key: 'start_date', label: 'Start', className: 'num' }, { key: 'end_date', label: 'End', className: 'num' }, { key: 'status', label: tr('common.status'), render: r => <Chip status={Number(r.is_current) ? 'active' : String(r.status)}>{Number(r.is_current) ? 'current' : String(r.status)}</Chip> }, { key: 'id', label: '', render: r => Number(r.is_current) ? null : <Button size="sm" variant="secondary" onClick={() => submit(`/api/academic/years/${r.id}/current`, {})}>{tr('acad.setCurrent')}</Button> }]} />}
      </div>

      <Drawer open={drawer === 'years'} onClose={() => setDrawer(null)} title={tr('acad.newYear')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); submit('/api/academic/years', { name: f.name, startDate: f.startDate, endDate: f.endDate, setCurrent: f.setCurrent === 'on', cloneFromYearId: f.cloneFromYearId || null }); }}>
          <Field label={tr('common.name')}><Input name="name" required placeholder="2027" /></Field>
          <Field label="Start"><Input name="startDate" type="date" required /></Field><Field label="End"><Input name="endDate" type="date" required /></Field>
          {d.years.length > 0 && <Field label="Clone structure from"><Select name="cloneFromYearId" placeholder={tr('common.none')} options={d.years.map(y => ({ value: String(y.id), label: String(y.name) }))} /></Field>}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="setCurrent" defaultChecked /> {tr('acad.setCurrent')}</label>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'classes'} onClose={() => setDrawer(null)} title={tr('acad.classes')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); submit('/api/academic/classes', { name: f.name, nameBn: f.nameBn, numericLevel: Number(f.numericLevel), stream: f.stream || null }); }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field><Field label={tr('stu.nameBn')}><Input name="nameBn" lang="bn" /></Field>
          <Field label={tr('acad.level')} hint="Play = -2, KG = 0, Class 1 = 1 … XII = 12"><Input name="numericLevel" type="number" required defaultValue={d.classes.length ? Number(d.classes[d.classes.length - 1].numeric_level) + 1 : 1} /></Field>
          <Field label="Stream"><Input name="stream" placeholder="Science / Humanities" /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'sections'} onClose={() => setDrawer(null)} title={tr('acad.sections')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); submit('/api/academic/sections', { academicYearId: yid, classId: f.classId, name: f.name, capacity: Number(f.capacity) || 40, roomId: f.roomId || null, classTeacherId: f.classTeacherId || null, genderPolicy: f.genderPolicy, medium: f.medium }); }}>
          <Field label={tr('common.class')}><Select name="classId" required options={classOpts} placeholder="—" /></Field>
          <Field label={tr('common.name')}><Input name="name" required placeholder="A" /></Field>
          <Field label={tr('acad.capacity')}><Input name="capacity" type="number" defaultValue={40} /></Field>
          <Field label={tr('acad.rooms')}><Select name="roomId" placeholder={tr('common.none')} options={d.rooms.map(r => ({ value: String(r.id), label: String(r.name) }))} /></Field>
          <Field label={tr('portal.classTeacher')}><Select name="classTeacherId" placeholder={tr('common.none')} options={d.staff.map(s => ({ value: String(s.id), label: `${s.first_name} ${s.last_name ?? ''}` }))} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Gender"><Select name="genderPolicy" options={[{ value: 'mixed', label: 'Mixed' }, { value: 'boys', label: 'Boys' }, { value: 'girls', label: 'Girls' }]} /></Field><Field label="Medium"><Select name="medium" options={[{ value: 'bangla', label: 'Bangla' }, { value: 'english', label: 'English' }, { value: 'arabic', label: 'Arabic' }]} /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'subjects'} onClose={() => setDrawer(null)} title={tr('acad.subjects')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); submit('/api/academic/subjects', { name: f.name, nameBn: f.nameBn, code: f.code, subjectType: f.subjectType, isOptional: f.isOptional === 'on' }); }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field><Field label={tr('stu.nameBn')}><Input name="nameBn" lang="bn" /></Field><Field label="Code"><Input name="code" required placeholder="MATH" /></Field>
          <Field label="Type"><Select name="subjectType" options={[{ value: 'theory', label: 'Theory' }, { value: 'practical', label: 'Practical' }, { value: 'both', label: 'Theory + practical' }, { value: 'activity', label: 'Activity' }]} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isOptional" /> Optional (4th subject)</label>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'matrix'} onClose={() => setDrawer(null)} title={tr('acad.matrix')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); submit('/api/academic/class-subjects', { academicYearId: yid, classId: f.classId, subjectId: f.subjectId, weeklyPeriods: Number(f.weeklyPeriods), fullMarks: Number(f.fullMarks), passMarks: Number(f.passMarks), isCompulsory: f.isCompulsory === 'on' }); }}>
          <Field label={tr('common.class')}><Select name="classId" required placeholder="—" options={classOpts} /></Field>
          <Field label={tr('common.subject')}><Select name="subjectId" required placeholder="—" options={d.subjects.map(s => ({ value: String(s.id), label: name(s as never) }))} /></Field>
          <div className="grid grid-cols-3 gap-3"><Field label={tr('acad.weeklyPeriods')}><Input name="weeklyPeriods" type="number" defaultValue={5} /></Field><Field label="Full"><Input name="fullMarks" type="number" defaultValue={100} /></Field><Field label="Pass"><Input name="passMarks" type="number" defaultValue={33} /></Field></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isCompulsory" defaultChecked /> Compulsory</label>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
