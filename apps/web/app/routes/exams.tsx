import { useEffect, useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/exams';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, formatDateTime, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const year = await context.app.academic.currentYear(sid);
  const yearId = year ? String(year.id) : null;
  const exams = yearId ? await context.app.assessment.exams(sid, yearId) : [];
  const examId = url.searchParams.get('examId') ?? (exams[0] ? String(exams[0].id) : null);
  const scheduleId = url.searchParams.get('scheduleId');
  const [types, scales, classes, schedules, results, seats, grid, annual, questions, papers, online, years, subjects] = await Promise.all([
    context.app.assessment.examTypes(sid), context.app.assessment.gradingScales(sid), context.app.academic.classes(sid),
    examId ? context.app.assessment.schedules(sid, examId) : [],
    examId ? context.app.assessment.results(sid, examId, { sectionId: url.searchParams.get('sectionId') ?? undefined }) : [],
    examId ? context.app.assessment.seatPlan(sid, examId) : [],
    scheduleId ? context.app.assessment.marksGrid(sid, scheduleId).catch(() => null) : null,
    yearId ? context.app.db.query<Record<string, unknown>>(`SELECT a.student_id, a.weighted_gpa, a.weighted_pct, a.decision, s.first_name, s.last_name, s.admission_no, c.name AS class_name FROM annual_results a JOIN students s ON s.id = a.student_id LEFT JOIN classes c ON c.id = s.current_class_id WHERE a.school_id = ? AND a.academic_year_id = ? ORDER BY a.weighted_gpa DESC LIMIT 2000`, [sid, yearId]) : [],
    context.app.assessment.questions(sid),
    context.app.assessment.papers(sid),
    context.app.assessment.onlineExams(sid),
    context.app.academic.years(sid),
    context.app.academic.subjects(sid),
  ]);
  const sections = yearId ? await context.app.academic.sections(sid, yearId) : [];
  const classSubjects = yearId ? await context.app.academic.classSubjects(sid, yearId) : [];
  // what the nightly pass has already prepared and left for a person: publishing a result, applying a
  // promotion, the papers that never got their marks. The button is here, so the sentence is too.
  const prepared = await context.app.db.query<{ id: string; title: string; description: string | null; task_type: string }>(
    `SELECT id, title, description, task_type FROM tasks WHERE school_id = ? AND status = 'open' AND task_type IN ('assessment.publish','assessment.promote','assessment.marks_overdue') ORDER BY created_at DESC LIMIT 5`, [sid]);
  return { locale: (user.locale as Locale) || context.locale, yearId, exams, examId, scheduleId, sectionId: url.searchParams.get('sectionId') ?? '', types, scales, classes, schedules, results, seats, grid, prepared, annual, questions, papers, online, years, subjects, sections, classSubjects };
}
export function meta() { return [{ title: 'Pathshala — Exams' }]; }

type Entry = { theory?: string; practical?: string; ca?: string; absent?: boolean };
type Tab = 'list' | 'subjects' | 'marks' | 'results' | 'seats' | 'promotion' | 'questions' | 'online';
type Promo = { promoted: number; retained: number; graduated: number; students: number; applied: boolean; byClass: { classId: string; className: string; rule: string; students: number; promote: number; retain: number; graduate: number }[] };

