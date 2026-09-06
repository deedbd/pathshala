import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/diary';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Select, Tabs, Textarea, api, formatDate, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
  const year = await context.app.academic.currentYear(sid);
  const sections = year ? await context.app.academic.sections(sid, String(year.id)) : [];
  const sectionId = url.searchParams.get('sectionId') ?? (sections[0] ? String(sections[0].id) : undefined);
  const [entries, matrix, reports, leaves, leaveTypes] = await Promise.all([
    context.app.communication.diary(sid, { sectionId, from: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10) }),
    year ? context.app.academic.classSubjects(sid, String(year.id)) : [],
    context.app.communication.dailyReports(sid, { sectionId, onDate: date }),
    context.app.attendance.leaves(sid, {}),
    context.app.db.findMany('leave_types', { school_id: sid }, { orderBy: 'audience ASC, name ASC' }),
  ]);
  return { locale: (user.locale as Locale) || context.locale, date, sections, sectionId, entries, matrix, reports, leaves, leaveTypes };
}
export function meta() { return [{ title: 'Pathshala — Diary' }]; }

export default function Diary() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'diary' | 'reports' | 'leave'>('diary');
  const [drawer, setDrawer] = useState<'entry' | 'leave' | null>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set(k, v); setSp(n); };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('dia.title')}</h1></div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={d.sectionId ?? ''} onChange={e => setParam('sectionId', e.target.value)} options={d.sections.map(s => ({ value: String(s.id), label: `${s.class_name} ${s.name}` }))} className="max-w-[200px]" />
          <Input type="date" value={d.date} onChange={e => setParam('date', e.target.value)} className="max-w-[170px]" />
          <Button size="sm" onClick={() => setDrawer('entry')}>{tr('dia.new')}</Button>
        </div>
      </div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[{ key: 'diary', label: tr('dia.title'), count: d.entries.length }, { key: 'reports', label: tr('dia.report'), count: d.reports.length }, { key: 'leave', label: tr('lv.title'), count: d.leaves.length }]} /></div>

      {tab === 'diary' && <div className="mt-4"><DataTable locale={d.locale} rows={d.entries} columns={[{ key: 'on_date', label: tr('common.date'), render: r => formatDate(String(r.on_date), d.locale) }, { key: 'class_name', label: tr('common.section'), render: r => `${r.class_name} ${r.section_name}` }, { key: 'subject_name', label: tr('common.subject') }, { key: 'entry_type', label: 'Type', render: r => <Chip status={String(r.entry_type) === 'homework' ? 'pending' : ''}>{String(r.entry_type)}</Chip> }, { key: 'body', label: tr('site.message'), render: r => String(r.body).slice(0, 120) }, { key: 'due_date', label: tr('dia.due'), render: r => r.due_date ? formatDate(String(r.due_date), d.locale) : '—' }]} /></div>}

      {tab === 'reports' && <div className="mt-4"><DataTable locale={d.locale} rows={d.reports} columns={[{ key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` }, { key: 'mood', label: tr('dia.mood') }, { key: 'nap_minutes', label: tr('dia.nap'), className: 'num' }, { key: 'notes', label: tr('dia.notes') }, { key: 'sent_at', label: tr('common.status'), render: r => <Chip status={r.sent_at ? 'sent' : 'draft'}>{r.sent_at ? 'sent' : 'draft'}</Chip> }]} /></div>}

      {tab === 'leave' && <div className="mt-4"><DataTable locale={d.locale} rows={d.leaves} toolbar={<Button size="sm" variant="secondary" onClick={() => setDrawer('leave')}>{tr('lv.apply')}</Button>}
        columns={[{ key: 'from_date', label: tr('lv.from'), render: r => formatDate(String(r.from_date), d.locale) }, { key: 'to_date', label: tr('lv.to'), render: r => formatDate(String(r.to_date), d.locale) }, { key: 'applicant', label: tr('lv.applicant'), render: r => r.staff_first ? `${r.staff_first} ${r.staff_last ?? ''}` : `${r.student_first ?? ''} ${r.student_last ?? ''}` }, { key: 'leave_type', label: tr('lv.type') }, { key: 'days', label: tr('lv.days'), className: 'num' }, { key: 'reason', label: tr('lv.reason'), render: r => String(r.reason).slice(0, 60) }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> },
          { key: 'id', label: '', render: r => String(r.status) === 'pending' ? <div className="flex gap-1"><Button size="sm" onClick={() => run(() => api(`/api/leave/${r.id}/decide`, { method: 'POST', json: { decision: 'approved' } }))}>{tr('lv.approve')}</Button><Button size="sm" variant="secondary" onClick={() => run(() => api(`/api/leave/${r.id}/decide`, { method: 'POST', json: { decision: 'rejected' } }))}>{tr('lv.reject')}</Button></div> : null }]} /></div>}

      <Drawer open={drawer === 'entry'} onClose={() => setDrawer(null)} title={tr('dia.new')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/diary', { method: 'POST', json: { sectionId: f.sectionId, onDate: f.onDate, classSubjectId: f.classSubjectId || null, entryType: f.entryType, body: f.body, dueDate: f.dueDate || null } })); }}>
          <Field label={tr('common.section')}><Select name="sectionId" required defaultValue={d.sectionId ?? ''} options={d.sections.map(s => ({ value: String(s.id), label: `${s.class_name} ${s.name}` }))} /></Field>
          <Field label={tr('common.subject')}><Select name="classSubjectId" placeholder={tr('common.none')} options={d.matrix.map(m => ({ value: String(m.id), label: `${m.class_name} · ${m.subject_name}` }))} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.date')}><Input name="onDate" type="date" required defaultValue={d.date} /></Field><Field label="Type"><Select name="entryType" options={[{ value: 'homework', label: tr('dia.homework') }, { value: 'note', label: tr('dia.note') }, { value: 'reminder', label: 'Reminder' }, { value: 'announcement', label: 'Announcement' }]} /></Field></div>
          <Field label={tr('site.message')}><Textarea name="body" required rows={4} /></Field>
          <Field label={tr('dia.due')}><Input name="dueDate" type="date" /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'leave'} onClose={() => setDrawer(null)} title={tr('lv.apply')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/leave', { method: 'POST', json: { applicantType: 'staff', leaveTypeId: f.leaveTypeId, fromDate: f.fromDate, toDate: f.toDate, reason: f.reason } })); }}>
          <Field label={tr('lv.type')}><Select name="leaveTypeId" required options={d.leaveTypes.filter(x => x.audience === 'staff').map(x => ({ value: String(x.id), label: String(x.name) }))} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('lv.from')}><Input name="fromDate" type="date" required /></Field><Field label={tr('lv.to')}><Input name="toDate" type="date" required /></Field></div>
          <Field label={tr('lv.reason')}><Textarea name="reason" required rows={3} /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
