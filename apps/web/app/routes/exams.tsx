import { useEffect, useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/exams';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const year = await context.app.academic.currentYear(sid);
  const yearId = year ? String(year.id) : null;
  const exams = yearId ? await context.app.assessment.exams(sid, yearId) : [];
  const examId = url.searchParams.get('examId') ?? (exams[0] ? String(exams[0].id) : null);
  const scheduleId = url.searchParams.get('scheduleId');
  const [types, scales, classes, schedules, results, seats, grid] = await Promise.all([
    context.app.assessment.examTypes(sid), context.app.assessment.gradingScales(sid), context.app.academic.classes(sid),
    examId ? context.app.assessment.schedules(sid, examId) : [],
    examId ? context.app.assessment.results(sid, examId) : [],
    examId ? context.app.assessment.seatPlan(sid, examId) : [],
    scheduleId ? context.app.assessment.marksGrid(sid, scheduleId).catch(() => null) : null,
  ]);
  // what the nightly pass has already prepared and left for a person: publishing a result, applying a
  // promotion, the papers that never got their marks. The button is here, so the sentence is too.
  const prepared = await context.app.db.query<{ id: string; title: string; description: string | null; task_type: string }>(
    `SELECT id, title, description, task_type FROM tasks WHERE school_id = ? AND status = 'open' AND task_type IN ('assessment.publish','assessment.promote','assessment.marks_overdue') ORDER BY created_at DESC LIMIT 5`, [sid]);
  return { locale: (user.locale as Locale) || context.locale, yearId, exams, examId, scheduleId, types, scales, classes, schedules, results, seats, grid, prepared };
}
export function meta() { return [{ title: 'Pathshala — Exams' }]; }

type Entry = { theory?: string; practical?: string; ca?: string; absent?: boolean };

