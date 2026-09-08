import type { Db, Row } from '@pathshala/db';
import type { PeopleService } from './people.js';
import type { LibraryService } from './library.js';
import type { RbacService } from '../rbac.js';

export interface Found { kind: 'student' | 'staff' | 'invoice' | 'book' | 'guardian'; id: string; title: string; subtitle: string; href: string }

/**
 * One box at the top of the console: a name, an admission number, an invoice number, a book.
 *
 * A school office does not think in modules. Somebody rings about "Rahim in class four" or reads out
 * an invoice number, and the person answering should not have to decide which page to open first.
 *
 * Two rules make it safe. Every section is behind the permission that owns it, so a clerk who cannot
 * open the fees page cannot find an invoice here either — the search returns what that person could
 * have reached by walking the console themselves, and nothing more. And every read goes through the
 * service that owns the table, so the search has no opinion of its own about what a student is.
 */
export class SearchService {
  constructor(private db: Db, private rbac: RbacService, private people: PeopleService, private library: LibraryService) {}

  async find(schoolId: string, userId: string, q: string, limit = 5): Promise<{ q: string; results: Found[] }> {
    const needle = q.trim();
    if (needle.length < 2) return { q: needle, results: [] };
    const access = await this.rbac.accessFor(userId);
    const may = (perm: string) => access.permissions.has(perm) || access.roles.includes('super_admin');
    const results: Found[] = [];

    if (may('students.view')) {
      const { rows } = await this.people.students(schoolId, { q: needle, limit });
      for (const s of rows) {
        results.push({
          kind: 'student', id: String(s.id),
          title: `${s.first_name} ${s.last_name ?? ''}`.trim(),
          subtitle: [s.admission_no, s.class_name, s.section_name].filter(Boolean).join(' · '),
          href: `/students?q=${encodeURIComponent(String(s.admission_no ?? needle))}`,
        });
      }
    }
    if (may('people.view') || may('staff.view')) {
      const staff = (await this.people.staff(schoolId, { q: needle })).slice(0, limit);
      for (const s of staff) {
        results.push({
          kind: 'staff', id: String(s.id),
          title: `${s.first_name} ${s.last_name ?? ''}`.trim(),
          subtitle: [s.employee_no, s.designation, s.staff_category].filter(Boolean).join(' · '),
          href: `/staff?q=${encodeURIComponent(String(s.employee_no ?? needle))}`,
        });
      }
    }
    if (may('fees.view')) {
      // an invoice is looked up by the number on the paper somebody is holding, or by whose it is
      const like = `%${needle}%`;
      const invoices = await this.db.query<Row>(
        `SELECT i.id, i.invoice_no, i.total, i.balance, i.status, i.due_date, s.first_name, s.last_name, s.admission_no
         FROM invoices i LEFT JOIN students s ON s.id = i.student_id
         WHERE i.school_id = ? AND (i.invoice_no LIKE ? OR s.admission_no LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ?)
         ORDER BY i.issue_date DESC, i.id DESC LIMIT ${Math.min(20, Math.max(1, limit))}`,
        [schoolId, like, like, like, like]);
      for (const i of invoices) {
        results.push({
          kind: 'invoice', id: String(i.id),
          title: String(i.invoice_no),
          subtitle: [`${i.first_name ?? ''} ${i.last_name ?? ''}`.trim(), `${i.status}`, Number(i.balance) > 0 ? `due ${i.balance}` : 'paid'].filter(Boolean).join(' · '),
          href: `/fees?q=${encodeURIComponent(String(i.invoice_no))}`,
        });
      }
    }
    if (may('library.view')) {
      const books = (await this.library.books(schoolId, { q: needle })).slice(0, limit);
      for (const b of books) {
        results.push({
          kind: 'book', id: String(b.id),
          title: String(b.title),
          subtitle: [b.author, b.isbn, b.category_name].filter(Boolean).join(' · '),
          href: `/operations?q=${encodeURIComponent(String(b.title))}`,
        });
      }
    }
    if (may('students.view')) {
      const like = `%${needle}%`;
      const guardians = await this.db.query<Row>(
        `SELECT g.id, g.full_name, g.phone, COUNT(sg.student_id) AS children FROM guardians g
         LEFT JOIN student_guardians sg ON sg.guardian_id = g.id
         WHERE g.school_id = ? AND (g.full_name LIKE ? OR g.phone LIKE ?)
         GROUP BY g.id, g.full_name, g.phone ORDER BY g.full_name, g.id LIMIT ${Math.min(20, Math.max(1, limit))}`,
        [schoolId, like, like]);
      for (const g of guardians) {
        results.push({
          kind: 'guardian', id: String(g.id),
          title: String(g.full_name),
          subtitle: [g.phone, `${g.children} child${Number(g.children) === 1 ? '' : 'ren'}`].filter(Boolean).join(' · '),
          href: `/students?q=${encodeURIComponent(String(g.phone ?? needle))}`,
        });
      }
    }
    return { q: needle, results };
  }
}
