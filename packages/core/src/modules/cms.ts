import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { OutboxService } from '../automation/outbox.js';
import { badRequest, notFound } from '../context.js';
import { normalizeBdPhone, slugify } from '../util.js';

export interface PageBlock { type: 'hero' | 'text' | 'notices' | 'admission_cta' | 'gallery' | 'contact' | 'stats' | 'results_lookup'; title?: string; titleBn?: string; body?: string; bodyBn?: string; image?: string | null; cta?: { label: string; labelBn?: string; href: string } | null; limit?: number }
export interface PageInput { title: string; slug?: string; locale?: 'bn' | 'en'; blocks: PageBlock[]; seo?: { description?: string; image?: string } | null; isHome?: boolean; status?: 'draft' | 'published' }
export interface EnquiryInput { studentName: string; guardianName: string; phone: string; email?: string | null; classId?: string | null; notes?: string | null; source?: string }

/** School website: pages made of blocks, menus, published notices/posts, contact and admission-enquiry forms. */
export class CmsService {
  constructor(private db: Db, private outbox: OutboxService) {}

  async savePage(schoolId: string, p: PageInput, id?: string) {
    const locale = p.locale ?? 'bn';
    const slug = p.slug ? slugify(p.slug) : slugify(p.title);
    const row: Row = { title: p.title, slug, locale, blocks: p.blocks as never, seo: (p.seo ?? null) as never, is_home: !!p.isHome, status: p.status ?? 'draft', published_at: p.status === 'published' ? nowSql() : null };
    await this.db.transaction(async tx => {
      if (p.isHome) await tx.update('cms_pages', { is_home: false }, { school_id: schoolId, locale });
      if (id) { const n = await tx.update('cms_pages', { ...row, updated_at: nowSql() }, { id, school_id: schoolId }); if (!n) throw notFound('page'); }
      else { id = ulid(); await tx.insert('cms_pages', { id, school_id: schoolId, ...row, author_id: null }); }
      if (p.status === 'published') await this.outbox.emit(tx, { type: 'page.published', schoolId, aggregateType: 'cms.page', aggregateId: id, payload: { pageId: id, slug, locale } });
    });
    return id!;
  }
  async pages(schoolId: string) { return this.db.findMany<Row>('cms_pages', { school_id: schoolId, deleted_at: null }, { orderBy: 'is_home DESC, title ASC' }); }
  async page(schoolId: string, slug: string, locale: 'bn' | 'en' = 'bn') {
    const p = (await this.db.findOne<Row>('cms_pages', { school_id: schoolId, slug, locale, status: 'published', deleted_at: null })) ?? (await this.db.findOne<Row>('cms_pages', { school_id: schoolId, slug, status: 'published', deleted_at: null }));
    return p ? { ...p, blocks: json<PageBlock[]>(p.blocks) ?? [], seo: json(p.seo) } : null;
  }
  async home(schoolId: string, locale: 'bn' | 'en' = 'bn') {
    const p = (await this.db.findOne<Row>('cms_pages', { school_id: schoolId, is_home: true, locale, status: 'published', deleted_at: null })) ?? (await this.db.findOne<Row>('cms_pages', { school_id: schoolId, is_home: true, status: 'published', deleted_at: null }));
    return p ? { ...p, blocks: json<PageBlock[]>(p.blocks) ?? [], seo: json(p.seo) } : null;
  }
  async setMenu(schoolId: string, name: string, items: { label: string; labelBn?: string; href: string }[]) {
    const ex = await this.db.findOne<{ id: string }>('cms_menus', { school_id: schoolId, name });
    if (ex) await this.db.update('cms_menus', { items: items as never, updated_at: nowSql() }, { id: ex.id }); else await this.db.insert('cms_menus', { id: ulid(), school_id: schoolId, name, items: items as never });
  }
  async menu(schoolId: string, name = 'main') { const m = await this.db.findOne<Row>('cms_menus', { school_id: schoolId, name }); return m ? json<{ label: string; labelBn?: string; href: string }[]>(m.items) ?? [] : []; }

  /** Default site for a fresh school: home page with hero, notices, admission CTA, contact; main menu. */
  async ensureDefaultSite(schoolId: string) {
    if (await this.db.findOne('cms_pages', { school_id: schoolId, is_home: true })) return false;
    const school = await this.db.findOne<Row>('schools', { id: schoolId });
    const name = String(school?.name ?? 'Our School');
    // The hero title is left empty on purpose: the site renders the school's current name, so a rename shows up everywhere.
    await this.savePage(schoolId, { title: name, slug: 'home', locale: 'bn', isHome: true, status: 'published', blocks: [
      { type: 'hero', body: 'Quality education, every child seen.', bodyBn: 'মানসম্মত শিক্ষা, প্রতিটি শিশুর প্রতি যত্ন।', cta: { label: 'Apply for admission', labelBn: 'ভর্তির আবেদন', href: '/site/admission' } },
      { type: 'stats' }, { type: 'notices', title: 'Notices', titleBn: 'নোটিশ', limit: 5 }, { type: 'admission_cta', title: 'Admission open', titleBn: 'ভর্তি চলছে', body: 'Fill the form and we will call you back.', bodyBn: 'ফর্ম পূরণ করুন, আমরা আপনাকে ফোন করব।' }, { type: 'contact' },
    ] });
    await this.savePage(schoolId, { title: 'Admission', slug: 'admission', locale: 'bn', status: 'published', blocks: [{ type: 'admission_cta', title: 'Admission enquiry', titleBn: 'ভর্তির খোঁজ', body: 'Tell us about the student; our admissions desk will contact you within a day.', bodyBn: 'শিক্ষার্থীর তথ্য দিন, ভর্তি ডেস্ক ২৪ ঘণ্টার মধ্যে যোগাযোগ করবে।' }] });
    await this.setMenu(schoolId, 'main', [{ label: 'Home', labelBn: 'হোম', href: '/site' }, { label: 'Notices', labelBn: 'নোটিশ', href: '/site#notices' }, { label: 'Admission', labelBn: 'ভর্তি', href: '/site/admission' }, { label: 'Sign in', labelBn: 'সাইন ইন', href: '/login' }]);
    return true;
  }

