import type { Db, Row } from '@pathshala/db';
import { nowSql } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { AcademicService } from './academic.js';
import type { AssessmentService } from './assessment.js';
import type { CoverageItem, LmsService } from './lms.js';
import { badRequest, notFound } from '../context.js';

export interface RevisionIndicator {
  outcomeId: string; code: string; statement: string; statementBn: string | null; subject: string;
  level: string; label: string; unitId: string | null; unitTitle: string | null;
  covered: boolean; gap: string | null;
  lessons: CoverageItem[]; quizzes: CoverageItem[]; materials: CoverageItem[];
}

/** A plan longer than this is a reading list, not something a child starts on tonight. */
const MAX_INDICATORS = 20;
/** How many indicators go into the message itself. The rest are in the plan when they open it. */
const TOP_IN_MESSAGE = 3;
/** One pass covers this many children; the next tick takes the ones it did not reach. */
const MAX_STUDENTS_PER_PASS = 200;
/** A plan sent oftener than this becomes wallpaper, and the ratings behind it move termly. */
const RESEND_AFTER_DAYS = 6;

/**
 * Adaptive learning: what one child should revise next, taken from what they were actually rated
 * against rather than from a guess.
 *
 * The competency assessments say which performance indicators a child has not met yet; the LMS says
 * which lessons, quizzes and materials teach the syllabus unit each indicator belongs to. Put
 * together, that is a revision plan naming both the gap and the way to close it.
 *
 * The rule that keeps it honest is the one about coverage. Where nothing in the library teaches an
 * indicator the plan says so — by name, as a gap for the teacher to fill — instead of recommending
 * the nearest lesson it can find. A plan that invents a recommendation sends a child to the wrong
 * chapter and teaches everybody to ignore the next one.
 *
 * Nothing is stored. A plan is derived from ratings a teacher may change tomorrow and lessons that
 * may be published this afternoon, so a saved plan would be wrong more often than right; it is built
 * when it is asked for.
 */
export class AdaptiveService {
  constructor(
    private db: Db,
    private outbox: OutboxService,
    private notifications: NotificationService,
    private academic: AcademicService,
    private assessment: AssessmentService,
    private lms: LmsService,
  ) {}

  private async termOf(schoolId: string, termId?: string | null) {
    const term = termId
      ? await this.db.findOne<Row>('terms', { id: termId, school_id: schoolId })
      : await this.academic.currentTerm(schoolId);
    if (!term) throw badRequest('this school has no term to plan against yet');
    return term;
  }

  /**
   * One child's revision plan for a term. Weakest first: a plan is three things they nearly have,
   * not thirty things they do not — a child handed every gap at once puts the list down.
   */
  async revisionPlan(schoolId: string, studentId: string, termId?: string | null) {
    const student = await this.db.findOne<Row>('students', { id: studentId, school_id: schoolId });
    if (!student) throw notFound('student');
    const term = await this.termOf(schoolId, termId);
    const name = `${student.first_name ?? ''} ${student.last_name ?? ''}`.trim();
    const report = await this.assessment.competencyReport(schoolId, studentId, String(term.id));
    const base = { studentId, name, termId: String(term.id), term: String(term.name), assessed: report.assessed, met: report.achieved };
    if (!report.assessed) {
      return { ...base, indicators: [] as RevisionIndicator[], covered: 0, uncovered: 0, gaps: [] as { code: string; statement: string; why: string }[], note: 'nobody has rated this child against the indicators this term, so there is nothing to plan from' };
    }
    const unmet = [...report.stillToMeet]
      .sort((a, b) => (a.value - b.value) || (b.weight - a.weight) || a.code.localeCompare(b.code))
      .slice(0, MAX_INDICATORS);
    const coverage = await this.lms.coverageForUnits(schoolId, unmet.map(i => i.unitId).filter((u): u is string => !!u), studentId);

    const indicators: RevisionIndicator[] = unmet.map(i => {
      const unit = i.unitId ? coverage[i.unitId] : undefined;
      const lessons = unit?.lessons ?? [];
      const quizzes = unit?.quizzes ?? [];
      const materials = unit?.materials ?? [];
      const covered = lessons.length + quizzes.length + materials.length > 0;
      // two different gaps, and they need two different people to fix them: one is a curriculum
      // mapping nobody finished, the other is a lesson nobody has written yet
      const gap = covered ? null
        : !i.unitId ? 'this indicator is not tied to a syllabus unit, so nothing in the library can be matched to it'
          : `nothing published covers ${unit?.unitTitle ? `“${unit.unitTitle}”` : 'this unit'} yet`;
      return {
        outcomeId: i.outcomeId, code: i.code, statement: i.statement, statementBn: i.statementBn, subject: i.subject,
        level: i.level, label: i.label, unitId: i.unitId, unitTitle: unit?.unitTitle ?? null,
        covered, gap, lessons, quizzes, materials,
      };
    });
    const uncovered = indicators.filter(i => !i.covered);
    return {
      ...base, indicators, covered: indicators.length - uncovered.length, uncovered: uncovered.length,
      gaps: uncovered.map(i => ({ code: i.code, statement: i.statement, why: i.gap as string })),
      note: null as string | null,
    };
  }

