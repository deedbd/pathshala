import type { Db, Row } from '@pathshala/db';
import { json, nowSql } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { AcademicService } from './academic.js';
import type { AnalyticsService } from './analytics.js';
import { round } from './accounting.js';
import { fallsDueInMonth, type Frequency } from './fees.js';

/** Every figure a projection produces carries the working it came from. */
export interface Projected {
  /** Never dropped from a response: a number a head teacher cannot argue with is a number they cannot use. */
  disclaimer: string;
  assumptions: Record<string, unknown>;
  /** What the projection could not see. Stated plainly, because the gaps are where it will be wrong. */
  blindSpots: string[];
}

export interface CashFlowMonth {
  month: string;                                     // 'YYYY-MM'
  billing: { recurring: number; instalments: number; discount: number; total: number };
  inflow: { fromBilling: number; fromArrears: number; total: number };
  outflow: { payroll: number; otherExpenses: number; total: number };
  net: number;
  closingCash: number;
}

export interface SubjectGap {
  subjectId: string | null; subject: string;
  periodsPerWeek: number; uncoveredPeriods: number;
  reasons: { unstaffed: number; leaving: number };
  teachersRemaining: number; sparePeriods: number;
  shortfallPeriods: number; teachersNeeded: number;
  leavers: string[];
}

/**
 * Forecast: the three questions a head teacher asks about next term that no report in the system
 * answers, because every existing report looks backwards.
 *
 * Three rules hold the whole module together.
 *
 * **It predicts from this school's own record, never from a rule of thumb.** The collection rate is
 * what *this* school actually collected on bills that have already fallen due — not 90%, not the
 * national average. A village school that collects 62% and a city school that collects 97% both get
 * their own number, and both are told which one was used.
 *
 * **It shows its working.** Every method returns `assumptions` (what it used) and `blindSpots` (what
 * it could not see) beside the figures. A projection whose arithmetic is hidden is a rumour with a
 * decimal point: the head teacher cannot tell whether "Tk 4.1 lakh short in March" means the school
 * is in trouble or that nobody has entered next year's fee structure yet.
 *
 * **It never acts and never asserts.** Nothing here writes an invoice, hires anybody or messages a
 * guardian. The scheduled pass puts a number and a list of names in front of a person, and that is
 * the end of its authority. The wellbeing score is written through `AnalyticsService.saveRisk`,
 * because `risk_scores` belongs to analytics and only analytics writes it.
 */