export default function Exams() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0], vars?: Record<string, string | number>) => t(k, d.locale, vars);
  const [tab, setTab] = useState<Tab>('list');
  const [drawer, setDrawer] = useState<null | 'exam' | 'question' | 'paper' | 'online'>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [promo, setPromo] = useState<Promo | null>(null); const [toYear, setToYear] = useState('');
  useEffect(() => {
    const init: Record<string, Entry> = {};
    for (const s of d.grid?.students ?? []) init[String(s.student_id)] = { theory: s.theory_obtained != null ? String(s.theory_obtained) : '', practical: s.practical_obtained != null ? String(s.practical_obtained) : '', ca: s.ca_obtained != null ? String(s.ca_obtained) : '', absent: !!Number(s.is_absent) };
    setEntries(init);
  }, [d.grid]);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
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
  const num = (n: number | string) => formatNumber(n, d.locale);
  const saveMarks = () => run(async () => {
    const rows = (d.grid?.students ?? []).map(s => { const e = entries[String(s.student_id)] ?? {}; return { studentId: String(s.student_id), theory: e.theory ? Number(e.theory) : null, practical: e.practical ? Number(e.practical) : null, ca: e.ca ? Number(e.ca) : null, isAbsent: !!e.absent }; }).filter(r => r.isAbsent || r.theory != null || r.practical != null || r.ca != null);
    const r = await api<{ saved: number }>('/api/exams/marks', { method: 'POST', json: { scheduleId: d.scheduleId, marks: rows } });
    setMsg(`${r.saved} ${tr('ex.marks').toLowerCase()}`);
  });

  // ---------- results: the figures the prototype puts above the table ----------
  const passed = d.results.filter(r => Number(r.is_pass)).length;
  const passRate = d.results.length ? Math.round((passed / d.results.length) * 1000) / 10 : null;
  const avgGpa = d.results.length ? Math.round((d.results.reduce((a, r) => a + Number(r.gpa), 0) / d.results.length) * 100) / 100 : null;
  const dist = d.results.reduce<Record<string, number>>((a, r) => ({ ...a, [String(r.grade)]: (a[String(r.grade)] ?? 0) + 1 }), {});
  const distMax = Math.max(1, ...Object.values(dist));
  const defaultScale = d.scales.find(s => Number(s.is_default)) ?? d.scales[0];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('ex.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('ex.purpose')}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {d.exams.length > 0 && <Select value={d.examId ?? ''} onChange={e => setParam('examId', e.target.value)} options={d.exams.map(e => ({ value: String(e.id), label: `${e.name} (${e.status})` }))} className="max-w-[240px]" />}
          <Button size="sm" onClick={() => setDrawer('exam')}>{tr('ex.new')}</Button>
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
      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'list', label: tr('ex.examList'), count: d.exams.length },
        { key: 'subjects', label: tr('ex.schedules'), count: d.schedules.length },
        { key: 'marks', label: tr('ex.marks') },
        { key: 'results', label: tr('ex.results'), count: d.results.length },
        { key: 'seats', label: tr('ex.seatPlan'), count: d.seats.length },
        { key: 'promotion', label: tr('ex.promotion') },
        { key: 'questions', label: tr('ex.questions'), count: d.questions.length },
        { key: 'online', label: tr('ex.online'), count: d.online.length },
      ]} /></div>

      {tab === 'list' && <div className="mt-4">
        <DataTable locale={d.locale} searchable={false} rows={d.exams} onRowClick={r => { setParam('examId', String(r.id)); setTab('subjects'); }} columns={[
          { key: 'name', label: tr('ex.title') },
          { key: 'exam_type', label: tr('common.type') },
          { key: 'start_date', label: tr('ex.starts'), render: r => formatDate(String(r.start_date), d.locale) },
          { key: 'end_date', label: tr('ex.ends'), render: r => formatDate(String(r.end_date), d.locale) },
          { key: 'subjects', label: tr('ex.schedules'), className: 'num' },
          { key: 'grading_scale_id', label: tr('ex.grading'), render: () => defaultScale ? `${defaultScale.name} (GPA ${Number(defaultScale.gpa_max)})` : '—' },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'published' ? 'active' : String(r.status)}>{String(r.status)}</Chip> },
          { key: 'id', label: '', render: r => String(r.status) === 'draft' || String(r.status) === 'scheduled'
            ? <Button size="sm" variant="secondary" onClick={e => { e.stopPropagation(); run(async () => { const x = await api<{ seated: number; ineligible: number }>(`/api/exams/${r.id}/seat-plan`, { method: 'POST', json: {} }); setMsg(`${x.seated} seated, ${x.ineligible} not eligible`); }); }} disabled={busy}>{tr('ex.buildSeats')}</Button>
            : null },
        ]} />
        {defaultScale && <div className="card mt-4 p-4">
          <h2 className="text-base">{tr('ex.grading')} · {String(defaultScale.name)}</h2>
          <div className="mt-3 overflow-x-auto"><table className="table"><thead><tr><th>{tr('ex.grade')}</th><th className="num">{tr('ex.marksPct')}</th><th className="num">{tr('ex.gradePoint')}</th></tr></thead>
            <tbody>{(defaultScale.bands ?? []).map((b, i, all) => (
              <tr key={String(b.id)}><td><b>{String(b.grade)}</b></td>
                <td className="num">{num(Number(b.min_percent))}{i === 0 ? '–100' : `–${num(Number(all[i - 1]!.min_percent) - 1)}`}</td>
                <td className="num">{Number(b.grade_point).toFixed(2)}</td></tr>))}</tbody></table></div>
        </div>}
      </div>}

      {tab === 'subjects' && <div className="mt-4"><DataTable locale={d.locale} rows={d.schedules} onRowClick={r => { setParam('scheduleId', String(r.id)); setTab('marks'); }}
        columns={[{ key: 'class_name', label: tr('common.class') }, { key: 'subject_name', label: tr('common.subject'), render: r => d.locale === 'bn' && r.subject_name_bn ? String(r.subject_name_bn) : String(r.subject_name) }, { key: 'exam_date', label: tr('common.date'), render: r => formatDate(String(r.exam_date), d.locale) }, { key: 'start_time', label: tr('common.time'), className: 'num', render: r => r.start_time ? `${String(r.start_time).slice(0, 5)}–${String(r.end_time ?? '').slice(0, 5)}` : <span style={{ color: 'var(--muted)' }}>—</span> }, { key: 'room_name', label: 'Room', render: r => r.room_name ? String(r.room_name) : <span style={{ color: 'var(--muted)' }}>—</span> }, { key: 'full_marks', label: tr('ex.fullMarks'), className: 'num' }, { key: 'entered', label: tr('ex.marks'), className: 'num' }, { key: 'marks_entry_locked', label: tr('common.status'), render: r => <Chip status={Number(r.marks_entry_locked) ? 'done' : 'pending'}>{Number(r.marks_entry_locked) ? tr('ex.lock') : tr('ex.pending')}</Chip> }]} /></div>}

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

      {tab === 'results' && <div className="mt-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select value={d.sectionId} onChange={e => setParam('sectionId', e.target.value)} placeholder={tr('common.all')} className="max-w-xs" options={d.sections.map(s => ({ value: String(s.id), label: `${s.class_name} ${s.name}` }))} />
          <span className="text-xs" style={{ color: 'var(--muted)' }}>{tr('ex.results')}: {num(d.results.length)}</span>
        </div>
        {d.results.length > 0 && <div className="mb-4 grid gap-3 lg:grid-cols-3">
          <div className="kpi"><div className="kpi-label">{tr('ex.passRate')}</div><div className="kpi-value num">{num(passRate ?? 0)}%</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{tr('ex.failedSome', { n: num(d.results.length - passed) })}</div></div>
          <div className="kpi"><div className="kpi-label">{tr('ex.avgGpa')}</div><div className="kpi-value num">{avgGpa == null ? '—' : avgGpa.toFixed(2)}</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{d.results[0] ? `${tr('ex.rank')} 1 · ${d.results[0].first_name} ${d.results[0].last_name ?? ''}` : ''}</div></div>
          <div className="card p-3"><div className="kpi-label">{tr('ex.distribution')}</div>
            <div className="mt-2 flex items-end gap-2" style={{ height: 80 }}>{Object.entries(dist).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([g, n]) => (
              <div key={g} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${g}: ${n}`}>
                <div className="w-full rounded-t" style={{ height: `${Math.max(3, (n / distMax) * 60)}px`, background: g === 'F' ? 'var(--bad)' : 'var(--accent)' }} />
                <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{g}</span></div>))}</div></div>
        </div>}
        <DataTable locale={d.locale} rows={d.results} columns={[{ key: 'rank_in_class', label: tr('ex.rank'), className: 'num' }, { key: 'current_roll_no', label: tr('stu.roll'), className: 'num', render: r => String(r.current_roll_no ?? '—') }, { key: 'admission_no', label: tr('stu.admissionNo'), className: 'num' }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` }, { key: 'class_name', label: tr('common.class'), render: r => `${r.class_name ?? ''} ${r.section_name ?? ''}` }, { key: 'total_obtained', label: tr('ex.total'), className: 'num', render: r => `${formatNumber(Number(r.total_obtained), d.locale)} / ${formatNumber(Number(r.total_full_marks), d.locale)}` }, { key: 'percentage', label: '%', className: 'num' }, { key: 'gpa', label: tr('ex.gpa'), className: 'num' }, { key: 'failed_subjects', label: tr('ex.failedSubjects'), className: 'num', render: r => Number(r.failed_subjects) ? <span style={{ color: 'var(--bad)' }}>{num(Number(r.failed_subjects))}</span> : num(0) }, { key: 'grade', label: tr('ex.grade'), render: r => <Chip status={Number(r.is_pass) ? 'active' : 'failed'}>{String(r.grade)}</Chip> }, { key: 'report_card_file_id', label: tr('ex.reportCard'), render: r => r.report_card_file_id ? <Button size="sm" variant="secondary" onClick={async () => { const u = await api<{ url: string }>(`/api/files/${r.report_card_file_id}/url`); window.open(u.url, '_blank'); }}>PDF</Button> : null }]} />
      </div>}

      {tab === 'seats' && <div className="mt-4"><DataTable locale={d.locale} rows={d.seats} columns={[{ key: 'seat_no', label: 'Seat', className: 'num' }, { key: 'room_name', label: 'Room' }, { key: 'admission_no', label: tr('stu.admissionNo'), className: 'num' }, { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` }, { key: 'class_name', label: tr('common.class') }, { key: 'is_eligible', label: tr('ex.eligible'), render: r => Number(r.is_eligible) ? <Chip status="active">{tr('ex.eligible')}</Chip> : <Chip status="failed">{String(r.ineligible_reason)}</Chip> }, { key: 'admit_card_file_id', label: tr('ex.admitCard'), render: r => r.admit_card_file_id ? <Button size="sm" variant="secondary" onClick={async () => { const u = await api<{ url: string }>(`/api/files/${r.admit_card_file_id}/url`); window.open(u.url, '_blank'); }}>PDF</Button> : <span style={{ color: 'var(--muted)' }}>—</span> }]} /></div>}

      {tab === 'promotion' && <div className="mt-4">
        <p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('ex.promotionNote')}</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { const r = await api<{ students: number }>('/api/exams/annual/compute', { method: 'POST', json: {} }); setMsg(`${num(r.students)} ${tr('ex.annual').toLowerCase()}`); })}>{tr('ex.computeAnnual')}</Button>
          <Field label={tr('ex.toYear')} className="max-w-[220px]"><Select value={toYear} onChange={e => setToYear(e.target.value)} placeholder="—" options={d.years.filter(y => String(y.id) !== d.yearId).map(y => ({ value: String(y.id), label: String(y.name) }))} /></Field>
          <Button size="sm" variant="secondary" disabled={busy || !toYear || !d.yearId} onClick={() => run(async () => { const r = await api<Promo>('/api/exams/annual/promote', { method: 'POST', json: { fromYearId: d.yearId, toYearId: toYear } }); setPromo(r); setMsg(null); })}>{tr('ex.preview')}</Button>
          <Button size="sm" disabled={busy || !promo || promo.applied || !toYear} onClick={() => run(async () => { const r = await api<Promo>('/api/exams/annual/promote', { method: 'POST', json: { fromYearId: d.yearId, toYearId: toYear, apply: true } }); setPromo(r); setMsg(tr('ex.applied')); })}>{tr('ex.applyPromotion')}</Button>
        </div>
        {d.annual.length === 0 && <div className="mt-3"><Banner kind="info">{tr('ex.noAnnual')}</Banner></div>}
        {promo && <div className="mt-4">
          <Banner kind={promo.applied ? 'ok' : 'warn'}>{promo.applied ? tr('ex.applied') : tr('ex.previewOnly')}</Banner>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label={tr('att.students')} value={promo.students} locale={d.locale} />
            <Kpi label={tr('ex.promote')} value={promo.promoted} locale={d.locale} />
            <Kpi label={tr('ex.retain')} value={promo.retained} locale={d.locale} />
            <Kpi label={tr('ex.graduate')} value={promo.graduated} locale={d.locale} />
          </div>
          <div className="mt-3"><DataTable locale={d.locale} searchable={false} rows={promo.byClass.map(r => ({ ...r, id: r.classId }))} columns={[
            { key: 'className', label: tr('ex.fromClass') },
            { key: 'rule', label: tr('ex.rule') },
            { key: 'students', label: tr('att.students'), className: 'num', render: r => num(r.students) },
            { key: 'promote', label: tr('ex.promote'), className: 'num', render: r => num(r.promote) },
            { key: 'retain', label: tr('ex.retain'), className: 'num', render: r => r.retain ? <span style={{ color: 'var(--bad)' }}>{num(r.retain)}</span> : num(0) },
            { key: 'graduate', label: tr('ex.graduate'), className: 'num', render: r => num(r.graduate) },
          ]} /></div>
        </div>}
        <h2 className="mt-6 text-lg">{tr('ex.annual')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} rows={d.annual} empty={tr('ex.noAnnual')} columns={[
          { key: 'admission_no', label: tr('stu.admissionNo'), className: 'num' },
          { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
          { key: 'class_name', label: tr('common.class'), render: r => String(r.class_name ?? '—') },
          { key: 'weighted_gpa', label: tr('ex.gpa'), className: 'num', render: r => Number(r.weighted_gpa).toFixed(2) },
          { key: 'weighted_pct', label: '%', className: 'num', render: r => num(Number(r.weighted_pct)) },
          { key: 'decision', label: tr('common.status'), render: r => <Chip status={String(r.decision) === 'promoted' ? 'active' : 'failed'}>{String(r.decision)}</Chip> },
        ]} /></div>
      </div>}

      {tab === 'questions' && <div className="mt-4">
        <DataTable locale={d.locale} rows={d.questions} empty={tr('ex.noQuestions')}
          toolbar={<><Button size="sm" variant="secondary" onClick={() => setDrawer('paper')}>{tr('ex.buildPaper')}</Button><Button size="sm" onClick={() => setDrawer('question')}>{tr('ex.newQuestion')}</Button></>}
          columns={[
            { key: 'body', label: tr('ex.qBody'), render: r => <span title={String(r.body)}>{String(d.locale === 'bn' && r.body_bn ? r.body_bn : r.body).slice(0, 90)}</span> },
            { key: 'subject_name', label: tr('common.subject'), render: r => String(d.locale === 'bn' && r.subject_name_bn ? r.subject_name_bn : r.subject_name) },
            { key: 'class_name', label: tr('common.class'), render: r => r.class_name ? String(r.class_name) : <span style={{ color: 'var(--muted)' }}>—</span> },
            { key: 'q_type', label: tr('common.type'), render: r => <span className="chip">{String(r.q_type)}</span> },
            { key: 'difficulty', label: tr('ex.difficulty'), render: r => <Chip status={String(r.difficulty) === 'hard' ? 'failed' : String(r.difficulty) === 'easy' ? 'active' : 'pending'}>{String(r.difficulty)}</Chip> },
            { key: 'marks', label: tr('ex.marks'), className: 'num', render: r => num(Number(r.marks)) },
            { key: 'usage_count', label: tr('ex.timesSet'), className: 'num', render: r => num(Number(r.usage_count)) },
          ]} />
        <h2 className="mt-6 text-lg">{tr('ex.papers')}</h2>
        <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.papers} columns={[
          { key: 'title', label: tr('ex.paper') },
          { key: 'class_name', label: tr('common.class'), render: r => `${r.class_name} · ${r.subject_name}` },
          { key: 'questions', label: tr('ex.questionCount'), className: 'num', render: r => num(Number(r.questions)) },
          { key: 'total_marks', label: tr('ex.total'), className: 'num', render: r => num(Number(r.total_marks)) },
          { key: 'duration_min', label: tr('ex.duration'), className: 'num', render: r => num(Number(r.duration_min ?? 0)) },
          { key: 'created_at', label: tr('common.date'), render: r => formatDate(String(r.created_at), d.locale) },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'final' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
        ]} /></div>
      </div>}

      {tab === 'online' && <div className="mt-4"><DataTable locale={d.locale} rows={d.online}
        toolbar={<Button size="sm" onClick={() => setDrawer('online')}>{tr('ex.newOnline')}</Button>}
        columns={[
          { key: 'title', label: tr('ex.title') },
          { key: 'section_name', label: tr('common.section'), render: r => `${r.class_name} ${r.section_name}` },
          { key: 'subject_name', label: tr('common.subject'), render: r => String(d.locale === 'bn' && r.subject_name_bn ? r.subject_name_bn : r.subject_name) },
          { key: 'starts_at', label: tr('ex.window'), render: r => `${formatDateTime(String(r.starts_at), d.locale)} – ${String(r.ends_at).slice(11, 16)}` },
          { key: 'questions', label: tr('ex.questionCount'), className: 'num', render: r => r.paper_id ? num(Number(r.questions)) : <span style={{ color: 'var(--muted)' }}>{tr('ex.noPaper')}</span> },
          { key: 'attempts', label: tr('ex.attempts'), className: 'num', render: r => `${num(Number(r.attempts))} / ${num(Number(r.roll))}` },
          { key: 'auto_grade', label: tr('ex.autoGrade'), render: r => Number(r.auto_grade) ? <Chip status="active">MCQ</Chip> : <span style={{ color: 'var(--muted)' }}>—</span> },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'published' ? 'active' : String(r.status)}>{String(r.status)}</Chip> },
        ]} /></div>}

      <Drawer open={drawer === 'exam'} onClose={() => setDrawer(null)} title={tr('ex.new')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/exams', { method: 'POST', json: { name: f.name, startDate: f.startDate, endDate: f.endDate, examTypeId: f.examTypeId || null, requireFeeClearance: f.requireFeeClearance === 'on', minAttendancePct: f.minAttendancePct ? Number(f.minAttendancePct) : null } })); }}>
          <Field label={tr('common.name')}><Input name="name" required placeholder="Half-yearly 2026" /></Field>
          <Field label={tr('common.type')}><Select name="examTypeId" options={d.types.map(x => ({ value: String(x.id), label: `${x.name} (${x.weight_pct}%)` }))} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('ex.starts')}><Input name="startDate" type="date" required /></Field><Field label={tr('ex.ends')}><Input name="endDate" type="date" required /></Field></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requireFeeClearance" /> Require fee clearance to sit</label>
          <Field label={tr('att.minPct')} hint="leave empty to allow everyone"><Input name="minAttendancePct" type="number" className="num" /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'question'} onClose={() => setDrawer(null)} title={tr('ex.newQuestion')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; const opts = f.options ? f.options.split('\n').map(s => s.trim()).filter(Boolean) : undefined; run(() => api('/api/questions', { method: 'POST', json: { subjectId: f.subjectId, classId: f.classId || null, qType: f.qType, difficulty: f.difficulty, body: f.body, marks: Number(f.marks || 1), options: opts, answer: f.answer || undefined } })); }}>
          <Field label={tr('common.subject')}><Select name="subjectId" required options={d.subjects.map(s => ({ value: String(s.id), label: String(d.locale === 'bn' && s.name_bn ? s.name_bn : s.name) }))} /></Field>
          <Field label={tr('common.class')} hint={tr('common.all')}><Select name="classId" placeholder={tr('common.all')} options={d.classes.map(c => ({ value: String(c.id), label: String(c.name) }))} /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label={tr('common.type')}><Select name="qType" options={['mcq', 'true_false', 'short', 'long', 'fill_blank', 'numeric', 'essay'].map(v => ({ value: v, label: v }))} /></Field>
            <Field label={tr('ex.difficulty')}><Select name="difficulty" options={['easy', 'medium', 'hard'].map(v => ({ value: v, label: v }))} /></Field>
            <Field label={tr('ex.marks')}><Input name="marks" type="number" className="num" defaultValue="1" /></Field>
          </div>
          <Field label={tr('ex.qBody')}><textarea name="body" className="input" rows={3} required /></Field>
          <Field label={tr('ex.options')} hint="mcq"><textarea name="options" className="input" rows={4} /></Field>
          <Field label={tr('ex.answer')}><Input name="answer" /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'paper'} onClose={() => setDrawer(null)} title={tr('ex.buildPaper')}>
        <form className="grid gap-3" onSubmit={e => {
          e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
          const blueprint: Record<string, { count: number; marks?: number }> = {};
          for (const kind of ['mcq', 'short', 'long'] as const) { const n = Number(f[`${kind}Count`] || 0); if (n > 0) blueprint[kind] = { count: n, marks: Number(f[`${kind}Marks`] || 1) }; }
          run(async () => { const r = await api<{ questions: number; totalMarks: number; missing: string[] }>('/api/questions/papers', { method: 'POST', json: { classSubjectId: f.classSubjectId, title: f.title, durationMin: Number(f.durationMin || 180), blueprint } }); setMsg(r.missing.length ? `${r.questions} questions, ${r.totalMarks} marks — ${r.missing.join('; ')}` : `${r.questions} questions, ${r.totalMarks} marks`); });
        }}>
          <Field label={tr('ex.paper')}><Input name="title" required placeholder="Model test" /></Field>
          <Field label={tr('common.subject')}><Select name="classSubjectId" required options={d.classSubjects.map(cs => ({ value: String(cs.id), label: `${cs.class_name} · ${cs.subject_name}` }))} /></Field>
          <Field label={tr('ex.duration')}><Input name="durationMin" type="number" className="num" defaultValue="180" /></Field>
          <p className="text-sm">{tr('ex.blueprint')}</p>
          {(['mcq', 'short', 'long'] as const).map(kind => (
            <div key={kind} className="grid grid-cols-2 gap-3">
              <Field label={`${kind} · ${tr('ex.questionCount')}`}><Input name={`${kind}Count`} type="number" className="num" defaultValue="0" /></Field>
              <Field label={`${kind} · ${tr('ex.marks')}`}><Input name={`${kind}Marks`} type="number" className="num" defaultValue={kind === 'mcq' ? '1' : '4'} /></Field>
            </div>))}
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'online'} onClose={() => setDrawer(null)} title={tr('ex.newOnline')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/exams/online', { method: 'POST', json: { sectionId: f.sectionId, classSubjectId: f.classSubjectId, paperId: f.paperId || null, title: f.title, startsAt: f.startsAt.replace('T', ' ') + ':00', endsAt: f.endsAt.replace('T', ' ') + ':00', durationMin: Number(f.durationMin || 30), totalMarks: Number(f.totalMarks || 20), autoGrade: f.autoGrade === 'on' } })); }}>
          <Field label={tr('common.name')}><Input name="title" required placeholder="Weekly MCQ 5" /></Field>
          <Field label={tr('common.section')}><Select name="sectionId" required options={d.sections.map(s => ({ value: String(s.id), label: `${s.class_name} ${s.name}` }))} /></Field>
          <Field label={tr('common.subject')}><Select name="classSubjectId" required options={d.classSubjects.map(cs => ({ value: String(cs.id), label: `${cs.class_name} · ${cs.subject_name}` }))} /></Field>
          <Field label={tr('ex.paper')} hint={tr('ex.noPaper')}><Select name="paperId" placeholder="—" options={d.papers.map(p => ({ value: String(p.id), label: `${p.title} (${p.questions})` }))} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('ex.starts')}><Input name="startsAt" type="datetime-local" required /></Field><Field label={tr('ex.ends')}><Input name="endsAt" type="datetime-local" required /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('ex.duration')}><Input name="durationMin" type="number" className="num" defaultValue="30" /></Field><Field label={tr('ex.total')}><Input name="totalMarks" type="number" className="num" defaultValue="20" /></Field></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="autoGrade" defaultChecked /> {tr('ex.autoGrade')}</label>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