  /**
   * Sends the plan to the child and to whoever looks after them. Deliberately short: the three
   * indicators to work on next and where to find each one. The full plan is a tap away in the portal,
   * and an SMS that runs to fifteen lines is an SMS nobody reads.
   */
  async push(schoolId: string, studentId: string, termId?: string | null) {
    const plan = await this.revisionPlan(schoolId, studentId, termId);
    if (!plan.indicators.length) return { sent: 0, studentId, termId: plan.termId, indicators: 0, covered: 0, uncovered: 0, reason: plan.note ?? 'this child has met every indicator rated so far' };
    const top = plan.indicators.slice(0, TOP_IN_MESSAGE);
    const lines = top.map(i => {
      const first = i.lessons[0] ?? i.quizzes[0] ?? i.materials[0];
      return `${i.code} ${i.statement}${first ? ` → ${first.title}` : ' → nothing in the library covers this yet; ask the teacher'}`;
    });
    const body = `${plan.name}: ${lines.join(' · ')}`;
    let sent = 0;
    const notify = async (userId: string | null, address?: string | null) => {
      if (!userId && !address) return;
      await this.notifications.notify({
        schoolId, userId, address: address ?? null, channels: ['in_app', 'push'], eventKey: 'adaptive.revision_plan',
        title: 'What to revise this week', body, entityType: 'adaptive.revision_plan', entityId: studentId,
      });
      sent++;
    };
    await notify((await this.db.findOne<{ user_id: string | null }>('students', { id: studentId }))?.user_id ?? null);
    const guardians = await this.db.query<{ user_id: string | null; phone: string }>(
      `SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [studentId]);
    for (const g of guardians) await notify(g.user_id, g.phone);
    await this.outbox.emitNow({ type: 'revision_plan.built', schoolId, aggregateType: 'adaptive.plan', aggregateId: studentId, payload: { studentId, termId: plan.termId, indicators: plan.indicators.length, covered: plan.covered, uncovered: plan.uncovered } });
    return { sent, studentId, termId: plan.termId, indicators: plan.indicators.length, covered: plan.covered, uncovered: plan.uncovered, top: top.map(i => ({ code: i.code, statement: i.statement, covered: i.covered })) };
  }

  /**
   * The teacher's half of the same question: which indicators most of the class has not met, and what
   * the library has on each. The ones nothing covers come back as work for the teacher rather than as
   * an empty recommendation.
   */
  async classGaps(schoolId: string, f: { classSubjectId: string; termId?: string | null }) {
    const term = await this.termOf(schoolId, f.termId);
    const report = await this.assessment.competencyClassReport(schoolId, f.classSubjectId, String(term.id));
    const coverage = await this.lms.coverageForUnits(schoolId, report.outcomes.map(o => o.unitId).filter((u): u is string => !!u));
    return {
      classSubjectId: f.classSubjectId, termId: String(term.id), term: String(term.name), students: report.students,
      outcomes: report.outcomes.map(o => {
        const unit = o.unitId ? coverage[o.unitId] : undefined;
        const teaches = [...(unit?.lessons ?? []), ...(unit?.quizzes ?? []), ...(unit?.materials ?? [])];
        return {
          outcomeId: o.outcomeId, code: o.code, statement: o.statement, statementBn: o.statementBn,
          unitId: o.unitId, unitTitle: unit?.unitTitle ?? null,
          assessed: o.assessed, met: o.met, notMet: o.notMet,
          notMetPct: o.assessed ? Math.round((o.notMet * 100) / o.assessed) : 0,
          covered: teaches.length > 0,
          teaches: teaches.slice(0, 5),
          gap: teaches.length ? null : !o.unitId ? 'this indicator is not tied to a syllabus unit, so nothing can be matched to it' : 'nothing published covers this unit yet',
        };
      }),
    };
  }

  /**
   * The weekly pass. It only considers children somebody has actually rated this term — a plan built
   * from no assessment would be a message saying nothing, sent to every guardian in the school.
   *
   * The children already told this week are excluded in the query rather than skipped in the loop.
   * A plain `LIMIT 200` would hand back the same first two hundred every tick, and once they had all
   * been written to, every later pass would skip all of them and the school's remaining children
   * would never get a plan at all. Excluding them first makes the window walk forward.
   */
  async runWeekly(schoolId: string, opts: { termId?: string | null; limit?: number } = {}) {
    const term = await this.academic.currentTerm(schoolId);
    if (!term && !opts.termId) return { planned: 0, sent: 0, skipped: 0, reason: 'this school has no term to plan against yet' };
    const termId = opts.termId ?? String(term!.id);
    const limit = Math.min(MAX_STUDENTS_PER_PASS, Math.max(1, opts.limit ?? MAX_STUDENTS_PER_PASS));
    const since = this.resendCutoff();
    const candidates = await this.db.query<{ student_id: string }>(
      `SELECT DISTINCT a.student_id FROM competency_assessments a
       WHERE a.school_id = ? AND a.term_id = ?
         AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.school_id = a.school_id AND n.event_key = 'adaptive.revision_plan' AND n.entity_id = a.student_id AND n.created_at >= ?)
       LIMIT ${limit}`, [schoolId, termId, since]);
    let planned = 0, sent = 0, skipped = 0;
    for (const c of candidates) {
      const studentId = String(c.student_id);
      // a second guard, because a pass over two hundred children takes long enough for another tick
      // (or an impatient administrator on /adaptive/run) to start beside it
      if (await this.toldRecently(schoolId, studentId)) { skipped++; continue; }
      const r = await this.push(schoolId, studentId, termId);
      if (r.sent) { planned++; sent += r.sent; } else skipped++;
    }
    return { planned, sent, skipped, termId, term: String(term?.name ?? ''), considered: candidates.length };
  }

  /**
   * Whether this child was already sent a plan in the last few days. The scheduler is at-least-once
   * and a school with a heartbeat cron can tick the same job several times an hour, so the guard is
   * on what was actually delivered rather than on the job having run.
   */
  private resendCutoff() { return nowSql(new Date(Date.now() - RESEND_AFTER_DAYS * 86_400_000)); }
  private async toldRecently(schoolId: string, studentId: string) {
    const rows = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM notifications WHERE school_id = ? AND event_key = 'adaptive.revision_plan' AND entity_id = ? AND created_at >= ?`,
      [schoolId, studentId, this.resendCutoff()]);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // E8: the week's revision, named, once a week
      'adaptive.revision_plans': async ({ schoolId }) => this.runWeekly(schoolId),
    };
  }
}
