import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import { round } from './accounting.js';
import { badRequest, notFound } from '../context.js';

export type MetricKey = 'attendance_pct' | 'fees_collected' | 'fees_outstanding' | 'students_active' | 'new_admissions' | 'new_enquiries' | 'sms_sent' | 'staff_attendance_pct' | 'pass_pct';
export type RiskType = 'dropout' | 'fee_default' | 'result_decline' | 'attendance' | 'wellbeing';
export interface SaveRiskInput {
  studentId: string; riskType: RiskType; score: number; factors: Record<string, unknown>;
  notifyAbove?: number;
  /** Who is told, and in what words, when a score crosses the line for the first time. */
  announce?: { role: string; eventKey: string; title: string; body: string; channels?: ('in_app' | 'push' | 'email' | 'sms')[] } | null;
}

/**
 * Analytics: the numbers a head teacher would otherwise ask three people for, worked out from the
 * same rows those people would have counted.
 *
 * Three things keep it honest. Every metric is computed here rather than typed in, so a dashboard
 * cannot drift from the register. An anomaly is a departure from what this school normally does — a
 * fixed threshold flags a village school every day and a city school never — so the comparison is
 * against its own recent median. And a risk score always carries the reasons: a number that says
 * "78% risk of dropping out" is useless, while "missed 11 of the last 20 days, fees unpaid since
 * March, results down two grades" is something a class teacher can act on this afternoon.
 *
 * Nothing here decides anything. It puts a name in front of a person early enough to matter.
 */
