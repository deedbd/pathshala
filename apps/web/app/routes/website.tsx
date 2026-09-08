import { useState } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/website';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Select, Textarea, api, formatDateTime, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';
import { useTenantPath } from '~/tenant';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id;
  const [pages, menu, notices, enquiries, messages] = await Promise.all([context.app.cms.pages(sid), context.app.cms.menu(sid), context.app.cms.notices(sid), context.app.cms.enquiries(sid), context.app.db.findMany('cms_contact_messages', { school_id: sid }, { orderBy: 'created_at DESC', limit: 50 })]);
  return { locale: (user.locale as Locale) || context.locale, pages, menu, notices, enquiries, messages, appUrl: context.app.config.appUrl };
}
export function meta() { return [{ title: 'Pathshala — Website' }]; }

export default function Website() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const tp = useTenantPath();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [drawer, setDrawer] = useState<'notice' | 'page' | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const notice = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/cms/notices', { method: 'POST', json: { title: f.title, body: f.body, noticeType: f.noticeType, isPinned: f.isPinned === 'on', publishAt: f.publishAt ? f.publishAt.replace('T', ' ') + ':00' : null } })); };
  // a go-live date is the author's own confirmation: the page waits as a draft and publishes itself
  const page = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/cms/pages', { method: 'POST', json: { title: f.title, slug: f.slug || undefined, locale: 'bn', status: 'published', publishAt: f.publishAt ? f.publishAt.replace('T', ' ') + ':00' : null, blocks: [{ type: 'text', title: f.title, body: f.body, bodyBn: f.bodyBn }] } })); };
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('web.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('web.purpose')}</p></div>
        <div className="flex gap-2"><a className="btn btn-secondary btn-sm" href={tp('/site')} target="_blank" rel="noreferrer">{tr('web.view')}</a><Button size="sm" variant="secondary" onClick={() => setDrawer('page')}>{tr('web.pages')} +</Button><Button size="sm" onClick={() => setDrawer('notice')}>{tr('web.newNotice')}</Button></div>
      </div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      <div className="mt-4 grid gap-6 xl:grid-cols-2">
        <section><h2 className="mb-2 text-base">{tr('web.notices')}</h2><DataTable locale={d.locale} rows={d.notices} columns={[{ key: 'publish_at', label: tr('common.date'), render: r => formatDateTime(String(r.publish_at), d.locale) }, { key: 'title', label: tr('common.name') }, { key: 'notice_type', label: 'Type' }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'published' ? 'active' : String(r.status)}>{String(r.status)}</Chip> }]} /></section>
        <section><h2 className="mb-2 text-base">{tr('web.enquiries')}</h2><DataTable locale={d.locale} rows={d.enquiries} columns={[{ key: 'created_at', label: tr('common.date'), render: r => formatDateTime(String(r.created_at), d.locale) }, { key: 'student_name', label: tr('site.studentName') }, { key: 'guardian_name', label: tr('site.guardianName') }, { key: 'phone', label: tr('common.phone'), className: 'num' }, { key: 'class_name', label: tr('common.class') }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'new' ? 'pending' : String(r.status)}>{String(r.status)}</Chip> }]} /></section>
        <section><h2 className="mb-2 text-base">{tr('web.pages')}</h2><DataTable locale={d.locale} searchable={false} rows={d.pages} columns={[{ key: 'title', label: tr('common.name'), render: r => <a href={tp(Number(r.is_home) ? '/site' : `/site/${r.slug}`)} target="_blank" rel="noreferrer">{String(r.title)}</a> }, { key: 'slug', label: 'Slug', className: 'num' }, { key: 'locale', label: 'Lang' }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'published' ? 'active' : 'draft'}>{String(r.status)}</Chip> }]} /></section>
        <section><h2 className="mb-2 text-base">{tr('site.contact')}</h2><DataTable locale={d.locale} searchable={false} rows={d.messages} columns={[{ key: 'created_at', label: tr('common.date'), render: r => formatDateTime(String(r.created_at), d.locale) }, { key: 'name', label: tr('common.name') }, { key: 'phone', label: tr('common.phone'), className: 'num' }, { key: 'message', label: tr('site.message') }]} /></section>
      </div>
      <Drawer open={drawer === 'notice'} onClose={() => setDrawer(null)} title={tr('web.newNotice')}>
        <form className="grid gap-3" onSubmit={notice}>
          <Field label={tr('common.name')}><Input name="title" required /></Field>
          <Field label="Body"><Textarea name="body" required rows={6} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Type"><Select name="noticeType" options={['general', 'academic', 'exam', 'fee', 'holiday', 'urgent', 'event'].map(v => ({ value: v, label: v }))} /></Field><Field label="Schedule (optional)"><Input name="publishAt" type="datetime-local" /></Field></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isPinned" /> Pin to top</label>
          <Button disabled={busy}>{tr('web.newNotice')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'page'} onClose={() => setDrawer(null)} title={tr('web.pages')}>
        <form className="grid gap-3" onSubmit={page}>
          <Field label={tr('common.name')}><Input name="title" required /></Field><Field label="Slug" hint="e.g. about"><Input name="slug" className="num" /></Field>
          <Field label="Text (English)"><Textarea name="body" rows={5} /></Field><Field label="Text (Bangla)"><Textarea name="bodyBn" rows={5} lang="bn" /></Field>
          <Field label="Go live (optional)" hint="Leave empty to publish now; a date keeps it a draft until then and the site publishes it itself."><Input name="publishAt" type="datetime-local" /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}
