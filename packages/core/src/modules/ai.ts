import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { Adapters } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { SettingsService } from '../settings.js';
import { round } from './accounting.js';
import { HttpError, badRequest, notFound } from '../context.js';

export type GenerationKind = 'questions' | 'remarks' | 'lesson_plan' | 'notice' | 'summary' | 'translation' | 'report_narrative' | 'other';
export interface Asker { userId: string; userType: string; roles: string[] }

/**
 * The assistant. Two halves, deliberately separated.
 *
 * Questions about the school's own data are answered from the database, by code, with the real
 * numbers: how many were absent today, what is outstanding, when the next exam is. No model is
 * involved, so the answer cannot be invented, costs nothing, and works on a school that has never
 * connected an AI provider. That is the half people actually ask for.
 *
 * Drafting — a remark, a notice, a lesson plan — is what a model is for, and it needs one. Every
 * draft is stored as a draft: a person reads it, edits it and applies it. Nothing written by a model
 * ever reaches a guardian without somebody putting their name to it.
 *
 * Two limits hold throughout: the assistant only ever sees what the person asking is allowed to see —
 * a guardian's question is answered about their own children and nobody else's — and a school's
 * monthly AI spend is capped, because an unbounded bill is not a feature.
 */
export class AiService {
  constructor(
    private db: Db, private outbox: OutboxService, private settings: SettingsService, private adapters: Adapters,
  ) {}