export class AnalyticsService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService) {}

  // ---------- the metric catalogue ----------
  private static readonly CATALOGUE: { key: MetricKey; name: string; unit: string; warnBelow?: number; warnAbove?: number }[] = [
    { key: 'attendance_pct', name: 'Student attendance', unit: '%', warnBelow: 80 },
    { key: 'staff_attendance_pct', name: 'Staff attendance', unit: '%', warnBelow: 90 },
    { key: 'fees_collected', name: 'Fees collected', unit: 'BDT' },
    { key: 'fees_outstanding', name: 'Fees outstanding', unit: 'BDT' },
    { key: 'students_active', name: 'Students on the roll', unit: 'count' },
    { key: 'new_admissions', name: 'New admissions', unit: 'count' },
    { key: 'new_enquiries', name: 'Admission enquiries', unit: 'count' },
    { key: 'sms_sent', name: 'Messages sent', unit: 'count' },
    { key: 'pass_pct', name: 'Pass rate', unit: '%', warnBelow: 70 },
  ];
  async ensureMetrics(schoolId: string) {
    let made = 0;
    for (const m of AnalyticsService.CATALOGUE) {
      if (await this.db.findOne('metrics', { school_id: schoolId, key_name: m.key })) continue;
      await this.db.insert('metrics', { id: ulid(), school_id: schoolId, key_name: m.key, name: m.name, definition: { computedBy: 'analytics' } as never, unit: m.unit, warn_below: m.warnBelow ?? null, warn_above: m.warnAbove ?? null });
      made++;
    }
    return made;
  }
  async metrics(schoolId: string) { return this.db.findMany<Row>('metrics', { school_id: schoolId }, { orderBy: 'name ASC' }); }

  /** Every metric for one day, from the tables that hold the truth. */
  async computeDay(schoolId: string, day = nowSql().slice(0, 10)) {
    const from = `${day} 00:00:00`, to = `${day} 23:59:59`;
    const [attendance, staffAttendance, collected, outstanding, active, admissions, enquiries, sms] = await Promise.all([
      this.db.query<{ present: number; total: number }>(`SELECT SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS present, COUNT(*) AS total FROM student_attendance WHERE school_id = ? AND on_date = ?`, [schoolId, day]),
      this.db.query<{ present: number; total: number }>(`SELECT SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS present, COUNT(*) AS total FROM staff_attendance WHERE school_id = ? AND on_date = ?`, [schoolId, day]),
      this.db.query<{ v: number }>(`SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE school_id = ? AND status = 'success' AND paid_at BETWEEN ? AND ?`, [schoolId, from, to]),
      this.db.query<{ v: number }>(`SELECT COALESCE(SUM(balance), 0) AS v FROM invoices WHERE school_id = ? AND balance > 0`, [schoolId]),
      this.db.query<{ v: number }>(`SELECT COUNT(*) AS v FROM students WHERE school_id = ? AND status = 'active'`, [schoolId]),
      this.db.query<{ v: number }>(`SELECT COUNT(*) AS v FROM students WHERE school_id = ? AND admission_date = ?`, [schoolId, day]),
      this.db.query<{ v: number }>(`SELECT COUNT(*) AS v FROM admission_enquiries WHERE school_id = ? AND created_at BETWEEN ? AND ?`, [schoolId, from, to]),
      this.db.query<{ v: number }>(`SELECT COUNT(*) AS v FROM notifications WHERE school_id = ? AND channel = 'sms' AND status IN ('sent','delivered') AND created_at BETWEEN ? AND ?`, [schoolId, from, to]),
    ]);
    const pct = (r: { present: number; total: number } | undefined) => (r && Number(r.total) > 0 ? round((Number(r.present) * 100) / Number(r.total)) : null);
    const values: Partial<Record<MetricKey, number | null>> = {
      attendance_pct: pct(attendance[0]),
      staff_attendance_pct: pct(staffAttendance[0]),
      fees_collected: round(Number(collected[0]?.v ?? 0)),
      fees_outstanding: round(Number(outstanding[0]?.v ?? 0)),
      students_active: Number(active[0]?.v ?? 0),
      new_admissions: Number(admissions[0]?.v ?? 0),
      new_enquiries: Number(enquiries[0]?.v ?? 0),
      sms_sent: Number(sms[0]?.v ?? 0),
    };
    await this.ensureMetrics(schoolId);
    const catalogue = await this.metrics(schoolId);
    for (const m of catalogue) {
      const value = values[m.key_name as MetricKey];
      if (value == null) continue;
      const ex = await this.db.findOne<Row>('metric_values', { school_id: schoolId, metric_id: String(m.id), period: day, dimension: null });
      if (ex) await this.db.update('metric_values', { value }, { id: String(ex.id) });
      else await this.db.insert('metric_values', { id: ulid(), school_id: schoolId, metric_id: String(m.id), period: day, dimension: null, value });
    }
    // the daily KPI row the dashboards read, kept in step with the metrics
    const kpi = { students_active: values.students_active ?? null, attendance_pct: values.attendance_pct ?? null, staff_attendance_pct: values.staff_attendance_pct ?? null, fees_collected: values.fees_collected ?? null, fees_outstanding: values.fees_outstanding ?? null, new_enquiries: values.new_enquiries ?? null, new_admissions: values.new_admissions ?? null, sms_sent: values.sms_sent ?? null };
    const existing = await this.db.findOne<Row>('kpi_daily', { school_id: schoolId, day });
    if (existing) await this.db.update('kpi_daily', kpi, { id: String(existing.id) });
    else await this.db.insert('kpi_daily', { id: ulid(), school_id: schoolId, day, ...kpi, extra: null });
    return { day, values };
  }
  /** A metric's recent history, oldest first, for a chart or a comparison. */
  async series(schoolId: string, key: MetricKey | string, days = 30) {
    const rows = await this.db.query<Row>(`SELECT v.period, v.value FROM metric_values v JOIN metrics m ON m.id = v.metric_id WHERE v.school_id = ? AND m.key_name = ? AND v.dimension IS NULL ORDER BY v.period DESC LIMIT ?`, [schoolId, key, days]);
    return rows.map(r => ({ period: String(r.period).slice(0, 10), value: Number(r.value) })).reverse();
  }

  /**
   * The days this school has actually been counted, newest last, straight off `kpi_daily`. A trend
   * line is drawn on every dashboard load, so it reads the rows the nightly pass already wrote
   * rather than recomputing a month of registers and payments on a shared host. A day with no
   * register has `attendancePct` null — a holiday is not a day nobody came.
   */
  async trend(schoolId: string, opts: { to: string; days?: number } = { to: nowSql().slice(0, 10) }) {
    const rows = await this.db.query<Row>(`SELECT day, attendance_pct, fees_collected FROM kpi_daily
      WHERE school_id = ? AND day <= ? ORDER BY day DESC, id DESC LIMIT ?`, [schoolId, opts.to, opts.days ?? 30]);
    return rows.reverse().map(r => ({
      day: String(r.day).slice(0, 10),
      attendancePct: r.attendance_pct == null ? null : Number(r.attendance_pct),
      collected: round(Number(r.fees_collected ?? 0)),
    }));
  }

  // ---------- what a role sees when they sign in ----------
  /**
   * The dashboard for a role. Each card is a number with the direction it moved and whether that is
   * outside what this school normally does, because a figure with no comparison teaches nobody
   * anything.
   */
  async dashboard(schoolId: string, role = 'admin', days = 30) {
    await this.ensureMetrics(schoolId);
    const want: MetricKey[] = role === 'teacher' ? ['attendance_pct', 'pass_pct', 'students_active']
      : role === 'accountant' ? ['fees_collected', 'fees_outstanding', 'students_active']
        : ['attendance_pct', 'fees_collected', 'fees_outstanding', 'students_active', 'new_enquiries', 'sms_sent'];
    const catalogue = await this.metrics(schoolId);
    const cards = [];
    for (const key of want) {
      const meta = catalogue.find(m => String(m.key_name) === key);
      const history = await this.series(schoolId, key, days);
      const latest = history[history.length - 1] ?? null;
      const previous = history[history.length - 2] ?? null;
      const baseline = AnalyticsService.median(history.slice(0, -1).map(h => h.value));
      cards.push({
        key, name: String(meta?.name ?? key), unit: String(meta?.unit ?? ''),
        value: latest?.value ?? null, on: latest?.period ?? null,
        change: latest && previous ? round(latest.value - previous.value) : null,
        baseline, history,
        warn: latest != null && meta?.warn_below != null && latest.value < Number(meta.warn_below),
      });
    }
    const [openAlerts, risks] = await Promise.all([
      this.db.findMany<Row>('anomaly_alerts', { school_id: schoolId, status: 'open' }, { orderBy: 'detected_at DESC', limit: 20 }),
      this.db.query<Row>(`SELECT r.*, s.first_name, s.last_name, s.admission_no FROM risk_scores r JOIN students s ON s.id = r.student_id WHERE r.school_id = ? AND r.score >= 60 AND r.acknowledged_by IS NULL ORDER BY r.score DESC LIMIT 20`, [schoolId]),
    ]);
    return { role, cards, alerts: openAlerts.map(a => ({ ...a, details: json(a.details) }) as Row), risks: risks.map(r => ({ ...r, factors: json(r.factors) }) as Row) };
  }
  async saveDashboard(schoolId: string, d: { name: string; roleId?: string | null; userId?: string | null; layout: unknown; isDefault?: boolean }) {
    const id = ulid();
    await this.db.insert('dashboards', { id, school_id: schoolId, name: d.name, role_id: d.roleId ?? null, user_id: d.userId ?? null, layout: d.layout as never, is_default: !!d.isDefault });
    return id;
  }
  async dashboards(schoolId: string) { return this.db.findMany<Row>('dashboards', { school_id: schoolId }, { orderBy: 'name ASC' }); }

  // ---------- anomalies ----------
  /**
   * Compares today with what this school normally does. The baseline is the median of the last
   * fortnight and the spread is the median absolute deviation, so one exam day does not move the
   * bar and a school with naturally jumpy numbers is not flagged every morning.
   */
  async detectAnomalies(schoolId: string, day = nowSql().slice(0, 10)) {
    const found: { metricKey: string; expected: number; actual: number; severity: 'info' | 'warn' | 'critical' }[] = [];
    for (const m of AnalyticsService.CATALOGUE) {
      const history = await this.series(schoolId, m.key, 15);
      const today = history.find(h => h.period === day);
      const past = history.filter(h => h.period !== day).map(h => h.value);
      if (!today || past.length < 5) continue;                       // not enough of a habit to depart from
      const baseline = AnalyticsService.median(past)!;
      const spread = AnalyticsService.median(past.map(v => Math.abs(v - baseline)))!;
      const tolerance = Math.max(spread * 3, Math.abs(baseline) * 0.15, 1);
      const gap = Math.abs(today.value - baseline);
      if (gap <= tolerance) continue;
      const severity = gap > tolerance * 2 ? 'critical' : 'warn';
      // one open alert per metric: a fortnight of daily duplicates is how alerting gets ignored
      const open = await this.db.findOne('anomaly_alerts', { school_id: schoolId, metric_key: m.key, status: 'open' });
      if (!open) {
        await this.db.insert('anomaly_alerts', { id: ulid(), school_id: schoolId, metric_key: m.key, detected_at: nowSql(), expected: round(baseline), actual: round(today.value), severity, status: 'open', details: { day, tolerance: round(tolerance), name: m.name, unit: m.unit } as never });
        await this.notifications.notifyRole(schoolId, 'admin', { channels: ['in_app', 'push'], eventKey: 'analytics.anomaly', title: `${m.name} is ${today.value > baseline ? 'higher' : 'lower'} than usual`, body: `${round(today.value)}${m.unit === '%' ? '%' : ''} against a usual ${round(baseline)}${m.unit === '%' ? '%' : ''}.`, entityType: 'analytics.metric', entityId: m.key });
        await this.outbox.emitNow({ type: 'anomaly.detected', schoolId, aggregateType: 'analytics.metric', aggregateId: m.key, payload: { metricKey: m.key, expected: round(baseline), actual: round(today.value), severity } });
      }
      found.push({ metricKey: m.key, expected: round(baseline), actual: round(today.value), severity });
    }
    return { day, anomalies: found };
  }
  /**
   * Closes the alerts whose metric has come back to what this school normally does.
   *
   * An alert nobody closes is the same problem as an alert nobody reads. Attendance dipping on the
   * day of a strike raises one correctly; three weeks later it is still open, sitting at the top of
   * every dashboard, and the next real one arrives underneath it. Being back inside the tolerance on
   * the most recent day is the machine's own test that the departure is over, so the machine closes
   * its own alert — and says in the row that it did, rather than pretending a person looked.
   */
  async resolveRecoveredAlerts(schoolId: string, day = nowSql().slice(0, 10)) {
    const open = await this.db.findMany<Row>('anomaly_alerts', { school_id: schoolId, status: 'open' }, { limit: 100 });
    let resolved = 0;
    for (const a of open) {
      const history = await this.series(schoolId, String(a.metric_key), 15);
      const latest = history[history.length - 1];
      if (!latest || latest.period < String(a.detected_at).slice(0, 10)) continue;   // no newer reading than the alert
      const past = history.filter(h => h.period !== latest.period).map(h => h.value);
      if (past.length < 5) continue;
      const baseline = AnalyticsService.median(past)!;
      const spread = AnalyticsService.median(past.map(v => Math.abs(v - baseline)))!;
      const tolerance = Math.max(spread * 3, Math.abs(baseline) * 0.15, 1);
      if (Math.abs(latest.value - baseline) > tolerance) continue;
      const details = { ...(json<Record<string, unknown>>(a.details) ?? {}), resolvedOn: latest.period, resolvedValue: latest.value, resolvedBy: 'analytics: back within the usual range' };
      await this.db.update('anomaly_alerts', { status: 'resolved', details: details as never, updated_at: nowSql() }, { id: String(a.id) });
      resolved++;
    }
    return { day, resolved };
  }
  async resolveAlert(schoolId: string, alertId: string, status: 'acknowledged' | 'resolved') {
    if (!(await this.db.update('anomaly_alerts', { status, updated_at: nowSql() }, { id: alertId, school_id: schoolId }))) throw notFound('alert');
    return { id: alertId, status };
  }
  async alerts(schoolId: string, status = 'open') { return this.db.findMany<Row>('anomaly_alerts', { school_id: schoolId, status }, { orderBy: 'detected_at DESC', limit: 100 }); }

  // ---------- who is slipping ----------
  /**
   * Scores every active student for the four risks a school can actually do something about, and
   * keeps the reasons with the score. A student who crosses the line is put in front of their class
   * teacher once — not every night, which is how a warning becomes wallpaper.
   */
  async computeRisks(schoolId: string, opts: { asOf?: string; notifyAbove?: number } = {}) {
    const asOf = opts.asOf ?? nowSql().slice(0, 10);
    const from = new Date(Date.parse(`${asOf}T00:00:00Z`) - 60 * 86_400_000).toISOString().slice(0, 10);
    const students = await this.db.query<Row>(`SELECT s.id, s.first_name, s.last_name, s.admission_no, s.current_class_id FROM students s WHERE s.school_id = ? AND s.status = 'active' LIMIT 5000`, [schoolId]);
    const notifyAbove = opts.notifyAbove ?? 70;
    let scored = 0, flagged = 0;
    for (const s of students) {
      const studentId = String(s.id);
      const [att, dues, results] = await Promise.all([
        this.db.query<{ present: number; total: number }>(`SELECT SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS present, COUNT(*) AS total FROM student_attendance WHERE student_id = ? AND on_date BETWEEN ? AND ?`, [studentId, from, asOf]),
        this.db.query<{ due: number; oldest: string | null }>(`SELECT COALESCE(SUM(balance), 0) AS due, MIN(due_date) AS oldest FROM invoices WHERE student_id = ? AND balance > 0`, [studentId]),
        this.db.query<{ percentage: number }>(`SELECT percentage FROM exam_results WHERE student_id = ? ORDER BY created_at DESC LIMIT 2`, [studentId]),
      ]);
      const total = Number(att[0]?.total ?? 0);
      const attendancePct = total > 0 ? round((Number(att[0]!.present) * 100) / total) : null;
      const due = round(Number(dues[0]?.due ?? 0));
      const daysOverdue = dues[0]?.oldest ? Math.max(0, Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${String(dues[0].oldest).slice(0, 10)}T00:00:00Z`)) / 86_400_000)) : 0;
      const drop = results.length === 2 ? round(Number(results[1].percentage) - Number(results[0].percentage)) : 0;

      // the four risks this pass scores; `wellbeing` is a RiskType too but is computed elsewhere
      // (ForecastService), from signals — behaviour, counselling — this pass deliberately never reads
      const factors: Record<Exclude<RiskType, 'wellbeing'>, { score: number; why: string[] }> = {
        attendance: { score: 0, why: [] }, fee_default: { score: 0, why: [] }, result_decline: { score: 0, why: [] }, dropout: { score: 0, why: [] },
      };
      if (attendancePct != null && attendancePct < 85) {
        factors.attendance.score = Math.min(100, round((85 - attendancePct) * 3));
        factors.attendance.why.push(`present ${attendancePct}% of ${total} days since ${from}`);
      }
      if (due > 0 && daysOverdue > 15) {
        factors.fee_default.score = Math.min(100, round(20 + daysOverdue / 2));
        factors.fee_default.why.push(`${due} outstanding, oldest bill ${daysOverdue} days past its date`);
      }
      if (drop >= 5) {
        factors.result_decline.score = Math.min(100, round(drop * 4));
        factors.result_decline.why.push(`marks down ${drop} points between the last two exams`);
      }
      // dropping out is not one thing: it is the others arriving together
      const parts = [factors.attendance.score, factors.fee_default.score, factors.result_decline.score].filter(v => v > 0);
      if (parts.length >= 2) {
        factors.dropout.score = Math.min(100, round(parts.reduce((a, b) => a + b, 0) / parts.length + parts.length * 10));
        factors.dropout.why = [...factors.attendance.why, ...factors.fee_default.why, ...factors.result_decline.why];
      }

      for (const [riskType, f] of Object.entries(factors) as [RiskType, { score: number; why: string[] }][]) {
        const r = await this.saveRisk(schoolId, {
          studentId, riskType, score: f.score, factors: { why: f.why, asOf }, notifyAbove,
          announce: { role: 'teacher', eventKey: 'analytics.risk', title: `${s.first_name} ${s.last_name ?? ''} needs a word`, body: `${riskType.replace('_', ' ')}: ${f.why.join('; ')}.` },
        });
        if (r.saved) scored++;
        if (r.flagged) flagged++;
      }
    }
    return { asOf, students: students.length, scored, flagged };
  }
  /**
   * The one place a risk score is written, so the "tell somebody once" rule cannot be
   * re-implemented slightly differently by the next producer and turn a warning into wallpaper.
   * `ForecastService` writes the year-4 wellbeing score through here rather than touching
   * `risk_scores` itself: the table belongs to this module and only this module writes it.
   *
   * The announcement is the caller's to word, because who may be told what differs by risk. A
   * fee-default score can name the reason to the class teacher; a wellbeing score cannot — its
   * reasons stay in the watchlist a welfare lead opens deliberately.
   */
  async saveRisk(schoolId: string, r: SaveRiskInput) {
    const notifyAbove = r.notifyAbove ?? 70;
    const score = round(r.score);
    const ex = await this.db.findOne<Row>('risk_scores', { school_id: schoolId, student_id: r.studentId, risk_type: r.riskType });
    // a risk that has gone leaves no row behind: a stale score is read as a current one, and a
    // child who has been back in class for a month should not still be on somebody's list
    if (score <= 0) { if (ex) await this.db.delete('risk_scores', { id: String(ex.id) }); return { saved: false, flagged: false, cleared: !!ex }; }
    const row = { school_id: schoolId, student_id: r.studentId, risk_type: r.riskType, score, factors: r.factors as never, computed_at: nowSql() };
    const wasBelow = !ex || Number(ex.score) < notifyAbove;
    if (ex) await this.db.update('risk_scores', { ...row, updated_at: nowSql() }, { id: String(ex.id) });
    else await this.db.insert('risk_scores', { id: ulid(), ...row, acknowledged_by: null });
    if (!(score >= notifyAbove && wasBelow)) return { saved: true, flagged: false, cleared: false };
    if (r.announce) await this.notifications.notifyRole(schoolId, r.announce.role, { channels: r.announce.channels ?? ['in_app'], eventKey: r.announce.eventKey, title: r.announce.title, body: r.announce.body, entityType: 'people.student', entityId: r.studentId });
    await this.outbox.emitNow({ type: 'risk.flagged', schoolId, aggregateType: 'analytics.risk', aggregateId: r.studentId, payload: { studentId: r.studentId, riskType: r.riskType, score, why: (Array.isArray(r.factors.why) ? r.factors.why as string[] : []).join('; ') } });
    return { saved: true, flagged: true, cleared: false };
  }
  async risks(schoolId: string, f: { riskType?: string; minScore?: number; studentId?: string } = {}) {
    const where: string[] = ['r.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.riskType) { where.push('r.risk_type = ?'); params.push(f.riskType); }
    if (f.studentId) { where.push('r.student_id = ?'); params.push(f.studentId); }
    if (f.minScore) { where.push('r.score >= ?'); params.push(f.minScore); }
    const rows = await this.db.query<Row>(`SELECT r.*, s.first_name, s.last_name, s.admission_no, c.name AS class_name FROM risk_scores r JOIN students s ON s.id = r.student_id LEFT JOIN classes c ON c.id = s.current_class_id WHERE ${where.join(' AND ')} ORDER BY r.score DESC LIMIT 300`, params);
    return rows.map(r => ({ ...r, factors: json(r.factors) }) as Row);
  }
  async acknowledgeRisk(schoolId: string, riskId: string, userId: string) {
    if (!(await this.db.update('risk_scores', { acknowledged_by: userId, updated_at: nowSql() }, { id: riskId, school_id: schoolId }))) throw notFound('risk score');
    return { id: riskId, acknowledged: true };
  }

  // ---------- benchmarks ----------
  /**
   * How this school compares with others of its kind. The snapshot holds quartiles only, never a
   * school's own figure next to its name: a benchmark that identifies the school at the bottom is a
   * benchmark nobody joins.
   */
  async buildBenchmarks(period = nowSql().slice(0, 7) + '-01') {
    const schools = await this.db.query<Row>(`SELECT id, institution_type FROM schools WHERE status = 'active'`);
    const byCohort = new Map<string, Map<string, number[]>>();
    for (const s of schools) {
      const cohort = String(s.institution_type);
      for (const key of ['attendance_pct', 'fees_outstanding', 'students_active'] as MetricKey[]) {
        const history = await this.series(String(s.id), key, 30);
        if (!history.length) continue;
        const avg = round(history.reduce((a, h) => a + h.value, 0) / history.length);
        if (!byCohort.has(cohort)) byCohort.set(cohort, new Map());
        const metrics = byCohort.get(cohort)!;
        metrics.set(key, [...(metrics.get(key) ?? []), avg]);
      }
    }
    let written = 0;
    for (const [cohort, metrics] of byCohort) {
      for (const [key, values] of metrics) {
        if (values.length < 3) continue;                       // three schools is the fewest that hides one
        const sorted = [...values].sort((a, b) => a - b);
        const at = (q: number) => round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
        const ex = await this.db.findOne<Row>('benchmark_snapshots', { period, cohort, metric_key: key });
        const row = { period, cohort, metric_key: key, p25: at(0.25), p50: at(0.5), p75: at(0.75) };
        if (ex) await this.db.update('benchmark_snapshots', row, { id: String(ex.id) });
        else await this.db.insert('benchmark_snapshots', { id: ulid(), ...row });
        written++;
      }
    }
    return { period, cohorts: byCohort.size, written };
  }
  /** Where this school sits in its cohort, with its own number shown only to itself. */
  async benchmark(schoolId: string, period = nowSql().slice(0, 7) + '-01') {
    const school = await this.db.findOne<Row>('schools', { id: schoolId });
    if (!school) throw notFound('school');
    const rows = await this.db.findMany<Row>('benchmark_snapshots', { period, cohort: String(school.institution_type) });
    const out = [];
    for (const r of rows) {
      const history = await this.series(schoolId, String(r.metric_key), 30);
      const mine = history.length ? round(history.reduce((a, h) => a + h.value, 0) / history.length) : null;
      out.push({
        metricKey: String(r.metric_key), p25: Number(r.p25), p50: Number(r.p50), p75: Number(r.p75), mine,
        standing: mine == null ? null : mine >= Number(r.p75) ? 'top quarter' : mine >= Number(r.p50) ? 'above the middle' : mine >= Number(r.p25) ? 'below the middle' : 'bottom quarter',
      });
    }
    return { period, cohort: String(school.institution_type), metrics: out };
  }

  /**
   * Fills in the days nobody computed. On shared hosting the scheduler is a heartbeat: a school
   * whose site nobody opened over Eid has no `kpi_daily` rows for those days, and the group total,
   * the anomaly baseline and every chart quietly read that absence as a bad week. The register still
   * holds what happened, so the days can be worked out afterwards — up to a fortnight, which is more
   * than a holiday and less than a request can afford.
   */
  async backfill(schoolId: string, days = 14) {
    const missing: string[] = [];
    for (let back = days; back >= 1; back--) {
      const day = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
      if (await this.db.findOne('kpi_daily', { school_id: schoolId, day })) continue;
      missing.push(day);
    }
    for (const day of missing) await this.computeDay(schoolId, day);
    return { filled: missing.length, days: missing };
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // the day's numbers, then what departs from this school's own habits, then who is slipping
      'analytics.daily': async ({ schoolId }) => {
        const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
        // days the heartbeat never woke for come first: an anomaly baseline built on a fortnight
        // with holes in it compares today against a median of whatever days happened to be recorded
        const filled = await this.backfill(schoolId);
        await this.computeDay(schoolId, yesterday);
        const today = await this.computeDay(schoolId);
        const anomalies = await this.detectAnomalies(schoolId, yesterday);
        const recovered = await this.resolveRecoveredAlerts(schoolId, yesterday);
        return { day: today.day, backfilled: filled.filled, anomalies: anomalies.anomalies.length, resolved: recovered.resolved };
      },
      'analytics.risk_scores': async ({ schoolId }) => this.computeRisks(schoolId),
      /**
       * Monthly: the cohort quartiles every school's benchmark page reads. They were only ever built
       * when somebody called the endpoint, so the page was empty in every school that never did.
       * The snapshot spans the whole installation, so only the school it was installed with builds
       * it — the others would compute the same rows again for nothing.
       */
      'analytics.benchmarks': async ({ schoolId }) => {
        const first = await this.db.findOne<Row>('schools', {}, { orderBy: 'created_at ASC, id ASC' });
        if (!first || String(first.id) !== schoolId) return { skipped: 'not the founding school of this installation' };
        return this.buildBenchmarks();
      },
    };
  }

  private static median(values: number[]) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
  }
}
