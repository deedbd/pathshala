import { Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { Route } from './+types/site';
import { formatDate, formatNumber, t, type Locale } from '@pathshala/ui';
import { assertSameOrigin, formString } from '~/lib';
import { useTenantPath } from '~/tenant';

type Block = { type: string; title?: string; titleBn?: string; body?: string; bodyBn?: string; cta?: { label: string; labelBn?: string; href: string } | null; limit?: number };

export async function loader({ context, request, params }: Route.LoaderArgs) {
  // The school in the URL wins: the path named it, or the host did. resolveSchool(host) is the
  // fallback for the vendor's own root, where it answers with the installation's founder school.
  const school = context.tenant
    ? await context.app.db.findOne<Record<string, unknown>>('schools', { id: context.tenant.schoolId })
    : await context.app.cms.resolveSchool(request.headers.get('host'));
  if (!school) throw new Response('No school configured yet', { status: 404 });
  const sid = String(school.id);
  const url = new URL(request.url);
  const locale = ((url.searchParams.get('locale') as Locale) || (school.locale as Locale) || 'bn');
  const page = params.slug ? await context.app.cms.page(sid, params.slug, locale) : await context.app.cms.home(sid, locale);
  if (!page) throw new Response('Page not found', { status: 404 });
  const [menu, notices, classes, stats] = await Promise.all([context.app.cms.menu(sid), context.app.cms.publicNotices(sid, 8), context.app.academic.classes(sid), Promise.all([context.app.db.count('students', { school_id: sid, status: 'active' }), context.app.db.count('staff', { school_id: sid, staff_category: 'teaching', status: 'active' }), context.app.db.count('classes', { school_id: sid, status: 'active' })])]);
  return { locale, school: { name: String(school.name), nameBn: (school.name_bn as string) ?? null, phone: school.phone as string | null, email: school.email as string | null, theme: (context.app.db.engine, school.theme) as { accent?: string } | null }, page: { ...page, title: String((page as Record<string, unknown>).title ?? ''), blocks: page.blocks as Block[] }, menu, notices, classes, stats: { students: stats[0], teachers: stats[1], classes: stats[2] }, turnstileSiteKey: context.app.config.env.TURNSTILE_SITE_KEY || null };
}

export async function action({ context, request }: Route.ActionArgs) {
  assertSameOrigin(request, context.app.config.appUrl);
  const school = context.tenant
    ? await context.app.db.findOne<Record<string, unknown>>('schools', { id: context.tenant.schoolId })
    : await context.app.cms.resolveSchool(request.headers.get('host'));
  if (!school) throw new Response('No school', { status: 404 });
  const fd = await request.formData(); const intent = formString(fd, 'intent');
  try {
    if (intent === 'enquiry') { await context.app.cms.submitEnquiry(String(school.id), { studentName: formString(fd, 'studentName'), guardianName: formString(fd, 'guardianName'), phone: formString(fd, 'phone'), email: formString(fd, 'email') || null, classId: formString(fd, 'classId') || null, notes: formString(fd, 'notes') || null, source: 'website' }); return { ok: 'enquiry' as const }; }
    if (intent === 'contact') { await context.app.cms.submitContact(String(school.id), { name: formString(fd, 'name'), phone: formString(fd, 'phone') || null, email: formString(fd, 'email') || null, message: formString(fd, 'message') }); return { ok: 'contact' as const }; }
  } catch (e) { return { error: (e as Error).message }; }
  return null;
}

export function meta({ data }: Route.MetaArgs) { return [{ title: data ? `${data.school.name} — ${data.page.title}` : 'School' }]; }

export default function Site() {
  const d = useLoaderData<typeof loader>(); const result = useActionData<typeof action>() as { ok?: string; error?: string } | undefined; const nav = useNavigation();
  const L = d.locale; const tr = (k: Parameters<typeof t>[0]) => t(k, L); const tp = useTenantPath();
  const pick = (en?: string, bn?: string) => (L === 'bn' && bn ? bn : en ?? bn ?? '');
  const name = pick(d.school.name, d.school.nameBn ?? undefined);
  const accent = d.school.theme?.accent;
  return (
    <div lang={L} style={accent ? ({ '--accent': accent } as React.CSSProperties) : undefined}>
      <header className="sticky top-0 z-10 border-b" style={{ background: 'var(--surface)', borderColor: 'var(--line)' }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <a href={tp('/site')} className="display text-lg" style={{ color: 'var(--accent)' }}>{name}</a>
          <nav className="flex items-center gap-1 overflow-x-auto text-sm">{d.menu.map(m => <a key={m.href} href={tp(m.href)} className="whitespace-nowrap px-2 py-1">{pick(m.label, m.labelBn)}</a>)}<a href={`?locale=${L === 'bn' ? 'en' : 'bn'}`} className="px-2 py-1" style={{ color: 'var(--muted)' }}>{tr('lang.switch')}</a></nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        {result?.error && <div className="banner banner-bad mb-4">{result.error}</div>}
        {result?.ok && <div className="banner banner-ok mb-4">{tr('site.sent')}</div>}
        {d.page.blocks.map((b, i) => {
          switch (b.type) {
            case 'hero': return <section key={i} className="card p-8 sm:p-12" style={{ background: 'var(--accent-soft)' }}><h1 className="text-3xl sm:text-4xl">{pick(b.title, b.titleBn) || name}</h1><p className="mt-2 max-w-xl text-base" style={{ color: 'var(--muted)' }}>{pick(b.body, b.bodyBn)}</p>{b.cta && <a href={tp(b.cta.href)} className="btn btn-primary mt-6">{pick(b.cta.label, b.cta.labelBn)}</a>}</section>;
            case 'stats': return <section key={i} className="mt-6 grid grid-cols-3 gap-3">{([['dash.students', d.stats.students], ['staff.title', d.stats.teachers], ['acad.classes', d.stats.classes]] as const).map(([k, v]) => <div key={k} className="kpi"><div className="kpi-label">{tr(k)}</div><div className="kpi-value num">{formatNumber(v, L)}</div></div>)}</section>;
            case 'text': return <section key={i} className="card mt-6 p-6"><h2 className="text-xl">{pick(b.title, b.titleBn)}</h2><div className="prose mt-2 whitespace-pre-wrap text-sm">{pick(b.body, b.bodyBn)}</div></section>;
            case 'notices': return <section key={i} id="notices" className="card mt-6 p-6"><h2 className="text-xl">{pick(b.title, b.titleBn) || tr('web.notices')}</h2><ul className="mt-3 divide-y" style={{ borderColor: 'var(--line)' }}>{d.notices.slice(0, b.limit ?? 5).map(n => <li key={String(n.id)} className="py-3"><div className="flex items-center gap-2">{Number(n.is_pinned) ? <span className="chip chip-accent">pin</span> : null}<span className="font-medium">{String(n.title)}</span><span className="ml-auto text-xs" style={{ color: 'var(--muted)' }}>{formatDate(String(n.publish_at), L)}</span></div><p className="mt-1 whitespace-pre-wrap text-sm" style={{ color: 'var(--muted)' }}>{String(n.body).slice(0, 300)}</p></li>)}{d.notices.length === 0 && <li className="py-3 text-sm" style={{ color: 'var(--muted)' }}>—</li>}</ul></section>;
            case 'admission_cta': return <section key={i} id="admission" className="card mt-6 p-6"><h2 className="text-xl">{pick(b.title, b.titleBn) || tr('site.admission')}</h2><p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>{pick(b.body, b.bodyBn)}</p>
              <Form method="post" className="mt-4 grid gap-3 sm:grid-cols-2"><input type="hidden" name="intent" value="enquiry" />
                <label className="block"><span className="label">{tr('site.studentName')}</span><input name="studentName" className="input" required /></label>
                <label className="block"><span className="label">{tr('site.guardianName')}</span><input name="guardianName" className="input" required /></label>
                <label className="block"><span className="label">{tr('common.phone')}</span><input name="phone" className="input num" required inputMode="tel" placeholder="01XXXXXXXXX" /></label>
                <label className="block"><span className="label">{tr('site.classApplying')}</span><select name="classId" className="input"><option value="">—</option>{d.classes.map(c => <option key={String(c.id)} value={String(c.id)}>{pick(String(c.name), c.name_bn as string)}</option>)}</select></label>
                <label className="block sm:col-span-2"><span className="label">{tr('site.message')}</span><textarea name="notes" className="input" rows={2} /></label>
                {d.turnstileSiteKey && <div className="cf-turnstile sm:col-span-2" data-sitekey={d.turnstileSiteKey} />}
                <div className="sm:col-span-2"><button className="btn btn-primary" disabled={nav.state !== 'idle'}>{tr('site.send')}</button></div>
              </Form></section>;
            case 'contact': return <section key={i} id="contact" className="card mt-6 p-6"><h2 className="text-xl">{tr('site.contact')}</h2><p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>{d.school.phone ? <span className="num">{d.school.phone}</span> : null}{d.school.email ? ` · ${d.school.email}` : ''}</p>
              <Form method="post" className="mt-4 grid gap-3 sm:grid-cols-2"><input type="hidden" name="intent" value="contact" />
                <label className="block"><span className="label">{tr('common.name')}</span><input name="name" className="input" required /></label>
                <label className="block"><span className="label">{tr('common.phone')}</span><input name="phone" className="input num" inputMode="tel" /></label>
                <label className="block sm:col-span-2"><span className="label">{tr('site.message')}</span><textarea name="message" className="input" rows={3} required /></label>
                <div className="sm:col-span-2"><button className="btn btn-secondary" disabled={nav.state !== 'idle'}>{tr('site.send')}</button></div>
              </Form></section>;
            default: return null;
          }
        })}
        {d.turnstileSiteKey && <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />}
      </main>
      <footer className="mx-auto max-w-5xl px-4 py-8 text-xs" style={{ color: 'var(--muted)' }}>© {name} · <a href={tp('/portal/login')}>{tr('login.title')}</a> · <a href={tp('/portal')}>{tr('portal.children')}</a></footer>
    </div>
  );
}