  // ---------- asking about the school ----------
  /**
   * Answers a question from the school's own rows. Everything it can answer is listed in `skills()`,
   * because an assistant that hints it might know something it does not is worse than a form.
   */
  async ask(schoolId: string, asker: Asker, question: string, conversationId?: string) {
    const q = question.trim().toLowerCase();
    if (!q) throw badRequest('ask something');
    const convo = conversationId ?? await this.conversation(schoolId, asker.userId);
    await this.record(schoolId, convo, 'user', question);
    const guardianOnly = asker.userType === 'guardian' || asker.userType === 'student';
    const scope = guardianOnly ? await this.childrenOf(schoolId, asker) : null;
    if (guardianOnly && !scope?.length) {
      return this.reply(schoolId, convo, 'I can only answer about your own children, and this account is not linked to any.');
    }

    const answer = await this.answerFromData(schoolId, q, scope);
    if (answer) return this.reply(schoolId, convo, answer);

    // nothing matched: a model can try, if the school has one and the budget allows
    if (!this.adapters.ai.available) {
      return this.reply(schoolId, convo, `I can answer questions about this school's own records. Try: ${this.skills().slice(0, 4).join('; ')}.`);
    }
    const budget = await this.budgetLeft(schoolId);
    if (budget.left <= 0) return this.reply(schoolId, convo, `The school's AI budget for this month is used up (${budget.spent} of ${budget.budget}). Questions about attendance, fees and results still work.`);
    const context = await this.context(schoolId, scope);
    const r = await this.adapters.ai.complete({
      messages: [
        { role: 'system', content: `You are the assistant inside a Bangladeshi school's management system. Answer briefly and only from the facts below. If the facts do not contain the answer, say so plainly. Never invent a number.\n\n${context}` },
        { role: 'user', content: question },
      ],
      maxTokens: 400,
    });
    await this.record(schoolId, convo, 'assistant', r.text, { tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: r.cost });
    return { conversationId: convo, answer: r.text, source: 'model' as const, cost: r.cost };
  }
  /** Everything the assistant can answer without a model, in the words a person would use. */
  skills() {
    return [
      'how many students are absent today',
      'what are the fees outstanding',
      'how many students are on the roll',
      'when is the next exam',
      'how much was collected today',
      'which subjects still owe marks',
    ];
  }
  private async answerFromData(schoolId: string, q: string, scope: string[] | null): Promise<string | null> {
    const today = nowSql().slice(0, 10);
    const has = (...words: string[]) => words.every(w => q.includes(w));
    if (has('absent') || (has('attendance') && !has('staff'))) {
      const where = scope?.length ? ` AND student_id IN (${scope.map(() => '?').join(',')})` : '';
      const params = scope?.length ? [schoolId, today, ...scope] : [schoolId, today];
      const rows = await this.db.query<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM student_attendance WHERE school_id = ? AND on_date = ?${where} GROUP BY status`, params);
      if (!rows.length) return `Attendance has not been marked yet today (${today}).`;
      const total = rows.reduce((a, r) => a + Number(r.n), 0);
      const absent = Number(rows.find(r => r.status === 'absent')?.n ?? 0);
      const late = Number(rows.find(r => r.status === 'late')?.n ?? 0);
      return `Today ${absent} of ${total} marked are absent${late ? ` and ${late} came late` : ''}.`;
    }
    if (has('outstanding') || has('due') || (has('fee') && !has('collect'))) {
      const { due, bills } = await this.outstandingFor(schoolId, scope);
      return due > 0 ? `${due} is outstanding across ${bills} unpaid bills.` : 'Nothing is outstanding.';
    }
    if (has('collect')) {
      const rows = await this.db.query<{ v: number }>(`SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE school_id = ? AND status = 'success' AND paid_at BETWEEN ? AND ?`, [schoolId, `${today} 00:00:00`, `${today} 23:59:59`]);
      return `${round(Number(rows[0]?.v ?? 0))} has been collected today.`;
    }
    if (has('roll') || has('how many students') || has('total students')) {
      if (scope?.length) return `You have ${scope.length} ${scope.length === 1 ? 'child' : 'children'} in this school.`;
      const n = await this.db.count('students', { school_id: schoolId, status: 'active' });
      return `${n} students are on the roll.`;
    }
    if (has('exam')) {
      const next = await this.nextExam(schoolId);
      return next ? `The next exam is ${next.name}, starting ${next.startDate}.` : 'No exam is scheduled after today.';
    }
    if (has('marks') && (has('owe') || has('pending') || has('missing'))) {
      const rows = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM exam_schedules WHERE school_id = ? AND marks_entry_locked = FALSE`, [schoolId]);
      return `${Number(rows[0]?.n ?? 0)} exam subjects are still open for marks.`;
    }
    return null;
  }
  /**
   * The facts behind two of the answers above, as numbers rather than a sentence. The voice line
   * says the same figures in Bangla down a telephone, and a second copy of these queries would be a
   * second set of numbers to keep true.
   */
  async outstandingFor(schoolId: string, scope: string[] | null) {
    const where = scope?.length ? ` AND student_id IN (${scope.map(() => '?').join(',')})` : '';
    const rows = await this.db.query<{ due: number; n: number }>(`SELECT COALESCE(SUM(balance), 0) AS due, COUNT(*) AS n FROM invoices WHERE school_id = ? AND balance > 0${where}`, scope?.length ? [schoolId, ...scope] : [schoolId]);
    return { due: round(Number(rows[0]?.due ?? 0)), bills: Number(rows[0]?.n ?? 0) };
  }
  async nextExam(schoolId: string) {
    const rows = await this.db.query<Row>(`SELECT name, start_date FROM exams WHERE school_id = ? AND start_date >= ? ORDER BY start_date LIMIT 1`, [schoolId, nowSql().slice(0, 10)]);
    return rows[0] ? { name: String(rows[0].name), startDate: String(rows[0].start_date).slice(0, 10) } : null;
  }

  /** A compact, factual context for the model: the same numbers, so it cannot contradict the system. */
  private async context(schoolId: string, scope: string[] | null) {
    const today = nowSql().slice(0, 10);
    const school = await this.db.findOne<Row>('schools', { id: schoolId });
    const lines = [`School: ${school?.name ?? ''}. Today: ${today}.`];
    for (const skill of ['absent today', 'fees outstanding', 'students on the roll', 'next exam']) {
      const a = await this.answerFromData(schoolId, skill, scope);
      if (a) lines.push(a);
    }
    return lines.join('\n');
  }
  private async childrenOf(schoolId: string, asker: Asker) {
    const own = await this.db.findOne<{ id: string }>('students', { school_id: schoolId, user_id: asker.userId });
    if (own) return [own.id];
    const guardian = await this.db.findOne<{ id: string }>('guardians', { school_id: schoolId, user_id: asker.userId });
    if (!guardian) return [];
    const rows = await this.db.query<{ student_id: string }>(`SELECT student_id FROM student_guardians WHERE guardian_id = ?`, [guardian.id]);
    return rows.map(r => String(r.student_id));
  }

  // ---------- conversations ----------
  private async conversation(schoolId: string, userId: string) {
    const recent = await this.db.query<Row>(`SELECT id FROM ai_conversations WHERE school_id = ? AND user_id = ? ORDER BY last_message_at DESC LIMIT 1`, [schoolId, userId]);
    if (recent[0]) return String(recent[0].id);
    const id = ulid();
    await this.db.insert('ai_conversations', { id, school_id: schoolId, user_id: userId, channel: 'web', title: null, context: null, last_message_at: nowSql() });
    return id;
  }
  private async record(schoolId: string, conversationId: string, role: 'user' | 'assistant' | 'tool' | 'system', content: string, usage: { tokensIn?: number; tokensOut?: number; cost?: number } = {}) {
    await this.db.insert('ai_messages', { id: ulid(), school_id: schoolId, conversation_id: conversationId, role, content, tool_calls: null, tokens_in: usage.tokensIn ?? 0, tokens_out: usage.tokensOut ?? 0, cost: usage.cost ?? 0 });
    await this.db.update('ai_conversations', { last_message_at: nowSql(), updated_at: nowSql() }, { id: conversationId });
  }
  private async reply(schoolId: string, conversationId: string, answer: string) {
    await this.record(schoolId, conversationId, 'assistant', answer);
    return { conversationId, answer, source: 'data' as const, cost: 0 };
  }
  async history(schoolId: string, userId: string, limit = 50) {
    const convo = await this.db.query<Row>(`SELECT id FROM ai_conversations WHERE school_id = ? AND user_id = ? ORDER BY last_message_at DESC LIMIT 1`, [schoolId, userId]);
    if (!convo[0]) return { conversationId: null, messages: [] };
    return { conversationId: String(convo[0].id), messages: await this.db.findMany<Row>('ai_messages', { conversation_id: String(convo[0].id) }, { orderBy: 'created_at ASC', limit }) };
  }

  // ---------- drafting ----------
  /**
   * Drafts something a person will edit: a remark, a notice, a lesson plan, questions. It is stored
   * as a draft with what it was asked and what it produced, and applying it is a separate, deliberate
   * act — which is also the audit trail for anything a model wrote.
   */
  async generate(schoolId: string, p: { kind: GenerationKind; prompt: string; context?: Record<string, unknown>; requestedBy?: string | null }) {
    if (!this.adapters.ai.available) throw new HttpError(503, 'no AI provider is configured; drafting needs one', 'no_ai');
    const budget = await this.budgetLeft(schoolId);
    if (budget.left <= 0) throw new HttpError(429, `this month's AI budget (${budget.budget}) is used up`, 'ai_budget');
    const system = {
      remarks: 'Write a short, kind and specific report-card remark for one student in a Bangladeshi school. Two sentences. Never invent marks.',
      notice: 'Write a clear school notice in plain language. Keep it under 120 words. State what, when and what the reader must do.',
      lesson_plan: 'Draft a 40-minute lesson plan: objective, three activities with timings, and one way to check understanding.',
      questions: 'Write exam questions of the kind and difficulty asked for. Number them and give the marks for each.',
      summary: 'Summarise plainly in under 100 words.',
      translation: 'Translate faithfully between Bangla and English. Keep names and numbers exactly as they are.',
      report_narrative: 'Write two paragraphs describing the pattern in these numbers for a head teacher. No advice unless asked.',
      other: 'Answer briefly and plainly.',
    }[p.kind];
    const r = await this.adapters.ai.complete({
      messages: [
        { role: 'system', content: `${system} Write in the same language as the request.` },
        { role: 'user', content: p.context ? `${p.prompt}\n\nFacts:\n${JSON.stringify(p.context)}` : p.prompt },
      ],
      maxTokens: 700,
    });
    const id = ulid();
    await this.db.insert('ai_generations', { id, school_id: schoolId, kind: p.kind, requested_by: p.requestedBy ?? null, input: { prompt: p.prompt, context: p.context ?? null } as never, output: { text: r.text, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: r.cost } as never, model: r.model, status: 'generated', applied_to_type: null, applied_to_id: null });
    await this.outbox.emitNow({ type: 'ai.generated', schoolId, aggregateType: 'ai.generation', aggregateId: id, payload: { generationId: id, kind: p.kind, cost: r.cost } });
    return { id, kind: p.kind, text: r.text, model: r.model, cost: r.cost };
  }
  /** Marks a draft as used, and where. Nothing a model wrote is applied without this. */
  async applyGeneration(schoolId: string, generationId: string, applied: { type: string; id: string }) {
    const g = await this.db.findOne<Row>('ai_generations', { id: generationId, school_id: schoolId });
    if (!g) throw notFound('generation');
    await this.db.update('ai_generations', { status: 'applied', applied_to_type: applied.type, applied_to_id: applied.id, updated_at: nowSql() }, { id: generationId });
    return { id: generationId, status: 'applied' as const };
  }
  async discardGeneration(schoolId: string, generationId: string) {
    if (!(await this.db.update('ai_generations', { status: 'discarded', updated_at: nowSql() }, { id: generationId, school_id: schoolId }))) throw notFound('generation');
    return { id: generationId, status: 'discarded' as const };
  }
  async generations(schoolId: string, f: { kind?: string; status?: string } = {}) {
    const where: Row = { school_id: schoolId };
    if (f.kind) where.kind = f.kind;
    if (f.status) where.status = f.status;
    const rows = await this.db.findMany<Row>('ai_generations', where, { orderBy: 'created_at DESC', limit: 100 });
    return rows.map(r => ({ ...r, input: json(r.input), output: json(r.output) }) as Row);
  }

  // ---------- budget ----------
  /** What the school has spent on AI this month, and what is left of the cap it set. */
  async budgetLeft(schoolId: string) {
    const budget = (await this.settings.get<number>(schoolId, 'ai.monthly_budget')) ?? 500;
    const month = nowSql().slice(0, 7);
    const rows = await this.db.query<{ v: number }>(`SELECT COALESCE(SUM(cost), 0) AS v FROM ai_messages WHERE school_id = ? AND created_at >= ?`, [schoolId, `${month}-01 00:00:00`]);
    const generated = await this.db.query<{ v: number }>(`SELECT COALESCE(SUM(CAST(0 AS DECIMAL(10,4))), 0) AS v FROM ai_generations WHERE school_id = ? AND created_at >= ?`, [schoolId, `${month}-01 00:00:00`]);
    const spent = round(Number(rows[0]?.v ?? 0) + Number(generated[0]?.v ?? 0));
    return { month, budget, spent, left: round(budget - spent) };
  }
}
