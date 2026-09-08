import { nowSql } from '@pathshala/db';
import type { AcademicService } from './academic.js';
import type { AttendanceService } from './attendance.js';
import type { FeesService } from './fees.js';
import type { AdmissionsService } from './admissions.js';
import type { AssessmentService } from './assessment.js';
import type { TransportService } from './transport.js';
import type { AnalyticsService } from './analytics.js';
import type { PlatformService } from './platform.js';
import type { TaskService } from '../tasks.js';
import type { ApprovalService } from '../approvals.js';
import { localDayRange } from '../util.js';

export interface OverviewOptions { onDate?: string; months?: number; days?: number }

export interface SectionToday {
  sectionId: string; section: string; className: string; teacher: string | null;
  students: number; present: number; absent: number; pct: number | null;
}
export interface OverviewToday {
  on: string;
  academicYear: { id: string; name: string } | null;
  term: { id: string; name: string } | null;
  attendance: {
    marked: boolean;
    students: { present: number; absent: number; late: number; excused: number; total: number; pct: number | null };
    staff: { present: number; absent: number; late: number; total: number; pct: number | null };
    smsSent: number;
    sections: SectionToday[];
  };
  fees: {
    month: string; invoiced: number; collected: number; collectedToday: number;
    outstanding: number; overdue: number; overdueInvoices: number;
    byMonth: { month: string; invoiced: number; collected: number }[];
    lastBatch: { at: string; invoices: number; automatic: boolean } | null;
  };
  approvals: { total: number; items: { id: string; kind: string; title: string; detail: string | null; requestedBy: string | null; at: string }[] };
  tasks: { total: number; items: { id: string; title: string; assignee: string | null; due: string | null; priority: string }[] };
  admissions: { newApplications: number; newEnquiries: number; campaign: string | null };
  exams: { next: { id: string; name: string; startDate: string; daysAway: number } | null; marksPending: number; resultsWaiting: number };
  automation: { runsToday: number; failedToday: number; feed: { id: string; kind: 'rule' | 'system' | 'cron'; title: string; at: string; status: string; error: string | null }[] };
  transport: { running: number; total: number; note: string | null };
  trend: { day: string; attendancePct: number | null; collected: number }[];
  timeline: { at: string; title: string; kind: 'done' | 'scheduled'; source: string }[];
}

/** One decimal place, and `null` where there is nothing to divide by. */
function pctOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part * 1000) / whole) / 10 : null;
}

/**
 * The last `count` months ending with the month `on` falls in, oldest first, each carrying the UTC
 * window its own local month occupies. Timestamps are stored in UTC and a school's month does not
 * start at midnight UTC, so a chart that bucketed on the raw string would put the first six hours of
 * every Bangladeshi month into the one before it.
 */
function monthWindows(on: string, count: number, tz: string) {
  const year = Number(on.slice(0, 4)), month = Number(on.slice(5, 7));
  const out: { month: string; from: string; to: string }[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const t = year * 12 + (month - 1) - back;
    const y = Math.floor(t / 12), m = (t % 12) + 1;
    const label = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push({ month: label, from: localDayRange(`${label}-01`, tz).from, to: localDayRange(`${label}-${String(lastDay).padStart(2, '0')}`, tz).to });
  }
  return out;
}

/**
 * The morning, in one answer.
 *
 * A head teacher opens this software to find out five things before assembly: whether the registers
 * were marked and whose guardians heard about it, what came in against what was billed, who is
 * waiting on a decision, what the machine did by itself overnight, and which sections are short.
 * Every one of those numbers already exists in the database and no single call gathered them, so the
 * dashboard showed four counts and a feed — true, and no use to anybody.
 *
 * Three rules shape what comes back.
 *
 * **A number nobody has entered is not zero.** `pct` is null until a register is marked, `next` is
 * null until an exam is scheduled, `lastBatch` is null until something has been billed. The page can
 * say "not marked yet"; it must never be able to say "0% present" because a teacher has not opened
 * the register, which is a sentence that ends with somebody being asked why attendance collapsed.
 *
 * **Speed is the feature.** `node:sqlite` is synchronous, so a slow dashboard is not a slow page —
 * it is every other request on the host queued behind it. This runs in twenty-two set-based
 * queries whatever the size of the school: nothing here loops over sections or students, the trend
 * comes off `kpi_daily` rather than recomputing a month of registers, and the whole answer is held
 * for thirty seconds so a refresh, an SSR pass and a poll do not each pay for it.
 *
 * **It owns none of this.** Every figure is asked of the module that owns the table — academic,
 * attendance, fees, admissions, assessment, transport, tasks, approvals, analytics, platform — and
 * where a service had no method for the question, the method was added there rather than the query
 * being written here against somebody else's rows.
 */
export class OverviewService {
  private static readonly TTL_MS = 30_000;
  private cache = new Map<string, { at: number; value: Promise<OverviewToday> }>();

