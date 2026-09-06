import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/timetable';
import { Banner, Button, Chip, Field, Input, Select, api, formatDateTime, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const year = await context.app.academic.currentYear(sid);
  if (!year) return { locale: (user.locale as Locale) || context.locale, year: null, versions: [], version: null, sections: [], grid: [], periods: [], clashes: [], staff: [], days: [], sectionId: null, subs: [] };
  const yid = String(year.id);
  const versions = await context.app.timetable.versions(sid, yid);
  const version = versions.find(v => v.id === url.searchParams.get('versionId')) ?? versions.find(v => v.status === 'published') ?? versions[0] ?? null;
  const sections = await context.app.academic.sections(sid, yid);
  const sectionId = url.searchParams.get('sectionId') ?? (sections[0] ? String(sections[0].id) : null);
  const offs = await context.app.academic.weeklyOffs(sid);
  const days = [0, 1, 2, 3, 4, 5, 6].filter(d => !offs.includes(d));
  const [grid, clashes, periods, staff, subs] = await Promise.all([
    version && sectionId ? context.app.timetable.grid(sid, String(version.id), sectionId) : [], version ? context.app.timetable.validate(sid, String(version.id)) : [], context.app.academic.periods(sid), context.app.people.staff(sid, { teachingOnly: true }), context.app.timetable.substitutions(sid, url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10)),
  ]);
  return { locale: (user.locale as Locale) || context.locale, year, versions, version, sections, grid, periods, clashes, staff, days, sectionId, subs };
}
export function meta() { return [{ title: 'Pathshala — Timetable' }]; }

