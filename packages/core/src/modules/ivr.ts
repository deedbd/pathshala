import { createHash, timingSafeEqual } from 'node:crypto';
import type { Db, Row } from '@pathshala/db';
import { nowSql } from '@pathshala/db';
import type { OutboxService } from '../automation/outbox.js';
import type { SettingsService } from '../settings.js';
import { decryptSecret, encryptSecret, normalizeBdPhone } from '../util.js';
import { HttpError, badRequest } from '../context.js';
import type { PeopleService, GuardianChild } from './people.js';
import type { FrontOfficeService } from './frontoffice.js';
import type { AttendanceService } from './attendance.js';
import type { AssessmentService } from './assessment.js';
import type { AiService } from './ai.js';

export type IvrLocale = 'bn' | 'en';
export interface IvrStepInput {
  /** The gateway's own id for this call. One call is one line in the register, however many steps it takes. */
  callId: string;
  /** Caller ID as the gateway saw it. */
  from: string;
  /** Every key pressed so far, in order — see the note on why this service keeps no state of its own. */
  keys?: string;
}
export interface IvrReply {
  callId: string;
  /** The exact words the gateway reads out. Nothing else is spoken. */
  say: string;
  locale: IvrLocale;
  /** The digits the gateway should accept next; empty when the call is over. */
  accept: string;
  /** Everything pressed so far, for the gateway to hand back with the next step. */
  keys: string;
  end: boolean;
}

type Topic = 'attendance' | 'fees' | 'exam' | 'result' | 'callback';
interface MenuItem { key: string; topic: Topic; prompt: Record<IvrLocale, string>; label: string }

/**
 * The menu, as data. Five choices and no sub-menus: a caller holding a phone to their ear remembers
 * about five things, and an IVR that reads out a long menu loses them before the useful option.
 * The order is what people actually ring a school about, commonest first.
 */
const MENU: MenuItem[] = [
  { key: '1', topic: 'attendance', label: 'attendance', prompt: { bn: 'আজকের হাজিরা জানতে ১ চাপুন।', en: 'Press 1 for today’s attendance.' } },
  { key: '2', topic: 'fees', label: 'fees due', prompt: { bn: 'বকেয়া টাকা জানতে ২ চাপুন।', en: 'Press 2 for fees due.' } },
  { key: '3', topic: 'exam', label: 'next exam', prompt: { bn: 'পরের পরীক্ষার তারিখ জানতে ৩ চাপুন।', en: 'Press 3 for the next exam.' } },
  { key: '4', topic: 'result', label: 'last result', prompt: { bn: 'শেষ পরীক্ষার ফল জানতে ৪ চাপুন।', en: 'Press 4 for the last result.' } },
  { key: '9', topic: 'callback', label: 'callback', prompt: { bn: 'অফিস থেকে ফোন পেতে ৯ চাপুন।', en: 'Press 9 to have the office call you back.' } },
];

