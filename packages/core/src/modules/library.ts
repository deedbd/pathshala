import type { Db, Row } from '@pathshala/db';
import { nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { FeesService } from './fees.js';
import type { NumberingService } from './numbering.js';
import { round } from './accounting.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface BookInput { isbn?: string | null; title: string; subtitle?: string | null; authors?: string[]; publisher?: string | null; edition?: string | null; publishedYear?: number | null; language?: string; categoryId?: string | null; subjectId?: string | null; classId?: string | null; pages?: number | null; price?: number | null; copies?: number }

/**
 * Library: catalogue with physical copies, members with their own limits, issue and return with a
 * daily fine that is capped at the price of the book and billed on the next invoice rather than
 * collected at the desk, a reservation queue, and reading logs. Overdue chasing and fines run as one
 * daily job so a shared host does no work per book per request.
 */
export class LibraryService {
  constructor(private db: Db, private outbox: OutboxService, private notifications: NotificationService, private numbering: NumberingService, private fees: FeesService) {}

  // ---------- catalogue ----------
  async categories(schoolId: string) { return this.db.findMany<Row>('library_categories', { school_id: schoolId }, { orderBy: 'name ASC' }); }
  async ensureCategories(schoolId: string) {
    if (await this.db.count('library_categories', { school_id: schoolId })) return 0;
    const names = ['Textbook', 'Reference', 'Story', 'Science', 'Religion', 'Biography', 'Magazine'];
    for (const name of names) await this.db.insert('library_categories', { id: ulid(), school_id: schoolId, name, parent_id: null });
    return names.length;
  }
  async books(schoolId: string, f: { q?: string; categoryId?: string } = {}) {
    const where = ['b.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.q) { where.push('(b.title LIKE ? OR b.isbn LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`); }
    if (f.categoryId) { where.push('b.category_id = ?'); params.push(f.categoryId); }
    return this.db.query<Row>(`SELECT b.*, c.name AS category_name FROM library_books b LEFT JOIN library_categories c ON c.id = b.category_id WHERE ${where.join(' AND ')} ORDER BY b.title LIMIT 500`, params);
  }
  /** Adds the title and its copies; accession numbers run in one school-wide series. */
  async addBook(schoolId: string, b: BookInput) {
    const id = ulid();
    const copies = Math.max(0, b.copies ?? 1);
    await this.db.transaction(async tx => {
      await tx.insert('library_books', {
        id, school_id: schoolId, isbn: b.isbn ?? null, title: b.title.trim(), subtitle: b.subtitle ?? null, authors: (b.authors ?? []) as never, publisher: b.publisher ?? null,
        edition: b.edition ?? null, published_year: b.publishedYear ?? null, language: b.language ?? 'bn', category_id: b.categoryId ?? null, subject_id: b.subjectId ?? null, class_id: b.classId ?? null,
        pages: b.pages ?? null, price: b.price ?? null, cover_file_id: null, ebook_file_id: null, description: null, total_copies: copies, available_copies: copies,
      });
      for (let i = 0; i < copies; i++) await this.addCopy(schoolId, id, tx);
    });
    return { id, copies };
  }
  private async addCopy(schoolId: string, bookId: string, tx: Db) {
    // the number comes from the sequence, not from a count: a count taken on another connection
    // cannot see the copies this very transaction is inserting
    const accession = await this.numbering.next(schoolId, 'accession_no', { prefix: 'ACC-', padding: 6 }, tx);
    const id = ulid();
    await tx.insert('library_book_copies', { id, school_id: schoolId, book_id: bookId, accession_no: accession, barcode: accession, rack: null, shelf: null, condition_note: 'good', status: 'available', acquired_on: nowSql().slice(0, 10), source: 'purchase' });
    return id;
  }
  /** Bulk catalogue import: one row per title with a copy count. */
  async importBooks(schoolId: string, rows: BookInput[]) {
    let books = 0, copies = 0;
    for (const r of rows) { const made = await this.addBook(schoolId, r); books++; copies += made.copies; }
    return { books, copies };
  }
  async copies(schoolId: string, bookId: string) { return this.db.findMany<Row>('library_book_copies', { school_id: schoolId, book_id: bookId }, { orderBy: 'accession_no ASC' }); }

  // ---------- members ----------
  async members(schoolId: string) {
    return this.db.query<Row>(`SELECT m.*, s.first_name AS s_first, s.last_name AS s_last, st.first_name AS t_first FROM library_members m LEFT JOIN students s ON s.id = m.student_id LEFT JOIN staff st ON st.id = m.staff_id WHERE m.school_id = ? ORDER BY m.card_no LIMIT 1000`, [schoolId]);
  }
  async enrolMember(schoolId: string, m: { memberType: 'student' | 'staff' | 'guardian'; studentId?: string | null; staffId?: string | null; maxBooks?: number; loanDays?: number; finePerDay?: number }) {
    const key = m.memberType === 'student' ? { student_id: m.studentId } : { staff_id: m.staffId };
    const ex = await this.db.findOne<Row>('library_members', { school_id: schoolId, ...key } as never);
    if (ex) return String(ex.id);
    const cardNo = await this.numbering.next(schoolId, 'library_card_no', { prefix: 'LIB-', padding: 5 });
    const id = ulid();
    await this.db.insert('library_members', {
      id, school_id: schoolId, member_type: m.memberType, student_id: m.studentId ?? null, staff_id: m.staffId ?? null, card_no: cardNo,
      max_books: m.maxBooks ?? (m.memberType === 'staff' ? 5 : 2), loan_days: m.loanDays ?? (m.memberType === 'staff' ? 30 : 14), fine_per_day: m.finePerDay ?? 5, status: 'active', blocked_reason: null,
    });
    return id;
  }

  // ---------- issue and return ----------
  /** I1: a copy leaves the shelf. Limits, blocks and double-issue are all refused here. */
  async issue(schoolId: string, input: { copyId?: string; accessionNo?: string; memberId: string; issuedBy?: string | null; days?: number }) {
    const copy = input.copyId
      ? await this.db.findOne<Row>('library_book_copies', { id: input.copyId, school_id: schoolId })
      : await this.db.findOne<Row>('library_book_copies', { accession_no: input.accessionNo, school_id: schoolId });
    if (!copy) throw notFound('copy');
    if (copy.status !== 'available') throw new HttpError(409, `that copy is ${copy.status}`, 'unavailable');
    const member = await this.db.findOne<Row>('library_members', { id: input.memberId, school_id: schoolId });
    if (!member) throw notFound('member');
    if (member.status !== 'active') throw new HttpError(409, `this membership is ${member.status}${member.blocked_reason ? `: ${member.blocked_reason}` : ''}`, 'blocked');
    const open = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM library_issues WHERE member_id = ? AND status IN ('issued','overdue')`, [input.memberId]);
    if (Number(open[0]?.n ?? 0) >= Number(member.max_books)) throw new HttpError(409, `this member already has ${open[0]!.n} book(s), the limit is ${member.max_books}`, 'limit');
    const id = ulid();
    const days = input.days ?? Number(member.loan_days);
    const dueAt = addDays(nowSql().slice(0, 10), days);
    await this.db.transaction(async tx => {
      await tx.insert('library_issues', { id, school_id: schoolId, copy_id: String(copy.id), member_id: input.memberId, issued_at: nowSql(), due_at: dueAt, returned_at: null, renew_count: 0, issued_by: input.issuedBy ?? null, returned_to: null, fine_amount: 0, fine_invoice_item_id: null, fine_waived_by: null, reminder_stage: null, status: 'issued' });
      await tx.update('library_book_copies', { status: 'issued', updated_at: nowSql() }, { id: String(copy.id) });
      await tx.execute(`UPDATE library_books SET available_copies = available_copies - 1, updated_at = ? WHERE id = ?`, [nowSql(), String(copy.book_id)]);
    });
    await this.outbox.emitNow({ type: 'book.issued', schoolId, aggregateType: 'library.issue', aggregateId: id, payload: { issueId: id, memberId: input.memberId, copyId: String(copy.id), dueAt } });
    await this.notifyMember(schoolId, input.memberId, 'library.book_issued', 'Book issued', `Due back on ${dueAt}.`, id);
    return { id, dueAt };
  }
  async renew(schoolId: string, issueId: string, days?: number) {
    const issue = await this.db.findOne<Row>('library_issues', { id: issueId, school_id: schoolId });
    if (!issue) throw notFound('issue');
    if (issue.status === 'returned') throw new HttpError(409, 'that book is already back', 'returned');
    if (Number(issue.renew_count) >= 2) throw new HttpError(409, 'this loan has been renewed twice already', 'limit');
    const waiting = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM library_reservations r JOIN library_book_copies c ON c.book_id = r.book_id WHERE c.id = ? AND r.status = 'waiting'`, [String(issue.copy_id)]);
    if (Number(waiting[0]?.n ?? 0) > 0) throw new HttpError(409, 'somebody is waiting for this title', 'reserved');
    const member = await this.db.findOne<Row>('library_members', { id: String(issue.member_id) });
    const dueAt = addDays(nowSql().slice(0, 10), days ?? Number(member?.loan_days ?? 14));
    await this.db.update('library_issues', { due_at: dueAt, renew_count: Number(issue.renew_count) + 1, status: 'issued', reminder_stage: null, updated_at: nowSql() }, { id: issueId });
    return { id: issueId, dueAt };
  }
  /**
   * I3 and I4: the fine is settled on the next invoice, not at the counter, and the next person
   * waiting for the title is told the copy is ready for them.
   */
  async returnBook(schoolId: string, input: { issueId?: string; copyId?: string; accessionNo?: string; returnedTo?: string | null; lost?: boolean; waiveFine?: boolean; waivedBy?: string | null }) {
    const issue = input.issueId
      ? await this.db.findOne<Row>('library_issues', { id: input.issueId, school_id: schoolId })
      : (await this.db.query<Row>(`SELECT i.* FROM library_issues i JOIN library_book_copies c ON c.id = i.copy_id WHERE i.school_id = ? AND i.status IN ('issued','overdue') AND ${input.copyId ? 'c.id = ?' : 'c.accession_no = ?'} LIMIT 1`, [schoolId, input.copyId ?? input.accessionNo!]))[0];
    if (!issue) throw notFound('issue');
    if (issue.status === 'returned') throw new HttpError(409, 'that book is already back', 'returned');
    const copy = await this.db.findOne<Row>('library_book_copies', { id: String(issue.copy_id) });
    const book = await this.db.findOne<Row>('library_books', { id: String(copy?.book_id) });
    const member = await this.db.findOne<Row>('library_members', { id: String(issue.member_id) });
    const fine = input.lost ? Number(book?.price ?? 0) : input.waiveFine ? 0 : await this.fineFor(issue, member!, book!);
    await this.db.transaction(async tx => {
      await tx.update('library_issues', { returned_at: nowSql(), returned_to: input.returnedTo ?? null, fine_amount: fine, fine_waived_by: input.waiveFine ? input.waivedBy ?? null : null, status: input.lost ? 'lost' : 'returned', updated_at: nowSql() }, { id: String(issue.id) });
      await tx.update('library_book_copies', { status: input.lost ? 'lost' : 'available', updated_at: nowSql() }, { id: String(copy!.id) });
      if (!input.lost) await tx.execute(`UPDATE library_books SET available_copies = available_copies + 1, updated_at = ? WHERE id = ?`, [nowSql(), String(book!.id)]);
      else await tx.execute(`UPDATE library_books SET total_copies = total_copies - 1, updated_at = ? WHERE id = ?`, [nowSql(), String(book!.id)]);
    });
    let invoiceId: string | null = null;
    if (fine > 0 && member?.student_id) invoiceId = await this.billFine(schoolId, String(member.student_id), String(issue.id), fine, input.lost ? `Lost book: ${book?.title}` : `Library fine: ${book?.title}`);
    await this.outbox.emitNow({ type: 'book.returned', schoolId, aggregateType: 'library.issue', aggregateId: String(issue.id), payload: { issueId: String(issue.id), bookId: String(book!.id), fine, lost: !!input.lost } });
    await this.offerToNextInQueue(schoolId, String(book!.id));
    return { id: String(issue.id), fine, invoiceId, lost: !!input.lost };
  }
  /** Days late × the member's daily rate, never more than the book itself is worth. */
  private async fineFor(issue: Row, member: Row, book: Row) {
    const late = daysBetween(String(issue.due_at).slice(0, 10), nowSql().slice(0, 10));
    if (late <= 0) return 0;
    const raw = round(late * Number(member.fine_per_day ?? 0));
    const cap = Number(book.price ?? 0);
    return cap > 0 ? Math.min(raw, cap) : raw;
  }
  private async billFine(schoolId: string, studentId: string, issueId: string, amount: number, description: string) {
    const head = await this.db.findOne<{ id: string }>('fee_heads', { school_id: schoolId, code: 'LIB_FINE' });
    const inv = await this.fees.createInvoice(schoolId, { studentId, items: [{ feeHeadId: head?.id ?? null, description, amount, itemKind: 'fine' }], notes: `library:${issueId}` });
    const item = await this.db.findOne<Row>('invoice_items', { invoice_id: inv.id });
    await this.db.update('library_issues', { fine_invoice_item_id: item ? String(item.id) : null, updated_at: nowSql() }, { id: issueId });
    return inv.id;
  }
  async issues(schoolId: string, f: { memberId?: string; status?: string; overdueOnly?: boolean } = {}) {
    const where = ['i.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.memberId) { where.push('i.member_id = ?'); params.push(f.memberId); }
    if (f.status) { where.push('i.status = ?'); params.push(f.status); }
    if (f.overdueOnly) { where.push(`i.status IN ('issued','overdue') AND i.due_at < ?`); params.push(nowSql().slice(0, 10)); }
    return this.db.query<Row>(`SELECT i.*, b.title, c.accession_no, m.card_no, s.first_name, s.last_name FROM library_issues i JOIN library_book_copies c ON c.id = i.copy_id JOIN library_books b ON b.id = c.book_id JOIN library_members m ON m.id = i.member_id LEFT JOIN students s ON s.id = m.student_id WHERE ${where.join(' AND ')} ORDER BY i.due_at ASC LIMIT 500`, params);
  }

  // ---------- reservations and reading ----------
  async reserve(schoolId: string, bookId: string, memberId: string) {
    const book = await this.db.findOne<Row>('library_books', { id: bookId, school_id: schoolId });
    if (!book) throw notFound('book');
    if (await this.db.findOne('library_reservations', { book_id: bookId, member_id: memberId, status: 'waiting' })) throw new HttpError(409, 'already in the queue', 'duplicate');
    const id = ulid();
    await this.db.insert('library_reservations', { id, school_id: schoolId, book_id: bookId, member_id: memberId, reserved_at: nowSql(), notified_at: null, expires_at: null, status: 'waiting' });
    return id;
  }
  /** The queue and the holds: who is waiting for what, and when a 48-hour hold runs out. */
  async reservations(schoolId: string, f: { status?: string; bookId?: string } = {}) {
    const where = ['r.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.status) { where.push('r.status = ?'); params.push(f.status); }
    if (f.bookId) { where.push('r.book_id = ?'); params.push(f.bookId); }
    return this.db.query<Row>(`SELECT r.*, b.title, b.available_copies, m.card_no, s.first_name, s.last_name, st.first_name AS staff_first, st.last_name AS staff_last,
        (SELECT COUNT(*) FROM library_reservations q WHERE q.book_id = r.book_id AND q.status = 'waiting' AND (q.reserved_at < r.reserved_at OR (q.reserved_at = r.reserved_at AND q.id < r.id))) AS ahead
      FROM library_reservations r JOIN library_books b ON b.id = r.book_id JOIN library_members m ON m.id = r.member_id
      LEFT JOIN students s ON s.id = m.student_id LEFT JOIN staff st ON st.id = m.staff_id
      WHERE ${where.join(' AND ')} ORDER BY r.reserved_at DESC LIMIT 300`, params);
  }
  /** I4: a returned copy is held for the next member for 48 hours. */
  private async offerToNextInQueue(schoolId: string, bookId: string) {
    const next = await this.db.query<Row>(`SELECT * FROM library_reservations WHERE school_id = ? AND book_id = ? AND status = 'waiting' ORDER BY reserved_at ASC, id ASC LIMIT 1`, [schoolId, bookId]);
    if (!next[0]) return null;
    await this.db.update('library_reservations', { status: 'ready', notified_at: nowSql(), expires_at: nowSql(new Date(Date.now() + 48 * 3600_000)), updated_at: nowSql() }, { id: String(next[0].id) });
    const book = await this.db.findOne<Row>('library_books', { id: bookId });
    await this.notifyMember(schoolId, String(next[0].member_id), 'library.reservation_ready', 'Your book is ready', `${book?.title} is on hold for you for two days.`, String(next[0].id));
    return String(next[0].id);
  }
  async logReading(schoolId: string, r: { studentId: string; bookId: string; pagesRead?: number; finished?: boolean; review?: string | null; rating?: number | null }) {
    const id = ulid();
    await this.db.insert('reading_logs', { id, school_id: schoolId, student_id: r.studentId, book_id: r.bookId, pages_read: r.pagesRead ?? 0, finished: !!r.finished, review: r.review ?? null, rating: r.rating ?? null, logged_at: nowSql() });
    return id;
  }
  async readingLeaders(schoolId: string, limit = 20) {
    return this.db.query<Row>(`SELECT l.student_id, s.first_name, s.last_name, SUM(l.pages_read) AS pages, SUM(CASE WHEN l.finished = TRUE THEN 1 ELSE 0 END) AS books FROM reading_logs l JOIN students s ON s.id = l.student_id WHERE l.school_id = ? GROUP BY l.student_id, s.first_name, s.last_name ORDER BY pages DESC LIMIT ${Math.max(1, Math.floor(limit))}`, [schoolId]);
  }

  private async notifyMember(schoolId: string, memberId: string, eventKey: string, title: string, body: string, entityId: string) {
    const m = await this.db.findOne<Row>('library_members', { id: memberId });
    if (!m) return;
    if (m.student_id) {
      const guardians = await this.db.query<{ user_id: string | null; phone: string }>(`SELECT g.user_id, g.phone FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = ? AND sg.receives_notifications = TRUE`, [String(m.student_id)]);
      for (const g of guardians) await this.notifications.notify({ schoolId, userId: g.user_id, address: g.phone, channels: ['in_app', 'push'], eventKey, title, body, entityType: 'library.issue', entityId });
      return;
    }
    const staff = m.staff_id ? await this.db.findOne<{ user_id: string | null }>('staff', { id: String(m.staff_id) }) : null;
    if (staff?.user_id) await this.notifications.notify({ schoolId, userId: staff.user_id, channels: ['in_app', 'push'], eventKey, title, body, entityType: 'library.issue', entityId });
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // I2, I3 and I6: one pass a day marks overdue loans, chases them, and writes off what is long gone
      'library.due_and_fines': async ({ schoolId }) => {
        const today = nowSql().slice(0, 10);
        const open = await this.db.query<Row>(`SELECT i.*, m.fine_per_day, b.price, b.title FROM library_issues i JOIN library_members m ON m.id = i.member_id JOIN library_book_copies c ON c.id = i.copy_id JOIN library_books b ON b.id = c.book_id WHERE i.school_id = ? AND i.status IN ('issued','overdue')`, [schoolId]);
        let reminded = 0, overdue = 0, lost = 0;
        for (const i of open) {
          const due = String(i.due_at).slice(0, 10);
          const late = daysBetween(due, today);
          // one reminder per stage, not per day: due tomorrow, a week late, a month late
          const stage = late < 0 ? (daysBetween(today, due) === 1 ? 'due_tomorrow' : null) : late >= 30 ? 'overdue_30' : late >= 7 ? 'overdue_7' : 'overdue_1';
          if (late > 0 && i.status !== 'overdue') { await this.db.update('library_issues', { status: 'overdue', updated_at: nowSql() }, { id: String(i.id) }); overdue++; }
          if (late >= 60) {   // I6: two months gone — treat it as lost and charge for it
            await this.returnBook(schoolId, { issueId: String(i.id), lost: true });
            lost++; continue;
          }
          if (late > 0) {
            const cap = Number(i.price ?? 0);
            const fine = cap > 0 ? Math.min(round(late * Number(i.fine_per_day)), cap) : round(late * Number(i.fine_per_day));
            await this.db.update('library_issues', { fine_amount: fine, updated_at: nowSql() }, { id: String(i.id) });
          }
          if (stage && stage !== i.reminder_stage) {
            await this.notifyMember(schoolId, String(i.member_id), 'library.due_reminder', late > 0 ? 'Library book overdue' : 'Library book due tomorrow', late > 0 ? `${i.title} was due on ${due}. A fine of ${Number(i.fine_per_day)} a day is running.` : `${i.title} is due back tomorrow.`, String(i.id));
            await this.db.update('library_issues', { reminder_stage: stage, updated_at: nowSql() }, { id: String(i.id) });
            reminded++;
          }
        }
        // reservations nobody collected go back to the queue
        const stale = await this.db.query<Row>(`SELECT * FROM library_reservations WHERE school_id = ? AND status = 'ready' AND expires_at < ?`, [schoolId, nowSql()]);
        for (const r of stale) { await this.db.update('library_reservations', { status: 'expired', updated_at: nowSql() }, { id: String(r.id) }); await this.offerToNextInQueue(schoolId, String(r.book_id)); }
        return { reminded, overdue, lost, expiredHolds: stale.length };
      },
    };
  }
}

const addDays = (date: string, days: number) => { const d = new Date(`${date.slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
