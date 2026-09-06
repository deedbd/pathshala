import { useState } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/calendar';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Select, Textarea, api, formatDate, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id;
  const from = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10); const to = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
  return { locale: (user.locale as Locale) || context.locale, events: await context.app.academic.calendar(sid, from, to), weeklyOffs: await context.app.academic.weeklyOffs(sid), year: await context.app.academic.currentYear(sid) };
}
export function meta() { return [{ title: 'Pathshala — Calendar' }]; }

export default function Calendar() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [open, setOpen] = useState(false); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setOpen(false); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const create = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/academic/calendar', { method: 'POST', json: { academicYearId: d.year ? String(d.year.id) : null, title: f.title, eventType: f.eventType, startDate: f.startDate, endDate: f.endDate || f.startDate, description: f.description || null } })); };
  const toggleOff = (day: number) => run(() => api('/api/academic/weekly-offs', { method: 'PUT', json: { days: d.weeklyOffs.includes(day) ? d.weeklyOffs.filter(x => x !== day) : [...d.weeklyOffs, day].sort() } }));
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl">{tr('cal.title')}</h1></div><Button size="sm" onClick={() => setOpen(true)}>{tr('cal.new')}</Button></div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      <div className="card mt-4 flex flex-wrap items-center gap-2 p-3"><span className="text-sm" style={{ color: 'var(--muted)' }}>{tr('cal.weekend')}:</span>{[0, 1, 2, 3, 4, 5, 6].map(day => <button key={day} className={`chip ${d.weeklyOffs.includes(day) ? 'chip-bad' : ''}`} onClick={() => toggleOff(day)} disabled={busy}>{t(`day.${day}` as never, d.locale)}</button>)}</div>
      <div className="mt-4"><DataTable locale={d.locale} rows={d.events} columns={[{ key: 'start_date', label: tr('common.date'), render: r => r.start_date === r.end_date ? formatDate(String(r.start_date), d.locale) : `${formatDate(String(r.start_date), d.locale)} – ${formatDate(String(r.end_date), d.locale)}` }, { key: 'title', label: tr('common.name') }, { key: 'event_type', label: 'Type', render: r => <Chip status={Number(r.is_holiday) ? 'absent' : 'scheduled'}>{String(r.event_type)}</Chip> }, { key: 'description', label: '' }]} /></div>
      <Drawer open={open} onClose={() => setOpen(false)} title={tr('cal.new')}>
        <form className="grid gap-3" onSubmit={create}>
          <Field label={tr('common.name')}><Input name="title" required /></Field>
          <Field label="Type"><Select name="eventType" options={[{ value: 'holiday', label: tr('cal.holiday') }, { value: 'vacation', label: 'Vacation' }, { value: 'exam', label: 'Exam' }, { value: 'event', label: 'Event' }, { value: 'ptm', label: 'PTM' }, { value: 'deadline', label: 'Deadline' }, { value: 'meeting', label: 'Meeting' }]} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Start"><Input name="startDate" type="date" required /></Field><Field label="End"><Input name="endDate" type="date" /></Field></div>
          <Field label="Notes"><Textarea name="description" rows={2} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