  constructor(
    private academic: AcademicService, private attendance: AttendanceService, private fees: FeesService,
    private admissions: AdmissionsService, private assessment: AssessmentService, private transport: TransportService,
    private tasks: TaskService, private approvals: ApprovalService, private analytics: AnalyticsService,
    private platform: PlatformService,
  ) {}

  /**
   * Everything the console's front page shows, for the school's own today.
   *
   * Cached for thirty seconds per school and per day. The cached entry is the *promise*, so two
   * requests that arrive together share one trip to the database rather than racing to make the same
   * one twice. A failure is never cached.
   */
  async today(schoolId: string, opts: OverviewOptions = {}): Promise<OverviewToday> {
    const months = Math.min(24, Math.max(1, opts.months ?? 9));
    const days = Math.min(120, Math.max(1, opts.days ?? 30));
    const key = `${schoolId}|${opts.onDate ?? 'auto'}|${months}|${days}`;
    const now = Date.now();
    for (const [k, v] of this.cache) if (now - v.at > OverviewService.TTL_MS) this.cache.delete(k);
    const hit = this.cache.get(key);
    if (hit) return hit.value;
    const value = this.gather(schoolId, opts.onDate ?? null, months, days).catch(e => { this.cache.delete(key); throw e; });
    this.cache.set(key, { at: now, value });
    return value;
  }

  /** Drops what is cached — for a test, or for a page that has just changed what it is about to read. */
  forget(schoolId?: string) {
    if (!schoolId) { this.cache.clear(); return; }
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${schoolId}|`)) this.cache.delete(k);
  }

  private async gather(schoolId: string, onDate: string | null, months: number, days: number): Promise<OverviewToday> {
    // the school's own day decides everything else, so it is the one read that cannot be parallelised
    const day = await this.attendance.schoolDay(schoolId, onDate);
    const range = { from: day.from, to: day.to };
    const period = await this.academic.currentPeriod(schoolId, day.on);
    const windows = monthWindows(day.on, months, day.timezone);

    const [totals, bySection, roster, fees, approvals, tasks, admissions, exams, automation, transport, trend, calendar] = await Promise.all([
      this.attendance.dayTotals(schoolId, day.on, range),
      this.attendance.dayBySection(schoolId, day.on),
      period.year ? this.academic.sectionRoster(schoolId, period.year.id) : Promise.resolve([]),
      this.fees.overview(schoolId, { windows, today: day.on, dayRange: range }),
      this.approvals.pendingSummary(schoolId, 6),
      this.tasks.openSummary(schoolId, 6),
      this.admissions.todayOverview(schoolId, range),
      this.assessment.overview(schoolId, day.on),
      this.platform.activity(schoolId, range, 8),
      this.transport.todaySummary(schoolId, day.on),
      this.analytics.trend(schoolId, { to: day.on, days }),
      this.academic.calendar(schoolId, day.on, day.on),
    ]);

    // the roll comes from the roster and the marks from the register: joining the two in SQL would
    // have counted every enrolment once per mark, and doing it per section would have been a query
    // for every class in the school on every page load
    const marks = new Map(bySection.map(r => [String(r.section_id), r]));
    const sections: SectionToday[] = roster.map(r => {
      const m = marks.get(String(r.section_id));
      const present = Number(m?.present ?? 0), absent = Number(m?.absent ?? 0), late = Number(m?.late ?? 0), marked = Number(m?.marked ?? 0);
      const teacher = r.teacher_first_name ? `${r.teacher_first_name} ${r.teacher_last_name ?? ''}`.trim() : null;
      return {
        sectionId: String(r.section_id), section: String(r.section), className: String(r.class_name), teacher,
        students: Number(r.students ?? 0), present, absent, pct: pctOf(present + late, marked),
      };
    });

    const at = nowSql();
    const timeline = [
      // a calendar event has a date and no time, so it sits at the head of the day it belongs to
      ...calendar.map(e => ({ at: day.from, title: String(e.title), kind: 'scheduled' as const, source: 'calendar' })),
      ...automation.feed.map(f => ({ at: f.at, title: f.title, kind: 'done' as const, source: `automation.${f.kind}` })),
      ...automation.upcoming.filter(u => u.at > at).map(u => ({ at: u.at, title: u.jobKey, kind: 'scheduled' as const, source: 'scheduler' })),
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, 20);

    return {
      on: day.on,
      academicYear: period.year,
      term: period.term,
      attendance: {
        // "marked" is one register having been marked, not the whole school's: the page needs to know
        // whether to show a figure at all, and the section rows say who is still missing
        marked: totals.students.total > 0,
        students: totals.students, staff: totals.staff, smsSent: totals.smsSent, sections,
      },
      fees,
      approvals, tasks, admissions, exams,
      automation: { runsToday: automation.runsToday, failedToday: automation.failedToday, feed: automation.feed },
      transport,
      trend,
      timeline,
    };
  }
}