/** Everything the IVR can say, in both languages. Written to be read aloud, not read on a screen. */
const LINES = {
  // no religious greeting: the same line is read out by a madrasa, a kindergarten and a mission school
  welcome: { bn: (school: string) => `${school} এ আপনাকে স্বাগতম।`, en: (school: string) => `Welcome to ${school}.` },
  whichChild: { bn: 'কোন সন্তানের কথা জানতে চান?', en: 'Which child?' },
  childKey: { bn: (name: string, key: string) => `${name} এর জন্য ${key} চাপুন।`, en: (name: string, key: string) => `Press ${key} for ${name}.` },
  // a guardian with one child is not asked to choose, but is told whose record they have reached —
  // otherwise the first thing they hear is a number with no name attached to it
  oneChild: { bn: (name: string) => `${name} এর বিষয়ে বলছি।`, en: (name: string) => `This is about ${name}.` },
  notCaught: { bn: 'দুঃখিত, বুঝতে পারিনি।', en: 'Sorry, I did not catch that.' },
  giveUp: { bn: 'দুঃখিত, বুঝতে পারিনি। অনুগ্রহ করে আবার ফোন করুন বা স্কুল অফিসে যোগাযোগ করুন। ধন্যবাদ।', en: 'Sorry, I did not catch that. Please call again or contact the school office. Thank you.' },
  again: { bn: 'আবার মেনু শুনতে ০ চাপুন।', en: 'Press 0 to hear the menu again.' },
  // A number we do not know is told the truth and nothing else: no names, no numbers, no questions.
  notOnFile: { bn: 'এই নম্বরটি আমাদের খাতায় নেই। অনুগ্রহ করে স্কুল অফিসে যোগাযোগ করুন। ধন্যবাদ।', en: 'We do not have this number on our records. Please contact the school office. Thank you.' },
  noChildren: { bn: 'এই নম্বরে এখন আমাদের কোনো শিক্ষার্থী নেই। অনুগ্রহ করে স্কুল অফিসে যোগাযোগ করুন। ধন্যবাদ।', en: 'No student is on this number now. Please contact the school office. Thank you.' },
  busy: { bn: 'এখন লাইন ব্যস্ত। অনুগ্রহ করে কিছুক্ষণ পরে আবার ফোন করুন।', en: 'The line is busy. Please call again in a few minutes.' },
  callback: { bn: 'ঠিক আছে। অফিস থেকে আপনাকে ফোন করা হবে। ধন্যবাদ।', en: 'Thank you. The office will call you back.' },
  bye: { bn: 'ধন্যবাদ।', en: 'Thank you.' },
  present: { bn: (n: string) => `আজ ${n} স্কুলে উপস্থিত আছে।`, en: (n: string) => `${n} is present at school today.` },
  absent: { bn: (n: string) => `আজ ${n} অনুপস্থিত।`, en: (n: string) => `${n} is absent today.` },
  late: { bn: (n: string) => `আজ ${n} দেরিতে এসেছে।`, en: (n: string) => `${n} came in late today.` },
  halfDay: { bn: (n: string) => `আজ ${n} অর্ধেক দিন ছিল।`, en: (n: string) => `${n} was in for half the day today.` },
  excused: { bn: (n: string) => `আজ ${n} ছুটিতে আছে।`, en: (n: string) => `${n} is on approved leave today.` },
  holiday: { bn: 'আজ স্কুল বন্ধ।', en: 'The school is closed today.' },
  notMarked: { bn: (n: string) => `${n} এর আজকের হাজিরা এখনো নেওয়া হয়নি।`, en: (n: string) => `Attendance for ${n} has not been taken yet today.` },
  dues: { bn: (n: string, amount: string, bills: string) => `${n} এর বকেয়া ${amount} টাকা, ${bills}।`, en: (n: string, amount: string, bills: string) => `${n} owes ${amount} taka on ${bills}.` },
  bills: { bn: (n: string, _one: boolean) => `${n} টি বিলে`, en: (n: string, one: boolean) => `${n} ${one ? 'bill' : 'bills'}` },
  noDues: { bn: (n: string) => `${n} এর কোনো বকেয়া নেই।`, en: (n: string) => `There is nothing outstanding for ${n}.` },
  nextExam: { bn: (name: string, date: string) => `পরের পরীক্ষা ${name}, শুরু ${date}।`, en: (name: string, date: string) => `The next exam is ${name}, starting ${date}.` },
  noExam: { bn: 'সামনে কোনো পরীক্ষার তারিখ দেওয়া হয়নি।', en: 'No exam is scheduled yet.' },
  result: { bn: (n: string, exam: string, gpa: string, grade: string) => `${exam} পরীক্ষায় ${n} পেয়েছে জিপিএ ${gpa}, গ্রেড ${grade}।`, en: (n: string, exam: string, gpa: string, grade: string) => `In ${exam}, ${n} got GPA ${gpa}, grade ${grade}.` },
  noResult: { bn: (n: string) => `${n} এর কোনো ফল এখনো প্রকাশ হয়নি।`, en: (n: string) => `No result has been published for ${n} yet.` },
} as const;

