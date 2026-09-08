import { useEffect, useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/teach';
import { Banner, Button, Chip, api, formatDate, t, type Locale } from '@pathshala/ui';
import { requireTenantUser, useTenantPath } from '~/tenant';

type Status = 'present' | 'absent' | 'late' | 'excused';

/** Teacher PWA v0: today's periods, one-tap attendance, homework, and substitutions assigned to me. */
export async function loader({ context, request }: Route.LoaderArgs) {
  // a teacher is staff, so this follows the console's rule and not the portal's: no session, no page
  if (!context.user) throw new Response('Not found', { status: 404 });
  const u = requireTenantUser(context, context.user, request); const url = new URL(request.url);
  const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
  const staff = await context.app.db.findOne<{ id: string; first_name: string }>('staff', { school_id: u.school_id, user_id: u.id });
  if (!staff) return { locale: (u.locale as Locale) || context.locale, staff: null, date, today: [], sections: [], subs: [], register: null, sectionId: null, school: null };
  const year = await context.app.academic.currentYear(u.school_id);
  const version = year ? await context.app.timetable.publishedVersion(u.school_id, String(year.id)) : null;
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  const grid = version ? await context.app.timetable.teacherGrid(u.school_id, String(version.id), staff.id) : [];
  const sections = await context.app.db.query<{ id: string; name: string; class_name: string }>(`SELECT DISTINCT sec.id, sec.name, c.name AS class_name, c.numeric_level FROM section_subject_teachers t JOIN sections sec ON sec.id = t.section_id JOIN classes c ON c.id = sec.class_id WHERE t.school_id = ? AND t.teacher_id = ? ORDER BY c.numeric_level, sec.name`, [u.school_id, staff.id]);
  const sectionId = url.searchParams.get('sectionId') ?? (sections[0]?.id ?? null);
  const [register, subs, school] = await Promise.all([
    sectionId ? context.app.attendance.register(u.school_id, sectionId, date) : null,
    context.app.db.query(`SELECT s.id, s.on_date, s.status, p.name AS period_name, sec.name AS section_name, c.name AS class_name FROM timetable_substitutions s JOIN timetable_slots ts ON ts.id = s.slot_id JOIN periods p ON p.id = ts.period_id JOIN sections sec ON sec.id = ts.section_id JOIN classes c ON c.id = sec.class_id WHERE s.school_id = ? AND s.substitute_teacher_id = ? AND s.on_date >= ? ORDER BY s.on_date, p.sequence LIMIT 10`, [u.school_id, staff.id, date]),
    context.app.db.findOne<{ name: string; name_bn: string | null }>('schools', { id: u.school_id }),
  ]);
  return { locale: (u.locale as Locale) || context.locale, staff, date, today: grid.filter(g => Number(g.day_of_week) === dow), sections, subs, register, sectionId, school };
}
export function meta() { return [{ title: 'Pathshala — My classes' }]; }

export default function Teach() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams(); const tp = useTenantPath();
  const L = d.locale; const tr = (k: Parameters<typeof t>[0]) => t(k, L);
  const [marks, setMarks] = useState<Record<string, Status>>({});
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [saved, setSaved] = useState(false);
  const [homework, setHomework] = useState('');
  useEffect(() => { const init: Record<string, Status> = {}; for (const s of d.register?.students ?? []) if (s.status) init[String(s.student_id)] = String(s.status) as Status; setMarks(init); setSaved(false); }, [d.register]);
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set(k, v); setSp(n); };
  const students = d.register?.students ?? [];
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const save = () => run(async () => { await api('/api/attendance/mark', { method: 'POST', json: { sectionId: d.sectionId, onDate: d.date, marks: students.map(s => ({ studentId: String(s.student_id), status: marks[String(s.student_id)] ?? 'present' })) } }); setSaved(true); });
  const absent = Object.values(marks).filter(s => s === 'absent').length;

  if (!d.staff) return <main className="mx-auto max-w-md p-6"><Banner kind="warn">This account is not linked to a staff record.</Banner></main>;
  return (
    <div lang={L} className="mx-auto max-w-md pb-20">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b px-4 py-3" style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}>
        <div><div className="text-xs" style={{ color: 'var(--accent)' }}>{tr('app.name')}</div><div className="display text-base">{tr('teach.title')}</div></div>
        <a href={tp('/logout')} className="btn btn-ghost btn-sm">{tr('nav.logout')}</a>
      </header>
      <main className="px-4">
        {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
        {saved && <div className="mt-4"><Banner kind="ok">{tr('att.saved')}</Banner></div>}

        <section className="mt-4">
          <h2 className="text-base">{tr('teach.today')}</h2>
          <ul className="card mt-2 divide-y text-sm" style={{ borderColor: 'var(--line)' }}>
            {d.today.map((g, i) => <li key={i} className="flex items-center gap-3 p-3"><span className="num w-24 text-xs" style={{ color: 'var(--muted)' }}>{String(g.start_time).slice(0, 5)}–{String(g.end_time).slice(0, 5)}</span><span className="flex-1"><span className="block font-medium">{String(g.subject_name ?? '—')}</span><span className="block text-xs" style={{ color: 'var(--muted)' }}>{String(g.class_name)} {String(g.section_name)}{g.room_name ? ` · ${g.room_name}` : ''}</span></span></li>)}
            {d.today.length === 0 && <li className="p-3 text-xs" style={{ color: 'var(--muted)' }}>—</li>}
          </ul>
        </section>

        <section className="mt-6">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base">{tr('teach.markNow')}</h2>
            <select className="input max-w-[150px]" value={d.sectionId ?? ''} onChange={e => setParam('sectionId', e.target.value)}>{d.sections.map(s => <option key={s.id} value={s.id}>{s.class_name} {s.name}</option>)}</select>
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs"><span className="chip chip-bad">{tr('att.absent')} {absent}</span><span className="chip chip-ok">{tr('att.present')} {students.length - absent}</span><Button size="sm" variant="secondary" onClick={() => setMarks(Object.fromEntries(students.map(s => [String(s.student_id), 'present' as Status])))}>{tr('att.allPresent')}</Button></div>
          <ul className="card mt-2 divide-y" style={{ borderColor: 'var(--line)' }}>
            {students.map(s => { const id = String(s.student_id); const cur = marks[id] ?? 'present'; return (
              <li key={id} className="flex items-center gap-2 p-2 text-sm">
                <span className="num w-8 text-xs" style={{ color: 'var(--muted)' }}>{String(s.current_roll_no ?? '')}</span>
                <span className="flex-1 truncate">{L === 'bn' && s.name_bn ? String(s.name_bn) : `${s.first_name} ${s.last_name ?? ''}`}</span>
                <button className="chip" style={{ background: cur === 'present' ? 'var(--ok)' : 'var(--surface-2)', color: cur === 'present' ? '#fff' : 'var(--muted)' }} onClick={() => setMarks(m => ({ ...m, [id]: 'present' }))}>{tr('att.present').slice(0, 4)}</button>
                <button className="chip" style={{ background: cur === 'absent' ? 'var(--bad)' : 'var(--surface-2)', color: cur === 'absent' ? '#fff' : 'var(--muted)' }} onClick={() => setMarks(m => ({ ...m, [id]: 'absent' }))}>{tr('att.absent').slice(0, 4)}</button>
                <button className="chip" style={{ background: cur === 'late' ? 'var(--warn)' : 'var(--surface-2)', color: cur === 'late' ? '#fff' : 'var(--muted)' }} onClick={() => setMarks(m => ({ ...m, [id]: 'late' }))}>{tr('att.late').slice(0, 4)}</button>
              </li>); })}
            {students.length === 0 && <li className="p-3 text-xs" style={{ color: 'var(--muted)' }}>—</li>}
          </ul>
          <Button className="mt-3 w-full" onClick={save} disabled={busy || !d.sectionId || !students.length}>{tr('att.save')}</Button>
        </section>

        <section className="mt-6">
          <h2 className="text-base">{tr('dia.homework')}</h2>
          <form className="card mt-2 grid gap-2 p-3" onSubmit={e => { e.preventDefault(); if (!homework.trim() || !d.sectionId) return; run(async () => { await api('/api/diary', { method: 'POST', json: { sectionId: d.sectionId, onDate: d.date, entryType: 'homework', body: homework } }); setHomework(''); }); }}>
            <textarea className="input" rows={3} value={homework} onChange={e => setHomework(e.target.value)} placeholder={tr('dia.homework')} />
            <Button disabled={busy || !homework.trim()}>{tr('dia.send')}</Button>
          </form>
        </section>

        {d.subs.length > 0 && <section className="mt-6">
          <h2 className="text-base">{tr('teach.subs')}</h2>
          <ul className="card mt-2 divide-y text-sm" style={{ borderColor: 'var(--line)' }}>{d.subs.map(s => <li key={String(s.id)} className="flex items-center justify-between p-3"><span>{formatDate(String(s.on_date), L)} · {String(s.period_name)} · {String(s.class_name)} {String(s.section_name)}</span><Chip status={String(s.status) === 'suggested' ? 'pending' : String(s.status)}>{String(s.status)}</Chip></li>)}</ul>
        </section>}
      </main>
      <nav className="fixed inset-x-0 bottom-0 mx-auto flex max-w-md justify-around border-t py-2 text-xs" style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}>
        <a href={tp('/teach')} style={{ color: 'var(--accent)' }}>{tr('teach.title')}</a><a href={tp('/chat')}>{tr('chat.title')}</a><a href={tp('/dashboard')}>{tr('nav.dashboard')}</a>
      </nav>
      <script dangerouslySetInnerHTML={{ __html: `if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{});}` }} />
    </div>
  );
}