  async publicNotices(schoolId: string, limit = 10) {
    return this.db.query<Row>(`SELECT id, title, body, notice_type, publish_at, is_pinned FROM notices WHERE school_id = ? AND status = 'published' AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at >= ?) ORDER BY is_pinned DESC, publish_at DESC LIMIT ${limit}`, [schoolId, nowSql()]);
  }
  async publishNotice(schoolId: string, n: { title: string; body: string; noticeType?: string; publishAt?: string | null; expiresAt?: string | null; isPinned?: boolean; sendPush?: boolean; audience?: unknown }) {
    const id = ulid();
    const scheduled = !!n.publishAt && n.publishAt > nowSql();
    await this.db.transaction(async tx => {
      await tx.insert('notices', { id, school_id: schoolId, title: n.title, body: n.body, notice_type: n.noticeType ?? 'general', audience: (n.audience ?? { public: true }) as never, attachments: null, publish_at: n.publishAt ?? nowSql(), expires_at: n.expiresAt ?? null, is_pinned: !!n.isPinned, send_push: n.sendPush ?? true, send_sms: false, send_email: false, status: scheduled ? 'scheduled' : 'published', created_by: null });
      if (!scheduled) await this.outbox.emit(tx, { type: 'notice.published', schoolId, aggregateType: 'communication.notice', aggregateId: id, payload: { noticeId: id, title: n.title, audience: n.audience ?? { public: true } } });
    });
    return id;
  }
  async notices(schoolId: string) { return this.db.findMany<Row>('notices', { school_id: schoolId, deleted_at: null }, { orderBy: 'publish_at DESC', limit: 100 }); }

  /** Public admission form → `admission_enquiries` + `enquiry.created` (rule A1: counsellor round-robin, SMS, follow-up task). */
  async submitEnquiry(schoolId: string, e: EnquiryInput) {
    const phone = normalizeBdPhone(e.phone); if (!phone) throw badRequest('a Bangladesh mobile number is required');
    if (!e.studentName.trim() || !e.guardianName.trim()) throw badRequest('student and guardian names are required');
    const recent = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM admission_enquiries WHERE school_id = ? AND phone = ? AND created_at >= ?`, [schoolId, phone, nowSql(new Date(Date.now() - 3600_000))]);
    if (Number(recent[0]?.n) >= 3) throw badRequest('too many enquiries from this number; we will call you');
    const id = ulid();
    await this.db.transaction(async tx => {
      await tx.insert('admission_enquiries', { id, school_id: schoolId, campaign_id: null, student_name: e.studentName.trim().slice(0, 160), guardian_name: e.guardianName.trim().slice(0, 160), phone, email: e.email?.toLowerCase() ?? null, class_id: e.classId ?? null, source: (e.source ?? 'website') as never, assigned_to: null, status: 'new', next_follow_up_at: nowSql(new Date(Date.now() + 48 * 3600_000)), notes: e.notes ?? null });
      await this.outbox.emit(tx, { type: 'enquiry.created', schoolId, aggregateType: 'admissions.enquiry', aggregateId: id, payload: { enquiryId: id, studentName: e.studentName, guardianName: e.guardianName, phone, classId: e.classId ?? null, source: e.source ?? 'website' } });
    });
    return id;
  }
  async enquiries(schoolId: string) { return this.db.query<Row>(`SELECT e.*, c.name AS class_name FROM admission_enquiries e LEFT JOIN classes c ON c.id = e.class_id WHERE e.school_id = ? ORDER BY e.created_at DESC LIMIT 200`, [schoolId]); }

  async submitContact(schoolId: string, m: { name: string; phone?: string | null; email?: string | null; message: string }) {
    const id = ulid();
    await this.db.transaction(async tx => {
      await tx.insert('cms_contact_messages', { id, school_id: schoolId, name: m.name.trim().slice(0, 160), phone: m.phone ? normalizeBdPhone(m.phone) ?? m.phone.slice(0, 30) : null, email: m.email?.toLowerCase() ?? null, message: m.message.trim().slice(0, 4000), status: 'new' });
      await this.outbox.emit(tx, { type: 'contact.received', schoolId, aggregateType: 'cms.contact', aggregateId: id, payload: { messageId: id, name: m.name, phone: m.phone ?? null } });
    });
    return id;
  }

  /** The school a public request belongs to: custom domain → cms_domains/schools, else the first (single-tenant) school. */
  async resolveSchool(host: string | null) {
    const h = (host ?? '').split(':')[0].toLowerCase();
    if (h) {
      const s = await this.db.findOne<Row>('schools', { custom_domain: h }); if (s) return s;
      const d = await this.db.findOne<Row>('cms_domains', { domain: h }); if (d) return this.db.findOne<Row>('schools', { id: String(d.school_id) });
    }
    return this.db.findOne<Row>('schools', {}, { orderBy: 'created_at ASC' });
  }
}