const MONTHS: Record<IvrLocale, string[]> = {
  bn: ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Keys are spoken as the school's own numerals, so a Bangla TTS reads “১” and not “one”. */
const speakNumber = (v: number | string, locale: IvrLocale) => (locale === 'bn' ? String(v).replace(/\d/g, d => BN_DIGITS[Number(d)]) : String(v));
const speakDate = (isoDate: string, locale: IvrLocale) => {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const month = MONTHS[locale][(m || 1) - 1];
  return locale === 'bn' ? `${speakNumber(d, 'bn')} ${month} ${speakNumber(y, 'bn')}` : `${d} ${month} ${y}`;
};

/** How many keys one call may press before we hang up, and how many misses before we stop asking. */
const MAX_KEYS = 12;
const MAX_MISSES = 3;
/** Per caller number, per process. A flood from one number must not become a flood of queries. */
const STEPS_PER_WINDOW = 40;
const WINDOW_MS = 5 * 60_000;

/**
 * The voice line. A guardian who cannot read gets nothing out of an SMS, a portal or a PDF — they
 * ring the school, and today somebody in the office has to look everything up by hand. This answers
 * the four questions they actually ring about, from the school's own rows, out loud, in Bangla.
 *
 * It is the inbound half of the voice channel (the outbound half is the voice adapter that places
 * broadcast calls). A generic Bangladeshi IVR gateway drives it: the gateway answers the phone and
 * posts one HTTP request per step, and this returns what to say next, which keys to accept, and
 * whether to hang up.
 *
 * Three rules hold everywhere in here:
 *
 * 1. **No state of its own.** Everything pressed so far comes back with each step, so a Passenger
 *    process recycled between two key presses does not drop the caller mid-call — which on shared
 *    hosting happens every day.
 * 2. **A caller ID is not proof of identity.** It is enough to say what is already sent to that same
 *    number by SMS — attendance, dues, exam dates, a result — and never enough for anything else. A
 *    number we do not know is told so politely and asked to contact the office: it is never asked for
 *    a password, a date of birth or an admission number, because a caller who could be anybody must
 *    not be taught to hand those over on the phone.
 * 3. **A guardian only ever hears about their own children.** The child is chosen by position in the
 *    caller's own list, so there is no id to tamper with and no way to reach a child they are not a
 *    guardian of.
 */
export class IvrService {
  private hits = new Map<string, number[]>();

  constructor(
    private db: Db,
    private settings: SettingsService,
    private outbox: OutboxService,
    private people: PeopleService,
    private frontOffice: FrontOfficeService,
    private attendance: AttendanceService,
    private assessment: AssessmentService,
    private ai: AiService,
    private appKey: string,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  // ---------- the gateway's credentials ----------
  /**
   * The shared secret the gateway sends with every step. `IVR_SECRET` in `.env` covers the usual
   * one-school cPanel install; a per-school setting covers a host serving several schools. It is
   * stored encrypted (as `{ enc }`, valid JSON on every engine) because settings are readable by
   * anyone who can read the settings table.
   */
  async setSecret(schoolId: string, secret: string) {
    if (secret.length < 12) throw badRequest('use a secret of at least 12 characters');
    await this.settings.set(schoolId, 'ivr.webhook_secret', { enc: encryptSecret(secret, this.appKey) });
    return { configured: true };
  }
  private async secretFor(schoolId: string): Promise<string | null> {
    const fromEnv = this.env.IVR_SECRET?.trim();
    if (fromEnv) return fromEnv;
    const stored = await this.settings.get<{ enc?: string }>(schoolId, 'ivr.webhook_secret');
    if (!stored?.enc) return null;
    try { return decryptSecret(stored.enc, this.appKey); } catch { return null; }
  }
  /**
   * Refuses anything that does not carry the secret, in constant time. An IVR with no secret
   * configured is closed rather than open: a webhook that anybody may call is a way to ask a school
   * about any of its guardians, one caller ID at a time.
   */
  async authenticate(schoolId: string, given: string | undefined) {
    const expected = await this.secretFor(schoolId);
    if (!expected) throw new HttpError(403, 'the IVR webhook is not configured for this school', 'ivr_not_configured');
    const a = Buffer.from(expected), b = Buffer.from(String(given ?? ''));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(403, 'bad IVR secret', 'forbidden');
  }
  /** The school the gateway is calling for, by id or by its short code (whichever the school configured). */
  async resolveSchool(idOrCode: string) {
    return (await this.db.findOne<Row>('schools', { id: idOrCode })) ?? (await this.db.findOne<Row>('schools', { code: idOrCode }));
  }

  // ---------- one step of a call ----------
  async step(school: Row, input: IvrStepInput): Promise<IvrReply> {
    const schoolId = String(school.id);
    const locale: IvrLocale = String(school.locale) === 'en' ? 'en' : 'bn';
    const schoolName = locale === 'bn' ? String(school.name_bn ?? school.name) : String(school.name);
    const callId = input.callId.slice(0, 120);
    const phone = normalizeBdPhone(input.from) ?? input.from.trim().slice(0, 20);
    const keys = (input.keys ?? '').replace(/\D/g, '').slice(0, MAX_KEYS + 1);
    const reply = (say: string, accept: string, end: boolean): IvrReply => ({ callId, say, locale, accept, keys, end });

    // the flood guard speaks rather than erroring: the caller must hear something, and there is
    // nothing here worth brute-forcing anyway — the secret was already checked at the door
    if (this.throttled(phone)) return reply(LINES.busy[locale], '', true);

    const { guardianId, guardianName, children } = await this.people.childrenOfPhone(schoolId, phone);
    if (!guardianId || !children.length) {
      const say = guardianId ? LINES.noChildren[locale] : LINES.notOnFile[locale];
      // logged all the same: a school should see which numbers rang and got nowhere
      await this.record(schoolId, callId, phone, guardianName, guardianId ? 'IVR (no active student)' : 'IVR (number not on file)', `[-] ${say}`, { known: !!guardianId, children: 0 });
      return reply(say, '', true);
    }
    // nine is as many as anyone can choose from one keypad
    const chooseFrom = children.slice(0, 9);
    const walked = this.walk(keys, chooseFrom);
    await this.record(schoolId, callId, phone, guardianName, this.purpose(walked.visited), null, { known: true, children: children.length });

    if (keys.length > MAX_KEYS || walked.misses >= MAX_MISSES) {
      const say = LINES.giveUp[locale];
      await this.record(schoolId, callId, phone, guardianName, null, `[-] ${say}`, null);
      return reply(say, '', true);
    }
    if (walked.stage === 'child') {
      const say = [keys.length ? '' : LINES.welcome[locale](schoolName), walked.misses ? LINES.notCaught[locale] : '', LINES.whichChild[locale],
        ...chooseFrom.map((c, i) => LINES.childKey[locale](this.childName(c, locale), speakNumber(i + 1, locale)))].filter(Boolean).join(' ');
      return reply(say, chooseFrom.map((_, i) => String(i + 1)).join(''), false);
    }
    if (walked.stage === 'menu' || !walked.topic) {
      const opening = keys.length ? '' : `${LINES.welcome[locale](schoolName)}${chooseFrom.length === 1 ? ` ${LINES.oneChild[locale](this.childName(chooseFrom[0], locale))}` : ''}`;
      const say = [opening, walked.misses ? LINES.notCaught[locale] : '', ...MENU.map(m => m.prompt[locale])].filter(Boolean).join(' ');
      return reply(say, MENU.map(m => m.key).join(''), false);
    }

    const child = walked.child!;
    const answer = await this.answer(school, locale, child, walked.topic, { callId, phone, guardianId, guardianName });
    await this.record(schoolId, callId, phone, guardianName, null, `[${walked.topic.key}] ${answer.say}`, null);
    if (answer.end) return reply(answer.say, '', true);
    // after an answer the caller may press any menu key straight away, or 0 to hear the menu again
    return reply(`${answer.say} ${LINES.again[locale]}`, `0${MENU.map(m => m.key).join('')}`, false);
  }

  /**
   * Replays every key of the call from the start. Reads are the same however often they are replayed,
   * and the one step that writes anything (the callback) is made idempotent by the call id — so a
   * gateway that retries a step, as they all do on a timeout, costs the school nothing.
   */
  private walk(keys: string, children: GuardianChild[]) {
    // one child needs no chooser: asking "which child?" of a guardian who has one is just a delay
    let stage: 'child' | 'menu' | 'answer' = children.length > 1 ? 'child' : 'menu';
    let child: GuardianChild | null = children[0] ?? null;
    let topic: MenuItem | null = null;
    let misses = 0;
    const visited: MenuItem[] = [];
    for (const k of keys) {
      if (stage === 'child') {
        const pick = children[Number(k) - 1];
        if (pick) { child = pick; stage = 'menu'; misses = 0; } else misses++;
        continue;
      }
      if (k === '0') { topic = null; stage = 'menu'; misses = 0; continue; }
      const item = MENU.find(m => m.key === k);
      if (item) { topic = item; stage = 'answer'; misses = 0; visited.push(item); }
      else { topic = null; stage = 'menu'; misses++; }
    }
    return { stage, child, topic, misses, visited };
  }

  // ---------- the answers, from the school's own rows ----------
  private async answer(school: Row, locale: IvrLocale, child: GuardianChild, item: MenuItem, call: { callId: string; phone: string; guardianId: string; guardianName: string }): Promise<{ say: string; end: boolean }> {
    const schoolId = String(school.id);
    const name = this.childName(child, locale);
    if (item.topic === 'attendance') {
      // the school's own date, not UTC: a guardian ringing before dawn in Dhaka is asking about the
      // register that opens in two hours, and UTC would answer about yesterday
      const today = this.schoolDate(school);
      const marks = await this.attendance.studentHistory(schoolId, child.id, today, today);
      const status = marks[0] ? String(marks[0].status) : null;
      const said = status === 'present' ? LINES.present[locale](name)
        : status === 'absent' ? LINES.absent[locale](name)
        : status === 'late' ? LINES.late[locale](name)
        : status === 'half_day' ? LINES.halfDay[locale](name)
        : status === 'excused' ? LINES.excused[locale](name)
        : status === 'holiday' ? LINES.holiday[locale]
        : LINES.notMarked[locale](name);
      return { say: said, end: false };
    }
    if (item.topic === 'fees') {
      // the assistant already owns this query; the IVR borrows the numbers and says them in Bangla
      const { due, bills } = await this.ai.outstandingFor(schoolId, [child.id]);
      // paisa on the telephone helps nobody: whole taka is what a guardian carries to the office
      const billsPhrase = LINES.bills[locale](speakNumber(bills, locale), bills === 1);
      return { say: due > 0 ? LINES.dues[locale](name, speakNumber(Math.round(due), locale), billsPhrase) : LINES.noDues[locale](name), end: false };
    }
    if (item.topic === 'exam') {
      const exam = await this.ai.nextExam(schoolId);
      return { say: exam ? LINES.nextExam[locale](String(exam.name), speakDate(String(exam.startDate), locale)) : LINES.noExam[locale], end: false };
    }
    if (item.topic === 'result') {
      const last = await this.lastResult(schoolId, child.id);
      return { say: last ? LINES.result[locale](name, last.exam, speakNumber(Number(last.gpa).toFixed(2), locale), String(last.grade)) : LINES.noResult[locale](name), end: false };
    }
    // 9: the one thing this call can change. The task is raised by the call register, keyed by the
    // call id, so a replayed step never asks the office to ring the same guardian twice.
    const followUpAt = nowSql(new Date(Date.now() + 4 * 3600_000));
    const r = await this.frontOffice.recordCall(schoolId, this.callRowId(schoolId, call.callId), {
      direction: 'inbound', phone: call.phone, callerName: call.guardianName, followUpAt, relatedType: 'ivr.call', relatedId: child.id,
    });
    if (r.followUpRaised) {
      await this.outbox.emitNow({ type: 'ivr.callback_requested', schoolId, aggregateType: 'frontoffice.call', aggregateId: r.id, payload: { callId: call.callId, phone: call.phone, guardianId: call.guardianId, studentId: child.id } });
    }
    return { say: LINES.callback[locale], end: true };
  }

  /**
   * The most recent published exam this child has a result in. Exams come back newest first, and a
   * child who joined in the middle of the year has no row in the older ones — so it walks down until
   * it finds one rather than assuming the newest exam is theirs.
   */
  private async lastResult(schoolId: string, studentId: string) {
    const exams = (await this.assessment.exams(schoolId)).filter(e => String(e.status) === 'published').slice(0, 5);
    for (const exam of exams) {
      const { result } = await this.assessment.studentResult(schoolId, String(exam.id), studentId);
      if (result) return { exam: String(exam.name), gpa: Number(result.gpa ?? 0), grade: String(result.grade ?? '') };
    }
    return null;
  }

  // ---------- the register ----------
  /**
   * One line per call in the front office's call register, so the school can see who rang, what they
   * asked and what they were told. The row id is derived from the gateway's call id, which is what
   * makes every step of the call — and every retry of a step — land on the same line.
   */
  private async record(schoolId: string, callId: string, phone: string, callerName: string, purpose: string | null, note: string | null, first: { known: boolean; children: number } | null) {
    const r = await this.frontOffice.recordCall(schoolId, this.callRowId(schoolId, callId), { direction: 'inbound', phone, callerName: callerName || null, purpose, note, relatedType: 'ivr.call' });
    if (r.created && first) await this.outbox.emitNow({ type: 'ivr.call_received', schoolId, aggregateType: 'frontoffice.call', aggregateId: r.id, payload: { callId, phone, known: first.known, children: first.children } });
    return r;
  }
  /** Recent calls the voice line handled (the register itself is the front office's). */
  async calls(schoolId: string, limit = 100) { return this.frontOffice.calls(schoolId, limit, 'ivr.call'); }
  /** What the line says today, for the console to show and for the school to check before going live. */
  menu(school: Row) {
    const locale: IvrLocale = String(school.locale) === 'en' ? 'en' : 'bn';
    return { locale, welcome: LINES.welcome[locale](locale === 'bn' ? String(school.name_bn ?? school.name) : String(school.name)), choices: MENU.map(m => ({ key: m.key, topic: m.topic, says: m.prompt[locale] })) };
  }

  // ---------- small helpers ----------
  private childName(c: GuardianChild, locale: IvrLocale) {
    return (locale === 'bn' && c.name_bn ? String(c.name_bn) : `${c.first_name} ${c.last_name ?? ''}`.trim()) || String(c.first_name);
  }
  private purpose(visited: MenuItem[]) {
    const seen = [...new Set(visited.map(m => m.label))];
    return `IVR${seen.length ? `: ${seen.join(', ')}` : ''}`.slice(0, 160);
  }
  /** Today where the school is. `schools.timezone` is Asia/Dhaka unless the school changed it. */
  private schoolDate(school: Row) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: String(school.timezone || 'Asia/Dhaka'), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  /**
   * A stable 26-character id for the call row, derived from the gateway's call id. `call_logs.id` is
   * a ULID column and a gateway's id is any string it likes, so it is folded into the ULID alphabet
   * rather than stored as it came.
   */
  private callRowId(schoolId: string, callId: string) {
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    // a real hash, not a cheap one: two calls that collided would become one line in the register
    let h = 0n;
    for (const b of createHash('sha256').update(`${schoolId}:${callId}`).digest().subarray(0, 16)) h = (h << 8n) | BigInt(b);
    let out = '';
    for (let i = 0; i < 26; i++) { out = ALPHABET[Number(h % 32n)] + out; h /= 32n; }
    return out;
  }
  private throttled(phone: string) {
    const recent = (this.hits.get(phone) ?? []).filter(t => Date.now() - t < WINDOW_MS);
    recent.push(Date.now());
    this.hits.set(phone, recent);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some(t => Date.now() - t < WINDOW_MS)) this.hits.delete(k);
    return recent.length > STEPS_PER_WINDOW;
  }
}
