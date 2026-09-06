import { useState } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/syllabus';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Select, Textarea, api, formatDate, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id;
  const year = await context.app.academic.currentYear(sid);
  if (!year) return { locale: (user.locale as Locale) || context.locale, year: null, syllabi: [], matrix: [], sections: [], staff: [], progress: [], lessons: [] };
  const yid = String(year.id);
  const [syllabi, matrix, sections, staff, progress, lessons] = await Promise.all([context.app.curriculum.syllabi(sid, yid), context.app.academic.classSubjects(sid, yid), context.app.academic.sections(sid, yid), context.app.people.staff(sid, { teachingOnly: true }), context.app.curriculum.progress(sid, yid), context.app.curriculum.lessons(sid, {})]);
  return { locale: (user.locale as Locale) || context.locale, year, syllabi, matrix, sections, staff, progress, lessons };
}
export function meta() { return [{ title: 'Pathshala — Syllabus' }]; }

export default function Syllabus() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [drawer, setDrawer] = useState<'syllabus' | 'lesson' | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [units, setUnits] = useState<Record<string, { id: string; title: string; sequence: number; planned_end_date: string | null }[]>>({});
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const csLabel = (r: { class_name: unknown; subject_name: unknown; subject_name_bn?: unknown }) => `${r.class_name} · ${d.locale === 'bn' && r.subject_name_bn ? r.subject_name_bn : r.subject_name}`;
  const loadUnits = async (syllabusId: string) => { if (units[syllabusId]) return; setUnits({ ...units, [syllabusId]: await api(`/api/curriculum/syllabi/${syllabusId}/units`) }); };
  const createSyllabus = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; const list = f.units.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const m = l.match(/^(.*?)(?:\s*@\s*(\d{4}-\d{2}-\d{2}))?$/); return { title: m?.[1] ?? l, plannedEndDate: m?.[2] ?? null, plannedPeriods: 2 }; }); run(() => api('/api/curriculum/syllabi', { method: 'POST', json: { classSubjectId: f.classSubjectId, title: f.title, units: list } })); };
  const planLesson = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/curriculum/lessons', { method: 'POST', json: { teacherId: f.teacherId, sectionId: f.sectionId, classSubjectId: f.classSubjectId, unitId: f.unitId || null, planDate: f.planDate, topic: f.topic, homework: f.homework || null } })); };
  const [lessonSyllabus, setLessonSyllabus] = useState<string>('');

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl">{tr('syl.title')}</h1></div><div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => setDrawer('lesson')} disabled={!d.year}>{tr('syl.plan')}</Button><Button size="sm" onClick={() => setDrawer('syllabus')} disabled={!d.year}>{tr('syl.new')}</Button></div></div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      <div className="mt-4 grid gap-6 xl:grid-cols-2">
        <section><h2 className="mb-2 text-base">{tr('syl.units')}</h2><DataTable locale={d.locale} rows={d.syllabi} columns={[{ key: 'class_name', label: tr('common.class') }, { key: 'subject_name', label: tr('common.subject') }, { key: 'title', label: tr('common.name') }, { key: 'units', label: tr('syl.units'), className: 'num' }]} onRowClick={r => loadUnits(String(r.id))} /></section>
        <section><h2 className="mb-2 text-base">{tr('syl.progress')}</h2><DataTable locale={d.locale} rows={d.progress} columns={[{ key: 'class_name', label: tr('common.class'), render: r => `${r.class_name} ${r.section_name}` }, { key: 'subject_name', label: tr('common.subject') }, { key: 'taught_units', label: tr('syl.units'), className: 'num', render: r => `${formatNumber(Number(r.taught_units), d.locale)} / ${formatNumber(Number(r.total_units), d.locale)}` }, { key: 'pct', label: '%', className: 'num', render: r => <span className={Number(r.pct) < 50 ? 'chip chip-warn' : 'chip chip-ok'}>{formatNumber(Number(r.pct), d.locale)}%</span> }]} /></section>
      </div>
      <section className="mt-6"><h2 className="mb-2 text-base">{tr('syl.plan')}</h2><DataTable locale={d.locale} rows={d.lessons} columns={[{ key: 'plan_date', label: tr('common.date'), render: r => formatDate(String(r.plan_date), d.locale) }, { key: 'class_name', label: tr('common.class'), render: r => `${r.class_name} ${r.section_name}` }, { key: 'subject_name', label: tr('common.subject') }, { key: 'topic', label: tr('syl.topic') }, { key: 'unit_title', label: tr('syl.units') }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'planned' ? 'pending' : String(r.status) === 'taught' ? 'done' : 'skipped'}>{String(r.status)}</Chip> }, { key: 'id', label: '', render: r => String(r.status) === 'planned' ? <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/curriculum/lessons/${r.id}/taught`, { method: 'POST', json: { status: 'taught' } }))}>{tr('syl.taught')}</Button> : null }]} /></section>

      <Drawer open={drawer === 'syllabus'} onClose={() => setDrawer(null)} title={tr('syl.new')}>
        <form className="grid gap-3" onSubmit={createSyllabus}>
          <Field label={tr('common.subject')}><Select name="classSubjectId" required placeholder="—" options={d.matrix.map(m => ({ value: String(m.id), label: csLabel(m as never) }))} /></Field>
          <Field label={tr('common.name')}><Input name="title" required placeholder="Annual syllabus 2026" /></Field>
          <Field label={tr('syl.units')} hint="one unit per line; add @YYYY-MM-DD for the planned end date"><Textarea name="units" required rows={8} placeholder={'Chapter 1: Numbers @2026-02-15\nChapter 2: Fractions @2026-03-20'} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'lesson'} onClose={() => setDrawer(null)} title={tr('syl.plan')}>
        <form className="grid gap-3" onSubmit={planLesson}>
          <Field label="Teacher"><Select name="teacherId" required placeholder="—" options={d.staff.map(s => ({ value: String(s.id), label: `${s.first_name} ${s.last_name ?? ''}` }))} /></Field>
          <Field label={tr('common.section')}><Select name="sectionId" required placeholder="—" options={d.sections.map(s => ({ value: String(s.id), label: `${s.class_name} ${s.name}` }))} /></Field>
          <Field label={tr('common.subject')}><Select name="classSubjectId" required placeholder="—" options={d.matrix.map(m => ({ value: String(m.id), label: csLabel(m as never) }))} onChange={e => { const sy = d.syllabi.find(s => s.class_subject_id === e.target.value); setLessonSyllabus(sy ? String(sy.id) : ''); if (sy) void loadUnits(String(sy.id)); }} /></Field>
          <Field label={tr('syl.units')}><Select name="unitId" placeholder={tr('common.none')} options={(units[lessonSyllabus] ?? []).map(u => ({ value: u.id, label: `${u.sequence}. ${u.title}` }))} /></Field>
          <Field label={tr('common.date')}><Input name="planDate" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
          <Field label={tr('syl.topic')}><Input name="topic" required /></Field>
          <Field label="Homework"><Textarea name="homework" rows={2} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
