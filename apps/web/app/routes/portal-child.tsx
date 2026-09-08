import { redirect, useLoaderData } from 'react-router';
import type { Route } from './+types/portal-child';
import { formatDate, formatMoney, formatNumber, t, type Locale } from '@pathshala/ui';
import { ctxPath, requireTenantUser, useTenantPath } from '~/tenant';

export async function loader({ context, request, params }: Route.LoaderArgs) {
  if (!context.user) throw redirect(`${ctxPath(context, '/login')}?next=${encodeURIComponent(new URL(request.url).pathname)}`);
  const u = requireTenantUser(context, context.user, request);
  const [data, summary, offs] = await Promise.all([
    context.app.portal.child(u.school_id, u.id, params.id),
    context.app.portal.childSummary(u.school_id, u.id, params.id),
    context.app.academic.weeklyOffs(u.school_id),
  ]);
  return { locale: (u.locale as Locale) || context.locale, ...data, summary, days: [0, 1, 2, 3, 4, 5, 6].filter(x => !offs.includes(x)), today: new Date().getUTCDay() };
}
export function meta() { return [{ title: 'Pathshala — Child' }]; }

export default function PortalChild() {
  const d = useLoaderData<typeof loader>(); const L = d.locale; const tr = (k: Parameters<typeof t>[0]) => t(k, L); const tp = useTenantPath();
  const c = d.child;
  const byDay = new Map<number, typeof d.timetable>(); for (const s of d.timetable) byDay.set(Number(s.day_of_week), [...(byDay.get(Number(s.day_of_week)) ?? []), s]);
  const subj = (g: Record<string, unknown>) => L === 'bn' && g.subject_name_bn ? String(g.subject_name_bn) : String(g.subject_name ?? '—');
  return (
    <div lang={L} className="mx-auto max-w-md pb-20">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b px-4 py-3" style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}><a href={tp('/portal')} className="btn btn-ghost btn-sm">‹</a><div><div className="display text-base">{L === 'bn' && c.name_bn ? String(c.name_bn) : `${c.first_name} ${c.last_name ?? ''}`}</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{String(c.class_name ?? '')} {String(c.section_name ?? '')} · {tr('stu.roll')} <span className="num">{String(c.current_roll_no ?? '—')}</span> · <span className="num">{String(c.admission_no)}</span></div></div></header>
      <main className="px-4">
        {d.classTeacher && <div className="card mt-4 p-3 text-sm"><span style={{ color: 'var(--muted)' }}>{tr('portal.classTeacher')}: </span>{String(d.classTeacher.first_name)} {String(d.classTeacher.last_name ?? '')}{d.classTeacher.phone ? <> · <a className="num" href={`tel:${d.classTeacher.phone}`}>{String(d.classTeacher.phone)}</a></> : null}</div>}
        {d.substitutions.length > 0 && <div className="banner banner-warn mt-4 text-sm">{d.substitutions.map((s, i) => <div key={i}>{formatDate(String(s.on_date), L)} · {String(s.period_name)}: {s.sub_first ? `${s.sub_first} ${s.sub_last ?? ''}` : '—'}</div>)}</div>}
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="card p-3"><div className="text-xs" style={{ color: 'var(--muted)' }}>{tr('portal.attendance')}</div><div className="num text-lg">{d.summary.attendance.pct == null ? '—' : `${formatNumber(d.summary.attendance.pct, L)}%`}</div></div>
          <div className="card p-3"><div className="text-xs" style={{ color: 'var(--muted)' }}>{tr('portal.due')}</div><div className="num text-lg">{formatMoney(d.summary.dues, L)}</div></div>
          <div className="card p-3"><div className="text-xs" style={{ color: 'var(--muted)' }}>{tr('portal.homework')}</div><div className="num text-lg">{formatNumber(d.summary.homework.filter(h => !h.submission_status).length, L)}</div></div>
        </div>

        {d.summary.results.length > 0 && <>
          <h2 className="mt-6 text-base">{tr('portal.results')}</h2>
          <ul className="card mt-2 divide-y text-sm" style={{ borderColor: 'var(--line)' }}>
            {d.summary.results.map((r, i) => (
              <li key={i} className="flex items-center justify-between p-3">
                <span><span className="block font-medium">{String(r.exam_name)}</span><span className="block text-xs" style={{ color: 'var(--muted)' }}>{tr('ex.rank')} {String(r.rank_in_class ?? '—')} · {formatNumber(Number(r.percentage ?? 0), L)}%</span></span>
                <span className="text-right"><span className="num block font-medium">{tr('ex.gpa')} {formatNumber(Number(r.gpa ?? 0), L)}</span>{r.report_card_url ? <a className="text-xs underline" href={String(r.report_card_url)}>{tr('ex.reportCard')}</a> : null}</span>
              </li>
            ))}
          </ul>
        </>}

        {d.summary.homework.length > 0 && <>
          <h2 className="mt-6 text-base">{tr('portal.homework')}</h2>
          <ul className="card mt-2 divide-y text-sm" style={{ borderColor: 'var(--line)' }}>
            {d.summary.homework.map(h => (
              <li key={String(h.id)} className="flex items-center justify-between p-3">
                <span>{String(h.title)}</span>
                <span className="text-xs" style={{ color: 'var(--muted)' }}>{h.submission_status ? tr('portal.handedIn') : formatDate(String(h.due_at).slice(0, 10), L)}</span>
              </li>
            ))}
          </ul>
        </>}

        {(d.summary.books.length > 0 || d.summary.transport || d.summary.hostel) && <>
          <h2 className="mt-6 text-base">{tr('portal.school')}</h2>
          <ul className="card mt-2 divide-y text-sm" style={{ borderColor: 'var(--line)' }}>
            {d.summary.books.map((b, i) => <li key={`b${i}`} className="flex items-center justify-between p-3"><span>{String(b.title)}</span><span className="text-xs" style={{ color: String(b.status) === 'overdue' ? 'var(--bad)' : 'var(--muted)' }}>{tr('ops.due')} {formatDate(String(b.due_at).slice(0, 10), L)}</span></li>)}
            {d.summary.transport && <li className="flex items-center justify-between p-3"><span>{String(d.summary.transport.route_name)} · {String(d.summary.transport.stop_name)}</span><span className="num text-xs" style={{ color: 'var(--muted)' }}>{String(d.summary.transport.pickup_time ?? '').slice(0, 5)}</span></li>}
            {d.summary.hostel && <li className="flex items-center justify-between p-3"><span>{String(d.summary.hostel.hostel_name)}</span><span className="num text-xs" style={{ color: 'var(--muted)' }}>{tr('ops.rooms')} {String(d.summary.hostel.room_no)} · {String(d.summary.hostel.bed_no)}</span></li>}
          </ul>
        </>}

        {d.summary.documents.length > 0 && <>
          <h2 className="mt-6 text-base">{tr('doc.title')}</h2>
          <ul className="card mt-2 divide-y text-sm" style={{ borderColor: 'var(--line)' }}>
            {d.summary.documents.map((doc, i) => <li key={`d${i}`} className="flex items-center justify-between p-3"><span>{String(doc.doc_type)} <span className="num text-xs" style={{ color: 'var(--muted)' }}>{String(doc.document_no)}</span></span><a className="text-xs underline" href={`/verify/${doc.verification_code}`}>{tr('doc.verify')}</a></li>)}
          </ul>
        </>}

        <h2 className="mt-6 text-base">{tr('portal.timetable')}</h2>
        {d.timetable.length === 0 ? <div className="card mt-2 p-4 text-sm" style={{ color: 'var(--muted)' }}>—</div> : <div className="mt-2 grid gap-2">{d.days.map(day => <details key={day} className="card" open={day === d.today}><summary className="flex cursor-pointer items-center justify-between px-3 py-2 font-medium">{t(`day.${day}` as never, L)}{day === d.today && <span className="chip chip-accent">{tr('portal.today')}</span>}</summary><ul className="divide-y px-3 pb-2 text-sm" style={{ borderColor: 'var(--line)' }}>{(byDay.get(day) ?? []).map(s => <li key={String(s.id)} className="flex items-center gap-3 py-2"><span className="num w-24 text-xs" style={{ color: 'var(--muted)' }}>{String(s.start_time).slice(0, 5)}–{String(s.end_time).slice(0, 5)}</span><span className="flex-1"><span className="block font-medium">{subj(s)}</span><span className="block text-xs" style={{ color: 'var(--muted)' }}>{s.teacher_first ? `${s.teacher_first} ${s.teacher_last ?? ''}` : ''}{s.room_name ? ` · ${s.room_name}` : ''}</span></span></li>)}{(byDay.get(day) ?? []).length === 0 && <li className="py-2 text-xs" style={{ color: 'var(--muted)' }}>—</li>}</ul></details>)}</div>}
        <h2 className="mt-6 text-base">{tr('portal.events')}</h2>
        <ul className="card mt-2 divide-y text-sm" style={{ borderColor: 'var(--line)' }}>{d.events.map((e, i) => <li key={i} className="flex items-center justify-between p-3"><span>{String(e.title)}{Number(e.is_holiday) ? <span className="chip chip-bad ml-2">{tr('cal.holiday')}</span> : null}</span><span className="text-xs" style={{ color: 'var(--muted)' }}>{formatDate(String(e.start_date), L)}</span></li>)}{d.events.length === 0 && <li className="p-3 text-xs" style={{ color: 'var(--muted)' }}>—</li>}</ul>
        <h2 className="mt-6 text-base">{tr('portal.notices')}</h2>
        <ul className="card mt-2 divide-y text-sm" style={{ borderColor: 'var(--line)' }}>{d.notices.slice(0, 5).map(n => <li key={String(n.id)} className="p-3"><div className="font-medium">{String(n.title)}</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{formatDate(String(n.publish_at), L)}</div></li>)}</ul>
      </main>
      <nav className="fixed inset-x-0 bottom-0 mx-auto flex max-w-md justify-around border-t py-2 text-xs" style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}><a href={tp('/portal')}>{tr('portal.children')}</a><a href={tp('/portal#notices')}>{tr('portal.notices')}</a><a href={tp('/site')}>{tr('web.title')}</a></nav>
    </div>
  );
}