export class ForecastService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService,
    private academic: AcademicService, private analytics: AnalyticsService,
  ) {}

  private static readonly DISCLAIMER = 'A projection from this school\'s own past figures, not a promise. Read the assumptions and the blind spots before acting on it.';

  // ---------------------------------------------------------------- money ----
  /**
   * What the next three to six months look like in cash: what will be billed from the fee
   * structures and the instalment plans already agreed, how much of it this school has historically
   * managed to collect, what the arrears on the books are worth, and what payroll and the ordinary
   * monthly expenses will take back out.
   *
   * The projection starts at the month *after* `asOf`, because the current month is usually half
   * billed and half collected already: mixing a part-finished month into a forecast is how a
   * forecast starts disagreeing with the ledger.
   */
  async cashFlow(schoolId: string, opts: { months?: number; historyMonths?: number; asOf?: string; academicYearId?: string } = {}) {
    const asOf = (opts.asOf ?? nowSql().slice(0, 10)).slice(0, 10);
    const horizon = Math.min(6, Math.max(3, Math.round(opts.months ?? 3)));
    const historyMonths = Math.min(24, Math.max(3, Math.round(opts.historyMonths ?? 6)));
    const blindSpots: string[] = [];
    const thisMonth = asOf.slice(0, 7);

    // ---- what this school actually did, month by month, before today ----
    const history: { month: string; billed: number; subtotal: number; discount: number; dueBilled: number; duePaid: number; received: number; expenses: number; payroll: number | null; invoices: number }[] = [];
    for (let back = historyMonths; back >= 1; back--) {
      const month = addMonths(thisMonth, -back);
      const from = `${month}-01`, to = lastDayOf(month);
      const [inv] = await this.db.query<Row>(
        `SELECT COALESCE(SUM(total), 0) AS billed, COALESCE(SUM(subtotal), 0) AS subtotal, COALESCE(SUM(discount_total), 0) AS discount,
                COALESCE(SUM(CASE WHEN due_date <= ? THEN total ELSE 0 END), 0) AS due_billed,
                COALESCE(SUM(CASE WHEN due_date <= ? THEN paid_total ELSE 0 END), 0) AS due_paid,
                COUNT(*) AS invoices
         FROM invoices WHERE school_id = ? AND status <> 'cancelled' AND issue_date BETWEEN ? AND ?`,
        [asOf, asOf, schoolId, from, to]);
      const [pay] = await this.db.query<{ v: number }>(`SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE school_id = ? AND status = 'success' AND paid_at BETWEEN ? AND ?`, [schoolId, `${from} 00:00:00`, `${to} 23:59:59`]);
      const [exp] = await this.db.query<{ v: number }>(`SELECT COALESCE(SUM(amount), 0) + COALESCE(SUM(tax_amount), 0) AS v FROM expenses WHERE school_id = ? AND status IN ('approved', 'paid') AND expense_date BETWEEN ? AND ?`, [schoolId, from, to]);
      const [run] = await this.db.query<{ v: number | null }>(`SELECT COALESCE(SUM(total_net), 0) AS v FROM payroll_runs WHERE school_id = ? AND status IN ('approved', 'paid', 'locked') AND period_month BETWEEN ? AND ?`, [schoolId, from, to]);
      history.push({
        month, billed: round(Number(inv?.billed ?? 0)), subtotal: round(Number(inv?.subtotal ?? 0)), discount: round(Number(inv?.discount ?? 0)),
        dueBilled: round(Number(inv?.due_billed ?? 0)), duePaid: round(Number(inv?.due_paid ?? 0)),
        received: round(Number(pay?.v ?? 0)), expenses: round(Number(exp?.v ?? 0)),
        payroll: Number(run?.v ?? 0) > 0 ? round(Number(run!.v)) : null, invoices: Number(inv?.invoices ?? 0),
      });
    }
    const monthsWithBilling = history.filter(h => h.invoices > 0).length;

    // The rate counts only bills that have already had their chance to be paid. Counting a bill
    // raised last week as "not collected" makes a school that always pays on time look like one
    // that never pays, and every figure downstream of that is wrong.
    const dueBilled = round(history.reduce((a, h) => a + h.dueBilled, 0));
    const duePaid = round(history.reduce((a, h) => a + h.duePaid, 0));
    // rates are rounded before they are used, not only before they are printed: the percentage the
    // response reports has to be the one the figures were built from, or a head teacher who checks
    // the arithmetic with a calculator finds it does not come out and rightly stops trusting any of it
    const collectionRate = dueBilled > 0 ? rate4(duePaid / dueBilled) : null;
    const subtotal = round(history.reduce((a, h) => a + h.subtotal, 0));
    const discountRate = subtotal > 0 ? rate4(history.reduce((a, h) => a + h.discount, 0) / subtotal) : 0;

    // Arrears are a different animal from a current bill: a family six months behind pays back at a
    // different rate from one billed yesterday, so they get their own rate rather than the headline one.
    const arrearsFrom = addDays(asOf, -60);
    const [old] = await this.db.query<Row>(`SELECT COALESCE(SUM(total), 0) AS billed, COALESCE(SUM(paid_total), 0) AS paid FROM invoices WHERE school_id = ? AND status <> 'cancelled' AND due_date < ?`, [schoolId, arrearsFrom]);
    const arrearsRecoveryRate = Number(old?.billed ?? 0) > 0 ? rate4(Number(old!.paid) / Number(old!.billed)) : 0;
    const [outstanding] = await this.db.query<Row>(`SELECT COALESCE(SUM(balance), 0) AS due, COUNT(*) AS n FROM invoices WHERE school_id = ? AND status <> 'cancelled' AND balance > 0`, [schoolId]);
    const openingReceivable = round(Number(outstanding?.due ?? 0));

    // Opening cash comes from the ledger, not from a typed-in figure: the same journal lines the
    // trial balance is built from, on the accounts the school's bank and cash records point at.
    const [cash] = await this.db.query<{ v: number }>(
      `SELECT COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS v
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.school_id = ? AND e.status = 'posted' AND e.entry_date <= ?
         AND l.account_id IN (SELECT gl_account_id FROM bank_accounts WHERE school_id = ? AND status = 'active' AND gl_account_id IS NOT NULL)`,
      [schoolId, asOf, schoolId]);
    const openingCash = round(Number(cash?.v ?? 0));

    // ---- what will be billed ----
    const year = opts.academicYearId ? await this.db.findOne<Row>('academic_years', { id: opts.academicYearId, school_id: schoolId }) : await this.academic.currentYear(schoolId);
    const items = year ? await this.db.query<Row>(
      `SELECT fs.class_id, i.amount, i.frequency, i.applicable_months
       FROM fee_structure_items i JOIN fee_structures fs ON fs.id = i.fee_structure_id
       WHERE fs.school_id = ? AND fs.academic_year_id = ? AND fs.status = 'active' AND fs.class_id IS NOT NULL`,
      [schoolId, String(year.id)]) : [];
    const heads = await this.db.query<Row>(`SELECT current_class_id AS class_id, COUNT(*) AS n FROM students WHERE school_id = ? AND status = 'active' AND current_class_id IS NOT NULL GROUP BY current_class_id`, [schoolId]);
    const roll = new Map(heads.map(h => [String(h.class_id), Number(h.n)]));
    const classesWithStructure = new Set(items.map(i => String(i.class_id)));
    const unpriced = [...roll.entries()].filter(([classId]) => !classesWithStructure.has(classId)).reduce((a, [, n]) => a + n, 0);

    // Instalment plans are money already agreed with a family; they are billed on the day they fall
    // due, so they belong in the month of that date and not in the recurring structure total.
    const plans = await this.db.findMany<Row>('instalment_plans', { school_id: schoolId, status: 'active' }, { limit: 5000 });
    const instalmentsByMonth = new Map<string, number>();
    let unbilledInstalments = 0;
    for (const p of plans) {
      for (const r of json<{ due: string; amount: number; invoiceId: string | null }[]>(p.instalments) ?? []) {
        if (r.invoiceId) continue;                                  // already an invoice: it is in the arrears figure, not here
        const month = String(r.due).slice(0, 7);
        instalmentsByMonth.set(month, round((instalmentsByMonth.get(month) ?? 0) + Number(r.amount)));
        unbilledInstalments++;
      }
    }

    const months: CashFlowMonth[] = [];
    let running = openingCash;
    const payrollMonths = history.map(h => h.payroll).filter((v): v is number => v != null);
    const [salaries] = await this.db.query<{ v: number }>(
      `SELECT COALESCE(SUM(ss.basic), 0) AS v FROM salary_structures ss JOIN staff s ON s.id = ss.staff_id
       WHERE ss.school_id = ? AND s.status IN ('active', 'probation', 'on_leave') AND ss.effective_from <= ? AND (ss.effective_to IS NULL OR ss.effective_to >= ?)`,
      [schoolId, asOf, asOf]);
    const payrollPerMonth = payrollMonths.length ? median(payrollMonths)! : round(Number(salaries?.v ?? 0));
    const payrollBasis = payrollMonths.length ? `median net pay of ${payrollMonths.length} approved payroll run(s)` : 'basic pay on the current salary structures — no payroll run has been approved yet, so allowances and deductions are missing';
    const expensePerMonth = median(history.map(h => h.expenses)) ?? 0;

    for (let ahead = 1; ahead <= horizon; ahead++) {
      const month = addMonths(thisMonth, ahead);
      const monthNo = Number(month.slice(5, 7));
      let recurring = 0;
      for (const it of items) {
        if (!fallsDueInMonth(String(it.frequency) as Frequency, json<number[]>(it.applicable_months), monthNo)) continue;
        recurring += Number(it.amount) * (roll.get(String(it.class_id)) ?? 0);
      }
      recurring = round(recurring);
      // discounts are applied to structure billing only: an instalment plan's amounts were already
      // negotiated down, and discounting them twice is how a forecast quietly loses a term's income
      const discount = round(recurring * discountRate);
      const instalments = round(instalmentsByMonth.get(month) ?? 0);
      const billingTotal = round(recurring - discount + instalments);
      const fromBilling = round(billingTotal * (collectionRate ?? 0));
      const fromArrears = round((openingReceivable * arrearsRecoveryRate) / horizon);
      const inflow = round(fromBilling + fromArrears);
      const outflow = round(payrollPerMonth + expensePerMonth);
      const net = round(inflow - outflow);
      running = round(running + net);
      months.push({
        month,
        billing: { recurring, instalments, discount, total: billingTotal },
        inflow: { fromBilling, fromArrears, total: inflow },
        outflow: { payroll: round(payrollPerMonth), otherExpenses: round(expensePerMonth), total: outflow },
        net, closingCash: running,
      });
    }

    if (collectionRate == null) blindSpots.push(`no bill in the last ${historyMonths} months has yet fallen due, so there is no collection rate to project with — every collection figure above is zero, not low.`);
    if (monthsWithBilling < 3) blindSpots.push(`only ${monthsWithBilling} of the last ${historyMonths} months carry any invoice: this is a short record, not a habit, and the collection rate will move a lot as more months arrive.`);
    if (!year) blindSpots.push('no academic year is marked current, so no fee structure could be read and nothing recurring is projected.');
    else if (!items.length) blindSpots.push(`no active fee structure is attached to a class for ${String(year.name)}: recurring billing is projected as zero.`);
    if (unpriced > 0) blindSpots.push(`${unpriced} active pupils are in classes with no active fee structure; nothing is billed for them here.`);
    if (!payrollMonths.length) blindSpots.push('payroll is estimated from basic pay because no run has been approved yet — the real figure will be higher once allowances are in.');
    if (!history.some(h => h.expenses > 0)) blindSpots.push('no approved expense in the history window, so the only outflow projected is payroll. Rent, utilities and bills paid in cash will not appear.');
    blindSpots.push('the roll is held at today\'s number: admissions, leavers and promotions inside the horizon are not projected.');
    blindSpots.push('government grants and MPO salary subvention, donations and one-off capital spending are not projected — they arrive on their own timetable, not the school\'s.');

    const totals = {
      billing: round(months.reduce((a, m) => a + m.billing.total, 0)),
      inflow: round(months.reduce((a, m) => a + m.inflow.total, 0)),
      outflow: round(months.reduce((a, m) => a + m.outflow.total, 0)),
      net: round(months.reduce((a, m) => a + m.net, 0)),
    };
    const shortfall = months.filter(m => m.closingCash < 0);
    const worst = months.reduce<CashFlowMonth | null>((w, m) => (!w || m.closingCash < w.closingCash ? m : w), null);

    return {
      asOf, generatedAt: nowSql(), horizonMonths: horizon, from: months[0]?.month ?? null, to: months[months.length - 1]?.month ?? null,
      openingCash, openingReceivable, outstandingInvoices: Number(outstanding?.n ?? 0),
      months, totals,
      shortfallMonths: shortfall.map(m => m.month),
      worstMonth: worst ? { month: worst.month, closingCash: worst.closingCash } : null,
      history,
      assumptions: {
        collectionRate: collectionRate == null ? null : round(collectionRate * 100),
        collectionRateFrom: `Tk ${duePaid} paid against Tk ${dueBilled} billed and already due, over ${historyMonths} months to ${lastDayOf(addMonths(thisMonth, -1))}`,
        arrearsRecoveryRate: round(arrearsRecoveryRate * 100),
        arrearsRecoveryFrom: `bills that fell due before ${arrearsFrom}`,
        arrearsSpread: `the recoverable share of Tk ${openingReceivable} is spread evenly across the ${horizon} months — the ledger does not say when a family will settle up, so no month is favoured`,
        discountRate: round(discountRate * 100),
        discountBasis: 'the share of billing this school actually discounted over the history window, applied to structure billing only — an instalment plan was already negotiated down',
        historyMonthsRequested: historyMonths, historyMonthsWithBilling: monthsWithBilling,
        studentsOnRoll: [...roll.values()].reduce((a, b) => a + b, 0),
        feeStructureItems: items.length, academicYear: year ? String(year.name) : null,
        unbilledInstalments,
        payrollPerMonth: round(payrollPerMonth), payrollBasis,
        otherExpensesPerMonth: round(expensePerMonth), expenseBasis: `median of ${history.length} months of approved and paid expenses`,
        openingCashBasis: 'posted journal lines on the GL accounts behind the active bank and cash accounts',
      },
      blindSpots,
      disclaimer: ForecastService.DISCLAIMER,
    } satisfies Projected & Record<string, unknown>;
  }

  // ------------------------------------------------------------- staffing ----
  /**
   * Where the school will be short of teachers, counted in periods rather than in people, because
   * "we need two more teachers" is an argument and "Physics has 14 periods a week with nobody to
   * teach them from 1 March" is a decision.
   *
   * A period is uncovered when its slot has no teacher at all, or when the teacher on it is leaving
   * inside the horizon — including one who has already gone and whose classes were never reassigned,
   * which is the commonest version of this problem and the one nobody notices until a Sunday morning.
   */
  async staffing(schoolId: string, opts: { asOf?: string; horizonDays?: number; maxPeriodsPerWeek?: number; academicYearId?: string } = {}) {
    const asOf = (opts.asOf ?? nowSql().slice(0, 10)).slice(0, 10);
    const horizonDays = Math.min(365, Math.max(30, Math.round(opts.horizonDays ?? 120)));
    const until = addDays(asOf, horizonDays);
    const maxPeriodsPerWeek = Math.min(48, Math.max(6, Math.round(opts.maxPeriodsPerWeek ?? 30)));
    const blindSpots: string[] = [];

    const year = opts.academicYearId ? await this.db.findOne<Row>('academic_years', { id: opts.academicYearId, school_id: schoolId }) : await this.academic.currentYear(schoolId);
    const version = year ? await this.db.findOne<Row>('timetable_versions', { school_id: schoolId, academic_year_id: String(year.id), status: 'published' }) : null;

    // Who is going. Two records say the same thing in different places and a school uses whichever
    // it happens to use, so both are read: a recorded exit, and a staff row already marked gone.
    const leavers = new Map<string, { name: string; on: string | null; reason: string }>();
    const exits = await this.db.query<Row>(
      `SELECT e.staff_id, e.last_working_day, e.exit_type, s.first_name, s.last_name
       FROM staff_exits e JOIN staff s ON s.id = e.staff_id
       WHERE e.school_id = ? AND e.last_working_day IS NOT NULL AND e.last_working_day <= ? LIMIT 2000`, [schoolId, until]);
    for (const e of exits) leavers.set(String(e.staff_id), { name: `${e.first_name} ${e.last_name ?? ''}`.trim(), on: String(e.last_working_day).slice(0, 10), reason: String(e.exit_type) });
    const gone = await this.db.query<Row>(
      `SELECT id, first_name, last_name, status, leave_date FROM staff
       WHERE school_id = ? AND (status IN ('resigned', 'terminated', 'retired') OR (leave_date IS NOT NULL AND leave_date <= ?)) LIMIT 2000`, [schoolId, until]);
    for (const g of gone) if (!leavers.has(String(g.id))) leavers.set(String(g.id), { name: `${g.first_name} ${g.last_name ?? ''}`.trim(), on: g.leave_date ? String(g.leave_date).slice(0, 10) : null, reason: String(g.status) });

    const subjects: SubjectGap[] = [];
    let unassignedPeriods = 0, totalPeriods = 0, busiestLoad = 0;
    if (version) {
      const slots = await this.db.query<Row>(
        `SELECT ts.id, ts.teacher_id, cs.subject_id, sub.name AS subject_name
         FROM timetable_slots ts
         LEFT JOIN class_subjects cs ON cs.id = ts.class_subject_id
         LEFT JOIN subjects sub ON sub.id = cs.subject_id
         WHERE ts.school_id = ? AND ts.version_id = ? LIMIT 20000`, [schoolId, String(version.id)]);
      totalPeriods = slots.length;
      // load is counted over the whole grid, not per subject: a teacher's week is one week however
      // many subjects it is spread across, and a spare-capacity sum that forgets that over-hires
      const loadByTeacher = new Map<string, number>();
      for (const s of slots) if (s.teacher_id) loadByTeacher.set(String(s.teacher_id), (loadByTeacher.get(String(s.teacher_id)) ?? 0) + 1);
      for (const n of loadByTeacher.values()) busiestLoad = Math.max(busiestLoad, n);

      const bySubject = new Map<string, { subjectId: string | null; subject: string; periods: number; unstaffed: number; leaving: number; teachers: Set<string>; leavers: Set<string> }>();
      for (const s of slots) {
        if (!s.subject_id) { unassignedPeriods++; continue; }         // a study or activity period nobody is timetabled against
        const key = String(s.subject_id);
        if (!bySubject.has(key)) bySubject.set(key, { subjectId: key, subject: String(s.subject_name ?? 'Unnamed subject'), periods: 0, unstaffed: 0, leaving: 0, teachers: new Set(), leavers: new Set() });
        const b = bySubject.get(key)!;
        b.periods++;
        const teacherId = s.teacher_id ? String(s.teacher_id) : null;
        if (!teacherId) b.unstaffed++;
        else if (leavers.has(teacherId)) { b.leaving++; b.leavers.add(leavers.get(teacherId)!.name); }
        else b.teachers.add(teacherId);
      }
      for (const b of bySubject.values()) {
        // who could take it on is inferred from who already teaches it in this timetable — the only
        // evidence the system actually holds. Nobody's certificate is on file, and guessing from a
        // designation would put a Bangla teacher in front of a chemistry practical.
        const spare = [...b.teachers].reduce((a, t) => a + Math.max(0, maxPeriodsPerWeek - (loadByTeacher.get(t) ?? 0)), 0);
        const uncovered = b.unstaffed + b.leaving;
        const shortfall = Math.max(0, uncovered - spare);
        subjects.push({
          subjectId: b.subjectId, subject: b.subject, periodsPerWeek: b.periods, uncoveredPeriods: uncovered,
          reasons: { unstaffed: b.unstaffed, leaving: b.leaving },
          teachersRemaining: b.teachers.size, sparePeriods: spare,
          shortfallPeriods: shortfall, teachersNeeded: Math.ceil(shortfall / maxPeriodsPerWeek),
          leavers: [...b.leavers].sort(),
        });
      }
      subjects.sort((a, b) => b.uncoveredPeriods - a.uncoveredPeriods || b.periodsPerWeek - a.periodsPerWeek || a.subject.localeCompare(b.subject));
    }

    // A section over its capacity is a staffing problem before it is a furniture problem: splitting
    // it needs a teacher the timetable does not yet know about.
    const oversized: { sectionId: string; section: string; className: string; capacity: number; enrolled: number }[] = [];
    if (year) {
      const rows = await this.db.query<Row>(
        `SELECT sec.id, sec.name, sec.capacity, c.name AS class_name, COUNT(st.id) AS enrolled
         FROM sections sec JOIN classes c ON c.id = sec.class_id
         LEFT JOIN students st ON st.current_section_id = sec.id AND st.status = 'active'
         WHERE sec.school_id = ? AND sec.academic_year_id = ? AND sec.status = 'active'
         GROUP BY sec.id, sec.name, sec.capacity, c.name`, [schoolId, String(year.id)]);
      for (const r of rows) {
        const capacity = Number(r.capacity ?? 0), enrolled = Number(r.enrolled ?? 0);
        if (capacity > 0 && enrolled > capacity) oversized.push({ sectionId: String(r.id), section: String(r.name), className: String(r.class_name), capacity, enrolled });
      }
      oversized.sort((a, b) => (b.enrolled - b.capacity) - (a.enrolled - a.capacity));
    }

    if (!year) blindSpots.push('no academic year is marked current, so no timetable could be read.');
    else if (!version) blindSpots.push(`no timetable is published for ${String(year.name)}: without a grid there is no load to forecast, and nothing above is based on real periods.`);
    if (version && !leavers.size) blindSpots.push('nobody is recorded as leaving inside the horizon; a resignation that has only been spoken about is not in the system and cannot be counted.');
    if (unassignedPeriods) blindSpots.push(`${unassignedPeriods} periods in the grid have no subject attached (study or activity periods) and are left out of every subject total.`);
    blindSpots.push('who can teach a subject is inferred from who already teaches it — qualifications, training records and willingness are not read.');
    blindSpots.push('a teacher who covers two subjects is counted as spare capacity for both, so the school-wide shortfall is the optimistic figure: the per-subject counts are the ones to argue from.');
    blindSpots.push(`a full week is assumed to be ${maxPeriodsPerWeek} periods for every teacher; part-time, MPO and contract staff are all counted the same.`);
    blindSpots.push('substitutions, long leave and maternity cover are not projected: this is the permanent grid, not next week\'s cover sheet.');

    const uncoveredPeriods = subjects.reduce((a, s) => a + s.uncoveredPeriods, 0);
    return {
      asOf, generatedAt: nowSql(), until, horizonDays,
      academicYear: year ? String(year.name) : null, timetable: version ? String(version.name) : null,
      subjects,
      totals: {
        periodsPerWeek: totalPeriods, uncoveredPeriods,
        shortfallPeriods: subjects.reduce((a, s) => a + s.shortfallPeriods, 0),
        teachersNeeded: subjects.reduce((a, s) => a + s.teachersNeeded, 0),
        subjectsAffected: subjects.filter(s => s.uncoveredPeriods > 0).length,
      },
      leavers: [...leavers.entries()].map(([staffId, l]) => ({ staffId, ...l })),
      oversizedSections: oversized,
      assumptions: {
        maxPeriodsPerWeek, busiestTeacherLoad: busiestLoad,
        unassignedPeriods,
        leaversCounted: leavers.size,
        coverInferredFrom: 'teachers already timetabled against the same subject in the published grid',
        horizon: `${asOf} to ${until}`,
      },
      blindSpots,
      disclaimer: ForecastService.DISCLAIMER,
    } satisfies Projected & Record<string, unknown>;
  }

  // ------------------------------------------------------------ wellbeing ----
  /**
   * The year-4 early-warning score: attendance, behaviour, results and whether welfare is already
   * involved, combined into one number per pupil and written to `risk_scores` as the `wellbeing`
   * type, beside the four `AnalyticsService.computeRisks` already writes.
   *
   * Two rules about the confidential half, and they are not negotiable.
   *
   * **Welfare involvement never raises a score on its own.** A pupil in ordinary counselling with
   * good attendance, steady marks and no incidents scores zero here. Flagging them would tell
   * everyone who can read the watchlist that the child is seeing a counsellor — that is exactly the
   * inference the welfare module encrypts its notes to prevent — and it would be useless besides,
   * since the school already knows. Welfare involvement only ever *adds weight* to something
   * measurable that is already going wrong.
   *
   * **The score never carries what is in the record.** Not the counselling notes, not the number of
   * sessions, not a safeguarding category, not the case's risk level. The stored reasons say a
   * concern exists and point at the person who is allowed to open it, exactly as
   * `WelfareService.safeguardingCase` does when it alerts the principal.
   */
  async computeWellbeing(schoolId: string, opts: { asOf?: string; notifyAbove?: number; windowDays?: number } = {}) {
    const asOf = (opts.asOf ?? nowSql().slice(0, 10)).slice(0, 10);
    const windowDays = Math.min(365, Math.max(14, Math.round(opts.windowDays ?? 90)));
    const from = addDays(asOf, -windowDays);
    const notifyAbove = opts.notifyAbove ?? 60;

    const students = await this.db.query<Row>(`SELECT id, first_name, last_name FROM students WHERE school_id = ? AND status = 'active' LIMIT 5000`, [schoolId]);
    // Set-based reads, one per signal, rather than four queries per pupil: node:sqlite is
    // synchronous, so 5,000 pupils × 4 round trips holds the event loop and every waiting request
    // with it. The whole pass is five queries however big the school is.
    const [attendance, behaviour, counselling, safeguarding, results] = await Promise.all([
      this.db.query<Row>(`SELECT student_id, SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS present, COUNT(*) AS total FROM student_attendance WHERE school_id = ? AND on_date BETWEEN ? AND ? GROUP BY student_id`, [schoolId, from, asOf]),
      this.db.query<Row>(`SELECT student_id, COALESCE(SUM(points), 0) AS points, COUNT(*) AS n FROM behaviour_incidents WHERE school_id = ? AND incident_date BETWEEN ? AND ? AND points < 0 GROUP BY student_id`, [schoolId, from, asOf]),
      this.db.query<Row>(`SELECT student_id, COUNT(*) AS n FROM counselling_sessions WHERE school_id = ? AND status <> 'cancelled' AND session_at BETWEEN ? AND ? GROUP BY student_id`, [schoolId, `${from} 00:00:00`, `${asOf} 23:59:59`]),
      this.db.query<Row>(`SELECT student_id, COUNT(*) AS n FROM safeguarding_cases WHERE school_id = ? AND status IN ('open', 'monitoring') GROUP BY student_id`, [schoolId]),
      // second-precision timestamps tie on the same batch of marks, so id breaks the tie and the
      // "last two exams" are the same two on every engine and every re-run
      this.db.query<Row>(`SELECT student_id, percentage, created_at, id FROM exam_results WHERE school_id = ? AND percentage IS NOT NULL ORDER BY student_id ASC, created_at DESC, id DESC LIMIT 30000`, [schoolId]),
    ]);
    const att = new Map(attendance.map(r => [String(r.student_id), { present: Number(r.present ?? 0), total: Number(r.total ?? 0) }]));
    const beh = new Map(behaviour.map(r => [String(r.student_id), { points: Number(r.points ?? 0), n: Number(r.n ?? 0) }]));
    const couns = new Map(counselling.map(r => [String(r.student_id), Number(r.n ?? 0)]));
    const cases = new Map(safeguarding.map(r => [String(r.student_id), Number(r.n ?? 0)]));
    const recent = new Map<string, number[]>();
    for (const r of results) {
      const key = String(r.student_id);
      const list = recent.get(key) ?? [];
      if (list.length < 2) { list.push(Number(r.percentage)); recent.set(key, list); }
    }

    // an alert nobody receives is worse than none: a school with no principal account tells the admins
    const [hasPrincipal] = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.school_id = ? AND r.slug = 'principal'`, [schoolId]);
    const role = Number(hasPrincipal?.n ?? 0) > 0 ? 'principal' : 'admin';

    let scored = 0, flagged = 0, cleared = 0;
    for (const s of students) {
      const studentId = String(s.id);
      const why: string[] = [];
      let objective = 0;

      const a = att.get(studentId);
      const attendancePct = a && a.total > 0 ? round((a.present * 100) / a.total) : null;
      if (attendancePct != null && attendancePct < 85) {
        objective += Math.min(40, round((85 - attendancePct) * 2));
        why.push(`present ${attendancePct}% of ${a!.total} days since ${from}`);
      }
      const b = beh.get(studentId);
      if (b && b.points <= -5) {
        objective += Math.min(30, Math.abs(b.points));
        why.push(`${b.n} behaviour incident${b.n === 1 ? '' : 's'} in ${windowDays} days, ${b.points} points`);
      }
      const marks = recent.get(studentId) ?? [];
      const drop = marks.length === 2 ? round(marks[1]! - marks[0]!) : 0;
      if (drop >= 5) {
        objective += Math.min(20, round(drop * 2));
        why.push(`marks down ${drop} points between the last two exams`);
      }

      const welfareInvolved = (couns.get(studentId) ?? 0) > 0 || (cases.get(studentId) ?? 0) > 0;
      // the weight, not the reason: a single flat number whichever kind of involvement it is, so the
      // score itself cannot be read backwards to tell counselling from a safeguarding case
      const pastoral = objective > 0 && welfareInvolved ? 20 : 0;
      const score = objective > 0 ? Math.min(100, objective + pastoral) : 0;
      // deliberately not counted in the summary either: in a small school "2 of the flagged pupils
      // have welfare engaged" beside a list of three names is the same disclosure by arithmetic

      const r = await this.analytics.saveRisk(schoolId, {
        studentId, riskType: 'wellbeing', score,
        factors: {
          why, asOf, windowDays, confidential: pastoral > 0,
          note: pastoral > 0 ? 'Welfare support is already engaged with this pupil. What is in that record is not in this list — speak to the welfare lead.' : null,
          signals: { attendancePct, behaviourPoints: b?.points ?? 0, resultDrop: drop },
        },
        notifyAbove,
        // in-app only, and no reasons in the words: a wellbeing alert that arrives as a push lands on
        // a lock screen the child, a sibling or a neighbour on the same phone can read
        announce: { role, eventKey: 'forecast.wellbeing', channels: ['in_app'], title: `${s.first_name} ${s.last_name ?? ''} should be seen this week`, body: 'The wellbeing watchlist has the reasons. This message deliberately does not.' },
      });
      if (r.saved) scored++;
      if (r.flagged) flagged++;
      if (r.cleared) cleared++;
    }
    return {
      asOf, students: students.length, scored, flagged, cleared,
      assumptions: {
        windowDays, notifyAbove,
        weights: 'attendance below 85% up to 40, negative behaviour points up to 30, a fall of 5+ marks up to 20, and 20 more only when welfare is already involved AND something measurable is also wrong',
        alertedRole: role,
      },
      blindSpots: [
        'welfare involvement is counted but never described, and never scores on its own — a pupil in counselling whose attendance, marks and behaviour are fine does not appear here at all.',
        'a pupil with no attendance register, no marks and no incidents scores nothing: silence in the data is not evidence that all is well.',
        'nothing outside school is visible — family illness, money trouble, a move, a bereavement — and those are often the whole story.',
      ],
      disclaimer: 'A list of pupils to look at, not a diagnosis. Every name on it needs a person to make the judgement.',
    } satisfies Projected & Record<string, unknown>;
  }

  /** The watchlist a welfare lead opens: the scores this module wrote, newest and highest first. */
  async wellbeingWatchlist(schoolId: string, minScore = 40) {
    const rows = await this.analytics.risks(schoolId, { riskType: 'wellbeing', minScore });
    return {
      minScore, students: rows,
      disclaimer: 'A list of pupils to look at, not a diagnosis. Every name on it needs a person to make the judgement.',
    };
  }

  // ------------------------------------------------------------ scheduled ----
  jobs(): Record<string, ScheduledFn> {
    return {
      /**
       * Once a month, after the billing run has settled: project the cash and the staffing, and put
       * the two figures that need a decision in front of the office. It changes nothing — a
       * projected shortfall raises a message, never an invoice, a reminder or a fee increase.
       */
      'forecast.monthly': async ({ schoolId }) => {
        const cash = await this.cashFlow(schoolId);
        const staffing = await this.staffing(schoolId);
        if (cash.shortfallMonths.length) {
          await this.notifications.notifyRole(schoolId, 'admin', {
            channels: ['in_app'], eventKey: 'forecast.cash_shortfall',
            title: `Cash is projected to run out in ${cash.shortfallMonths[0]}`,
            body: `On this school's own collection rate of ${cash.assumptions.collectionRate ?? 0}%, ${cash.shortfallMonths.length} of the next ${cash.horizonMonths} months close below zero. Open the forecast for the assumptions before acting on it.`,
            entityType: 'forecast.cash_flow', entityId: cash.from ?? schoolId,
          });
        }
        await this.outbox.emitNow({ type: 'forecast.cash_projected', schoolId, aggregateType: 'forecast.cash_flow', aggregateId: cash.from ?? schoolId, payload: { horizonMonths: cash.horizonMonths, collectionRate: (cash.assumptions.collectionRate as number | null) ?? null, projectedNet: cash.totals.net, shortfallMonths: cash.shortfallMonths.length, worstMonth: cash.worstMonth?.month ?? null } });
        if (staffing.totals.uncoveredPeriods > 0) {
          const worst = staffing.subjects.filter(s => s.uncoveredPeriods > 0).slice(0, 3).map(s => `${s.subject} (${s.uncoveredPeriods})`).join(', ');
          await this.notifications.notifyRole(schoolId, 'admin', {
            channels: ['in_app'], eventKey: 'forecast.staffing_gap',
            title: `${staffing.totals.uncoveredPeriods} periods a week have nobody to teach them`,
            body: `${worst}${staffing.totals.subjectsAffected > 3 ? ` and ${staffing.totals.subjectsAffected - 3} more` : ''}. About ${staffing.totals.teachersNeeded} teacher(s) short by ${staffing.until}.`,
            entityType: 'forecast.staffing', entityId: schoolId,
          });
          await this.outbox.emitNow({ type: 'forecast.staffing_gap', schoolId, aggregateType: 'forecast.staffing', aggregateId: schoolId, payload: { asOf: staffing.asOf, subjects: staffing.totals.subjectsAffected, uncoveredPeriods: staffing.totals.uncoveredPeriods, teachersNeeded: staffing.totals.teachersNeeded } });
        }
        return { months: cash.months.length, shortfallMonths: cash.shortfallMonths.length, uncoveredPeriods: staffing.totals.uncoveredPeriods, teachersNeeded: staffing.totals.teachersNeeded };
      },
      'forecast.wellbeing': async ({ schoolId }) => this.computeWellbeing(schoolId),
    };
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** A rate held to four places, so the percentage the response reports reproduces the figures exactly. */
const rate4 = (v: number) => Math.round(clamp01(v) * 10_000) / 10_000;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
};
const addDays = (date: string, days: number) => { const d = new Date(`${date.slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
/** Month arithmetic on 'YYYY-MM' strings; day-of-month never enters it, so no 31st ever lands in February. */
const addMonths = (month: string, delta: number) => {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const total = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
};
const lastDayOf = (month: string) => `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