export default function Exams() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'subjects' | 'marks' | 'results' | 'seats'>('subjects');
  const [drawer, setDrawer] = useState(false);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  useEffect(() => {
    const init: Record<string, Entry> = {};
    for (const s of d.grid?.students ?? []) init[String(s.student_id)] = { theory: s.theory_obtained != null ? String(s.theory_obtained) : '', practical: s.practical_obtained != null ? String(s.practical_obtained) : '', ca: s.ca_obtained != null ? String(s.ca_obtained) : '', absent: !!Number(s.is_absent) };
    setEntries(init);
  }, [d.grid]);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(false); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  // the sheet a teacher filled in offline: nothing is saved unless every row is sound
  const importMarks = async (file: File) => {
    const b64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
    await run(async () => {
      const r = await api<{ saved: number; errors: { row: number; message: string }[] }>(`/api/exams/marks/${d.scheduleId}/import`, { method: 'POST', json: { base64: b64 } });
      if (r.errors.length) throw new Error(r.errors.slice(0, 5).map(e => `row ${e.row}: ${e.message}`).join('; '));
      setMsg(`${r.saved} ${tr('ex.marks').toLowerCase()}`);
    });
  };
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set(k, v); if (k === 'examId') n.delete('scheduleId'); setSp(n); };
  const exam = d.exams.find(e => String(e.id) === d.examId);
  const saveMarks = () => run(async () => {
    const rows = (d.grid?.students ?? []).map(s => { const e = entries[String(s.student_id)] ?? {}; return { studentId: String(s.student_id), theory: e.theory ? Number(e.theory) : null, practical: e.practical ? Number(e.practical) : null, ca: e.ca ? Number(e.ca) : null, isAbsent: !!e.absent }; }).filter(r => r.isAbsent || r.theory != null || r.practical != null || r.ca != null);
    const r = await api<{ saved: number }>('/api/exams/marks', { method: 'POST', json: { scheduleId: d.scheduleId, marks: rows } });
    setMsg(`${r.saved} ${tr('ex.marks').toLowerCase()}`);
  });

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('ex.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('ex.purpose')}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {d.exams.length > 0 && <Select value={d.examId ?? ''} onChange={e => setParam('examId', e.target.value)} options={d.exams.map(e => ({ value: String(e.id), label: `${e.name} (${e.status})` }))} className="max-w-[240px]" />}
          <Button size="sm" onClick={() => setDrawer(true)}>{tr('ex.new')}</Button>
        </div>
      </div>
      {exam && <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={tr('ex.schedules')} value={Number(exam.subjects)} locale={d.locale} />
        <Kpi label={tr('ex.results')} value={Number(exam.results)} locale={d.locale} />
        <div className="kpi"><div className="kpi-label">{tr('common.status')}</div><div className="mt-1"><Chip status={String(exam.status) === 'published' ? 'active' : String(exam.status)}>{String(exam.status)}</Chip></div></div>
        <div className="kpi"><div className="kpi-label">{tr('common.date')}</div><div className="mt-1 text-sm">{formatDate(String(exam.start_date), d.locale)} – {formatDate(String(exam.end_date), d.locale)}</div></div>
      </div>}
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}
      {d.prepared.filter(p => p.task_type !== 'assessment.marks_overdue').map(p => (
        <div className="mt-4" key={p.id}><Banner kind="warn"><strong>{tr('ex.readyToPublish')}:</strong> {p.title}{p.description ? ` — ${p.description}` : ''}</Banner></div>
      ))}
      {d.prepared.filter(p => p.task_type === 'assessment.marks_overdue').map(p => (
        <div className="mt-4" key={p.id}><Banner kind="bad">{p.title}{p.description ? ` — ${p.description.split('\n').join(' · ')}` : ''}</Banner></div>
      ))}
      {exam && <p className="mt-4 text-sm" style={{ color: 'var(--muted)' }}>{tr('ex.autoNote')}</p>}
      {exam && <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => run(async () => { const r = await api<{ seated: number; ineligible: number }>(`/api/exams/${d.examId}/seat-plan`, { method: 'POST', json: {} }); setMsg(`${r.seated} seated, ${r.ineligible} not eligible`); })} disabled={busy}>{tr('ex.buildSeats')}</Button>
        <Button size="sm" variant="secondary" onClick={() => run(async () => { const r = await api<{ students: number; passed: number; failed: number }>(`/api/exams/${d.examId}/compute`, { method: 'POST', json: {} }); setMsg(`${r.students} results · ${r.passed} passed · ${r.failed} failed`); })} disabled={busy}>{tr('ex.compute')}</Button>
        <Button size="sm" onClick={() => run(async () => { await api(`/api/exams/${d.examId}/publish`, { method: 'POST', json: {} }); setMsg('Report cards are rendering; guardians will be notified.'); })} disabled={busy || !Number(exam.results)}>{tr('ex.publish')}</Button>
      </div>}
      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[{ key: 'subjects', label: tr('ex.schedules'), count: d.schedules.length }, { key: 'marks', label: tr('ex.marks') }, { key: 'results', label: tr('ex.results'), count: d.results.length }, { key: 'seats', label: tr('ex.seatPlan'), count: d.seats.length }]} /></div>

      {tab === 'subjects' && <div className="mt-4"><DataTable locale={d.locale} rows={d.schedules} onRowClick={r => { setParam('scheduleId', String(r.id)); setTab('marks'); }}
        columns={[{ key: 'class_name', label: tr('common.class') }, { key: 'subject_name', label: tr('common.subject'), render: r => d.locale === 'bn' && r.subject_name_bn ? String(r.subject_name_bn) : String(r.subject_name) }, { key: 'exam_date', label: tr('common.date'), render: r => formatDate(String(r.exam_date), d.locale) }, { key: 'full_marks', label: tr('ex.fullMarks'), className: 'num' }, { key: 'entered', label: tr('ex.marks'), className: 'num' }, { key: 'marks_entry_locked', label: tr('common.status'), render: r => <Chip status={Number(r.marks_entry_locked) ? 'done' : 'pending'}>{Number(r.marks_entry_locked) ? tr('ex.lock') : tr('ex.pending')}</Chip> }]} /></div>}

      {tab === 'marks' && <div className="mt-4">
        {!d.grid ? <Banner kind="info">{tr('ex.schedules')} → {tr('ex.enterMarks')}</Banner> : <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{String(d.grid.schedule.class_name)} · {String(d.grid.schedule.subject_name)}</span>
            <span className="chip">{tr('ex.fullMarks')} {formatNumber(Number(d.grid.schedule.full_marks), d.locale)}</span>
            <div className="ml-auto flex flex-wrap gap-2">
              <a className="btn btn-secondary btn-sm" href={`/api/exams/marks/sheet?scheduleId=${d.scheduleId}`}>{tr('ex.marksSheet')}</a>
              <label className="btn btn-secondary btn-sm" style={{ cursor: Number(d.grid.schedule.marks_entry_locked) ? 'not-allowed' : 'pointer' }}>{tr('ex.importMarks')}
                <input type="file" accept=".xlsx,.xls" className="hidden" disabled={busy || Number(d.grid.schedule.marks_entry_locked) === 1} onChange={e => { const f = e.target.files?.[0]; if (f) void importMarks(f); e.currentTarget.value = ''; }} /></label>
              <Button size="sm" onClick={saveMarks} disabled={busy || Number(d.grid.schedule.marks_entry_locked) === 1}>{tr('common.save')}</Button>
              <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/exams/marks/${d.scheduleId}/verify`, { method: 'POST', json: {} }))} disabled={busy}>{tr('ex.verify')}</Button>
              {Number(d.grid.schedule.marks_entry_locked) ? <Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/exams/marks/${d.scheduleId}/unlock`, { method: 'POST', json: {} }))}>{tr('ex.unlock')}</Button> : <Button size="sm" variant="danger" onClick={() => run(() => api(`/api/exams/marks/${d.scheduleId}/lock`, { method: 'POST', json: {} }))}>{tr('ex.lock')}</Button>}
            </div>
          </div>
          <div className="card mt-3 overflow-x-auto">
            <table className="table"><thead><tr><th>{tr('stu.roll')}</th><th>{tr('common.name')}</th><th>{tr('ex.theory')}</th><th>{tr('ex.practical')}</th><th>{tr('ex.ca')}</th><th>{tr('ex.absent')}</th><th>{tr('ex.grade')}</th></tr></thead>
              <tbody>{d.grid.students.map(s => { const id = String(s.student_id); const e = entries[id] ?? {}; return (
                <tr key={id}><td className="num">{String(s.current_roll_no ?? '')}</td><td>{String(s.first_name)} {String(s.last_name ?? '')}</td>
                  {(['theory', 'practical', 'ca'] as const).map(k => <td key={k}><input className="input num max-w-[80px]" inputMode="decimal" value={e[k] ?? ''} disabled={!!e.absent || Number(d.grid!.schedule.marks_entry_locked) === 1} onChange={ev => setEntries(m => ({ ...m, [id]: { ...m[id], [k]: ev.target.value } }))} /></td>)}
                  <td><input type="checkbox" checked={!!e.absent} disabled={Number(d.grid!.schedule.marks_entry_locked) === 1} onChange={ev => setEntries(m => ({ ...m, [id]: { ...m[id], absent: ev.target.checked } }))} /></td>
                  <td>{s.grade ? <Chip status={String(s.grade) === 'F' ? 'failed' : 'active'}>{String(s.grade)}</Chip> : ''}</td></tr>); })}
              </tbody></table>
          </div>
        </>}
      </div>}

      {tab === 'results' && <div className="mt-4"><DataTable locale={d.locale} rows={d.results} columns={[{ key: 'rank_in_class', label: tr('ex.rank'), className: 'num' }, { key: 'admission_no', label: tr('stu.admissionNo'), className: 'num' }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` }, { key: 'class_name', label: tr('common.class'), render: r => `${r.class_name ?? ''} ${r.section_name ?? ''}` }, { key: 'total_obtained', label: tr('ex.total'), className: 'num', render: r => `${formatNumber(Number(r.total_obtained), d.locale)} / ${formatNumber(Number(r.total_full_marks), d.locale)}` }, { key: 'percentage', label: '%', className: 'num' }, { key: 'gpa', label: tr('ex.gpa'), className: 'num' }, { key: 'grade', label: tr('ex.grade'), render: r => <Chip status={Number(r.is_pass) ? 'active' : 'failed'}>{String(r.grade)}</Chip> }, { key: 'report_card_file_id', label: tr('ex.reportCard'), render: r => r.report_card_file_id ? <Button size="sm" variant="secondary" onClick={async () => { const u = await api<{ url: string }>(`/api/files/${r.report_card_file_id}/url`); window.open(u.url, '_blank'); }}>PDF</Button> : null }]} /></div>}

      {tab === 'seats' && <div className="mt-4"><DataTable locale={d.locale} rows={d.seats} columns={[{ key: 'seat_no', label: 'Seat', className: 'num' }, { key: 'room_name', label: 'Room' }, { key: 'admission_no', label: tr('stu.admissionNo'), className: 'num' }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` }, { key: 'class_name', label: tr('common.class') }, { key: 'is_eligible', label: tr('ex.eligible'), render: r => Number(r.is_eligible) ? <Chip status="active">{tr('ex.eligible')}</Chip> : <Chip status="failed">{String(r.ineligible_reason)}</Chip> }]} /></div>}

      <Drawer open={drawer} onClose={() => setDrawer(false)} title={tr('ex.new')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/exams', { method: 'POST', json: { name: f.name, startDate: f.startDate, endDate: f.endDate, examTypeId: f.examTypeId || null, requireFeeClearance: f.requireFeeClearance === 'on', minAttendancePct: f.minAttendancePct ? Number(f.minAttendancePct) : null } })); }}>
          <Field label={tr('common.name')}><Input name="name" required placeholder="Half-yearly 2026" /></Field>
          <Field label="Type"><Select name="examTypeId" options={d.types.map(x => ({ value: String(x.id), label: `${x.name} (${x.weight_pct}%)` }))} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Start"><Input name="startDate" type="date" required /></Field><Field label="End"><Input name="endDate" type="date" required /></Field></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requireFeeClearance" /> Require fee clearance to sit</label>
          <Field label="Minimum attendance %" hint="leave empty to allow everyone"><Input name="minAttendancePct" type="number" className="num" /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
