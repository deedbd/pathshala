import { Link, useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/dashboard';
import {
  Banner, Chip, Greeting, LiveClock, TargetBars, TrendLine, api, chipClass, feedClass,
  formatDate, formatDateTime, formatMoney, formatNumber, longDate, t, type Locale,
} from '@pathshala/ui';
import { requireUser } from '~/lib';
import { useTenantPath } from '~/tenant';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const sid = user.school_id;
  const school = await context.app.db.findOne<{ name: string; name_bn: string | null; timezone: string | null }>('schools', { id: sid });
  const [today, onboarding, health] = await Promise.all([
    context.app.overview.today(sid),
    context.app.platform.onboarding(sid),
    context.app.platform.health(sid),
  ]);
  return {
    locale: (user.locale as Locale) || context.locale,
    name: user.display_name,
    school: { name: school?.name ?? '', nameBn: school?.name_bn ?? null, timeZone: String(school?.timezone ?? 'Asia/Dhaka') },
    today, onboarding, health,
    now: new Date().toISOString(),
  };
}

export function meta() { return [{ title: 'Pathshala — Dashboard' }]; }

export default function Dashboard() {
  const d = useLoaderData<typeof loader>();
  const rv = useRevalidator();
  const tp = useTenantPath();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const num = (n: number | null | undefined) => (n == null ? '—' : formatNumber(n, d.locale));
  const money = (n: number | null | undefined) => (n == null ? '—' : formatMoney(n, d.locale));
  const o = d.today;
  const att = o.attendance;
  const schoolName = d.locale === 'bn' && d.school.nameBn ? d.school.nameBn : d.school.name;

  return (
    <div>
      {/* ---------------- who, where, when ---------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl"><Greeting name={d.name} locale={d.locale} timeZone={d.school.timeZone} now={d.now} /></h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
            {longDate(new Date(d.now), d.locale, d.school.timeZone)} · {schoolName}
            {o.academicYear ? ` · ${tr('common.year')} ${o.academicYear.name}` : ''}
            {o.term ? ` · ${o.term.name}` : ''}
          </p>
        </div>
        <LiveClock locale={d.locale} timeZone={d.school.timeZone} now={d.now} />
      </div>

      {/* ---------------- the eight numbers ---------------- */}
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label={tr('dash.presentToday')}
          value={att.marked ? `${num(att.students.present + att.students.late)} / ${num(att.students.total)}` : tr('dash.notMarked')}
          foot={att.marked
            ? `${att.students.pct == null ? '—' : `${num(att.students.pct)}%`} · ${num(att.students.absent)} ${tr('dash.absent')}${att.smsSent ? ` · ${num(att.smsSent)} ${tr('dash.smsSent')}` : ''}`
            : tr('dash.notMarkedHint')}
          tone={att.students.pct != null && att.students.pct < 85 ? 'warn' : 'plain'}
          href={tp('/attendance')}
        />
        <Tile
          label={tr('dash.collectedMonth')} value={money(o.fees.collected)}
          foot={o.fees.invoiced > 0
            ? `${num(Math.round((o.fees.collected * 100) / o.fees.invoiced))}% ${tr('dash.ofInvoiced')} ${money(o.fees.invoiced)}`
            : tr('dash.nothingBilled')}
          href={tp('/fees')}
        />
        <Tile
          label={tr('dash.outstanding')} value={money(o.fees.outstanding)}
          foot={`${money(o.fees.overdue)} ${tr('dash.overdue')} · ${num(o.fees.overdueInvoices)} ${tr('fee.invoices').toLowerCase()}`}
          tone={o.fees.overdue > 0 ? 'warn' : 'plain'} href={tp('/fees')}
        />
        <Tile
          label={tr('dash.staffPresent')}
          value={att.staff.total > 0 ? `${num(att.staff.present + att.staff.late)} / ${num(att.staff.total)}` : tr('dash.notMarked')}
          foot={att.staff.total > 0 ? `${num(att.staff.late)} ${tr('dash.late')} · ${num(att.staff.absent)} ${tr('dash.absent')}` : tr('dash.notMarkedHint')}
          href={tp('/attendance')}
        />
        <Tile label={tr('dash.pendingApprovals')} value={num(o.approvals.total)} foot={o.approvals.items.map(i => i.kind).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4).join(', ') || tr('dash.nothingWaiting')} href={tp('/automation')} />
        <Tile label={tr('dash.newApplications')} value={num(o.admissions.newApplications)} foot={`${o.admissions.campaign ?? tr('dash.noCampaign')} · ${num(o.admissions.newEnquiries)} ${tr('dash.enquiries')}`} href={tp('/admissions')} />
        <Tile label={tr('dash.automationToday')} value={num(o.automation.runsToday)} foot={o.automation.failedToday ? `${num(o.automation.failedToday)} ${tr('dash.failed')}` : tr('dash.allClean')} tone={o.automation.failedToday ? 'bad' : 'auto'} href={tp('/automation')} />
        <Tile label={tr('dash.busesRunning')} value={o.transport.total > 0 ? `${num(o.transport.running)} / ${num(o.transport.total)}` : '—'} foot={o.transport.note ?? tr('dash.noTrips')} href={tp('/operations')} />
      </div>

      {/* ---------------- two charts ---------------- */}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <section className="card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base">{tr('dash.attendanceTrend')}</h2>
            <Link className="text-xs underline" to={tp('/attendance')}>{tr('common.details')}</Link>
          </div>
          <div className="mt-2">
            <TrendLine
              label={tr('dash.attendanceTrend')} locale={d.locale} suffix="%" min={70} max={100}
              points={o.trend.map(r => ({ label: formatDate(r.day, d.locale, { day: 'numeric', month: 'short' }), value: r.attendancePct }))}
            />
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('dash.trendNote')}</p>
        </section>
        <section className="card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base">{tr('dash.collectionByMonth')}</h2>
            <Link className="text-xs underline" to={tp('/fees')}>{tr('fee.title')}</Link>
          </div>
          <div className="mt-2">
            <TargetBars
              label={tr('dash.collectionByMonth')} locale={d.locale}
              valueName={tr('fee.collected')} targetName={tr('dash.invoiced')}
              format={n => formatMoney(n, d.locale)}
              rows={o.fees.byMonth.map(m => ({ label: m.month.slice(5), value: m.collected, target: m.invoiced }))}
            />
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            {o.fees.lastBatch
              ? `${tr('dash.lastBatch')}: ${formatDateTime(o.fees.lastBatch.at, d.locale)} · ${num(o.fees.lastBatch.invoices)} ${tr('fee.invoices').toLowerCase()}${o.fees.lastBatch.automatic ? ` · ${tr('dash.byItself')}` : ''}`
              : tr('dash.nothingBilled')}
          </p>
        </section>
      </div>

      {/* ---------------- today, and what is waiting ---------------- */}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <section className="card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base">{tr('dash.today')}</h2>
            <Link className="text-xs underline" to={tp('/calendar')}>{tr('nav.calendar')}</Link>
          </div>
          {o.timeline.length === 0 ? <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>{tr('dash.nothingToday')}</p> : (
            <ul className="mt-2">
              {o.timeline.map((it, i) => (
                <li key={`${it.at}-${i}`} className="feed-item">
                  <span className="num text-xs" style={{ color: 'var(--muted)', minWidth: '3.5em' }}>{formatDate(it.at, d.locale, { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="flex-1 min-w-0 truncate text-sm">{it.title}</span>
                  <span className={chipClass(it.kind === 'done' ? 'completed' : 'scheduled')}>{it.kind === 'done' ? tr('dash.done') : tr('dash.scheduled')}</span>
                </li>
              ))}
            </ul>
          )}
          {o.exams.next && (
            <p className="mt-3 text-sm">
              <Link className="underline" to={tp('/exams')}>{o.exams.next.name}</Link>{' '}
              <span style={{ color: 'var(--muted)' }}>· {formatDate(o.exams.next.startDate, d.locale)} · {num(o.exams.next.daysAway)} {tr('dash.daysAway')}</span>
            </p>
          )}
          {(o.exams.marksPending > 0 || o.exams.resultsWaiting > 0) && (
            <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
              {o.exams.marksPending > 0 ? `${num(o.exams.marksPending)} ${tr('dash.marksPending')}` : ''}
              {o.exams.marksPending > 0 && o.exams.resultsWaiting > 0 ? ' · ' : ''}
              {o.exams.resultsWaiting > 0 ? `${num(o.exams.resultsWaiting)} ${tr('dash.resultsWaiting')}` : ''}
            </p>
          )}
        </section>

        <section className="card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base">{tr('dash.waitingForYou')}</h2>
            <Link className="text-xs underline" to={tp('/automation')}>{tr('dash.allApprovals')}</Link>
          </div>
          {o.approvals.items.length === 0 ? <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>{tr('dash.nothingWaiting')}</p> : (
            <ul className="mt-2">
              {o.approvals.items.map(a => (
                <li key={a.id} className="feed-item">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{a.title}{a.detail ? ` · ${a.detail}` : ''}</div>
                    <div className="text-xs" style={{ color: 'var(--muted)' }}>{a.requestedBy ?? ''}{a.requestedBy ? ' · ' : ''}{formatDateTime(a.at, d.locale)}</div>
                  </div>
                  <Link className="btn btn-secondary btn-sm" to={tp('/automation')}>{tr('dash.review')}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ---------------- what ran by itself, and what is still on somebody's list ---------------- */}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <section className="card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base">{tr('dash.recent')}</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => rv.revalidate()} disabled={rv.state !== 'idle'}>{tr('common.refresh')}</button>
          </div>
          {o.automation.feed.length === 0 ? <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>{tr('dash.empty')}</p> : (
            <ul className="mt-2">
              {o.automation.feed.map(f => (
                <li key={f.id} className="feed-item">
                  <span className={feedClass(f.kind === 'rule' ? 'rule' : f.kind === 'cron' ? 'cron' : 'system')}>{f.kind === 'rule' ? '⚙' : f.kind === 'cron' ? '⏰' : '●'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{f.title}</div>
                    <div className="text-xs" style={{ color: 'var(--muted)' }}>{formatDateTime(f.at, d.locale)}{f.error ? ` · ${f.error.slice(0, 100)}` : ''}</div>
                  </div>
                  <span className={chipClass(f.status)}>{f.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base">{tr('dash.openTasks')} · {num(o.tasks.total)}</h2>
            <Link className="text-xs underline" to={tp('/automation')}>{tr('dash.allTasks')}</Link>
          </div>
          {o.tasks.items.length === 0 ? <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>{tr('dash.noTasks')}</p> : (
            <ul className="mt-2">
              {o.tasks.items.map(task => (
                <li key={task.id} className="feed-item">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{task.title}</div>
                    <div className="text-xs" style={{ color: 'var(--muted)' }}>{task.assignee ?? tr('inst.nobody')}{task.due ? ` · ${tr('inst.due')} ${formatDate(task.due, d.locale)}` : ''}</div>
                  </div>
                  <span className={chipClass(task.priority)}>{task.priority}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ---------------- section by section ---------------- */}
      <section className="card mt-4 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base">{tr('dash.bySection')}</h2>
          <Link className="text-xs underline" to={tp('/attendance')}>{tr('common.details')}</Link>
        </div>
        {att.sections.length === 0 ? <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>{tr('dash.noSections')}</p> : (
          <div className="mt-2 overflow-x-auto">
            <table className="table">
              <thead><tr>
                <th>{tr('common.section')}</th><th>{tr('dash.classTeacher')}</th>
                <th className="num">{tr('nav.students')}</th><th className="num">{tr('dash.present')}</th>
                <th className="num">{tr('dash.absent')}</th><th className="num">{tr('dash.attendance')}</th>
              </tr></thead>
              <tbody>
                {att.sections.map(s => (
                  <tr key={s.sectionId}>
                    <td>{s.className} {s.section}</td>
                    <td>{s.teacher ?? '—'}</td>
                    <td className="num">{num(s.students)}</td>
                    <td className="num">{num(s.present)}</td>
                    <td className="num">{num(s.absent)}</td>
                    <td className="num">{s.pct == null ? <span style={{ color: 'var(--muted)' }}>{tr('dash.notMarked')}</span> : `${num(s.pct)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------------- the install itself ---------------- */}
      {!d.onboarding.complete && (
        <section className="card mt-4 p-4">
          <h2 className="text-base">{tr('dash.setUp')} · {d.onboarding.done}/{d.onboarding.total}</h2>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>{tr('dash.setUpHint')}</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {d.onboarding.steps.map(step => (
              <li key={step.key} className="flex items-center gap-2 text-sm">
                <span aria-hidden>{step.done ? '✓' : '○'}</span>
                {step.done ? <span style={{ color: 'var(--muted)' }}>{step.label}</span> : <Link to={tp(step.href)} className="underline">{step.label}</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card mt-4 p-4">
        <h2 className="text-base">{tr('dash.health')}</h2>
        <div className="mt-2 grid grid-cols-2 gap-3 text-sm lg:grid-cols-4">
          <div><div style={{ color: 'var(--muted)' }}>{tr('dash.queue')}</div><div className="num">{num(d.health.queue.queued)}{d.health.queue.failed ? ` (${num(d.health.queue.failed)} ×)` : ''}</div></div>
          <div><div style={{ color: 'var(--muted)' }}>{tr('dash.storage')}</div><div className="num">{num(d.health.storage.uploadsMb)} MB</div></div>
          <div><div style={{ color: 'var(--muted)' }}>{tr('dash.memory')}</div><div className="num">{num(d.health.memory.rssMb)} MB</div></div>
          <div><div style={{ color: 'var(--muted)' }}>{tr('dash.lastBackup')}</div><div>{d.health.lastBackup ? formatDateTime(d.health.lastBackup.at, d.locale) : <span style={{ color: 'var(--bad)' }}>{tr('dash.never')}</span>}</div></div>
        </div>
      </section>
    </div>
  );
}

/** One number, what it is, and the line underneath that says what it means. */
function Tile({ label, value, foot, tone = 'plain', href }: { label: string; value: string; foot?: string; tone?: 'plain' | 'warn' | 'bad' | 'auto'; href?: string }) {
  const colour = tone === 'warn' ? 'var(--warn)' : tone === 'bad' ? 'var(--bad)' : tone === 'auto' ? 'var(--auto)' : undefined;
  const body = (
    <div className="kpi h-full">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value num" style={colour ? { color: colour } : undefined}>{value}</div>
      {foot && <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{foot}</div>}
    </div>
  );
  return href ? <Link to={href} className="block">{body}</Link> : body;
}