export default function Timetable() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [last, setLast] = useState<{ placed: number; unplaced: number; clashes: number; score: number; sections: number } | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const generate = () => run(async () => setLast(await api('/api/timetable/generate', { method: 'POST', json: {} })));
  const publish = () => d.version && run(() => api(`/api/timetable/versions/${d.version!.id}/publish`, { method: 'POST', json: {} }));
  const suggest = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()); run(() => api('/api/timetable/substitutions/suggest', { method: 'POST', json: { teacherId: f.teacherId, onDate: f.onDate } }).then(() => { const n = new URLSearchParams(sp); n.set('date', String(f.onDate)); setSp(n); })); };
  const periods = d.periods.filter(p => p.shift_id == null || !d.sections.find(s => s.id === d.sectionId)?.shift_id || p.shift_id === d.sections.find(s => s.id === d.sectionId)?.shift_id);
  const cell = (day: number, periodId: string) => d.grid.find(g => Number(g.day_of_week) === day && g.period_id === periodId);
  const subj = (g: Record<string, unknown>) => d.locale === 'bn' && g.subject_name_bn ? String(g.subject_name_bn) : String(g.subject_name ?? '—');

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('tt.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('tt.purpose')}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {d.versions.length > 0 && <Select value={d.version ? String(d.version.id) : ''} onChange={e => { const n = new URLSearchParams(sp); n.set('versionId', e.target.value); setSp(n); }} options={d.versions.map(v => ({ value: String(v.id), label: `${v.name} (${v.status})` }))} />}
          <Button size="sm" variant="secondary" onClick={generate} disabled={busy || !d.year}>{tr('tt.generate')}</Button>
          {d.version && d.version.status !== 'published' && <Button size="sm" onClick={publish} disabled={busy || d.clashes.length > 0}>{tr('tt.publish')}</Button>}
          {d.version?.status === 'published' && <Chip status="active">{tr('tt.published')}</Chip>}
        </div>
      </div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {last && <div className="mt-4"><Banner kind={last.clashes ? 'bad' : 'ok'}>{formatNumber(last.placed, d.locale)} {tr('tt.placed')} · {formatNumber(last.unplaced, d.locale)} {tr('tt.unplaced')} · {formatNumber(last.clashes, d.locale)} {tr('tt.clashes')} · {formatNumber(last.sections, d.locale)} {tr('acad.sections').toLowerCase()} · score {formatNumber(last.score, d.locale)}</Banner></div>}
      {d.clashes.length > 0 && <div className="mt-4"><Banner kind="bad">{tr('tt.clashes')}: {d.clashes.length}</Banner></div>}
      {!d.year && <div className="mt-4"><Banner kind="warn">{tr('acad.newYear')} → <a href="/academic">{tr('nav.academic')}</a></Banner></div>}

      {d.version && <div className="mt-6">
        <div className="flex items-center gap-2"><Select value={d.sectionId ?? ''} onChange={e => { const n = new URLSearchParams(sp); n.set('sectionId', e.target.value); setSp(n); }} options={d.sections.map(s => ({ value: String(s.id), label: `${s.class_name} ${s.name}` }))} className="max-w-xs" /><span className="text-xs" style={{ color: 'var(--muted)' }}>{formatDateTime(String(d.version.created_at), d.locale)} · {String(d.version.generated_by)}</span></div>
        <div className="card mt-3 overflow-x-auto">
          <table className="table"><thead><tr><th>{tr('acad.periods')}</th>{d.days.map(day => <th key={day}>{t(`day.${day}` as never, d.locale)}</th>)}</tr></thead>
            <tbody>{periods.map(p => <tr key={String(p.id)}><td className="whitespace-nowrap"><div className="font-medium">{String(p.name)}</div><div className="num text-xs" style={{ color: 'var(--muted)' }}>{String(p.start_time).slice(0, 5)}–{String(p.end_time).slice(0, 5)}</div></td>
              {d.days.map(day => { if (Number(p.is_break)) return <td key={day} style={{ background: 'var(--surface-2)', color: 'var(--muted)' }}>—</td>; const g = cell(day, String(p.id)); return <td key={day}>{g ? <div><div className="font-medium">{subj(g)}</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{String(g.teacher_first ? `${g.teacher_first} ${g.teacher_last ?? ''}` : '')}{String(g.room_name ? ` · ${g.room_name}` : '')}</div></div> : <span style={{ color: 'var(--line)' }}>·</span>}</td>; })}</tr>)}</tbody></table>
        </div>
      </div>}

      <section className="card mt-6 p-4">
        <h2 className="text-base">{tr('tt.substitutions')}</h2>
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={suggest}>
          <Field label={tr('tt.teacherAbsent')}><Select name="teacherId" required placeholder="—" options={d.staff.map(s => ({ value: String(s.id), label: `${s.first_name} ${s.last_name ?? ''}` }))} /></Field>
          <Field label={tr('common.date')}><Input name="onDate" type="date" required defaultValue={sp.get('date') ?? new Date().toISOString().slice(0, 10)} /></Field>
          <Button variant="secondary" disabled={busy || d.version?.status !== 'published'}>{tr('tt.suggest')}</Button>
        </form>
        {d.subs.length > 0 && <table className="table mt-3"><thead><tr><th>{tr('acad.periods')}</th><th>{tr('common.class')}</th><th>{tr('tt.teacherAbsent')}</th><th>Substitute</th><th>{tr('common.status')}</th><th></th></tr></thead>
          <tbody>{d.subs.map(s => <tr key={String(s.id)}><td>{String(s.period_name)}</td><td>{String(s.class_name)} {String(s.section_name)}</td><td>{String(s.original_first ?? '')} {String(s.original_last ?? '')}</td><td>{s.sub_first ? `${s.sub_first} ${s.sub_last ?? ''}` : <span style={{ color: 'var(--bad)' }}>nobody free</span>}</td><td><Chip status={String(s.status) === 'suggested' ? 'pending' : String(s.status)}>{String(s.status)}</Chip></td>
            <td>{String(s.status) === 'suggested' && <div className="flex gap-1"><Button size="sm" onClick={() => run(() => api(`/api/timetable/substitutions/${s.id}`, { method: 'POST', json: { status: 'approved' } }))}>✓</Button><Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/timetable/substitutions/${s.id}`, { method: 'POST', json: { status: 'rejected' } }))}>✕</Button></div>}</td></tr>)}</tbody></table>}
      </section>
    </div>
  );
}
