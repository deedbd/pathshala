import { Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { Route } from './+types/portal-login';
import { t, type Locale } from '@pathshala/ui';
import { assertSameOrigin, formString, sessionCookie } from '~/lib';
import { ctxPath, safeNext, sessionMatchesTenant, tenantPrefix, useTenantPath } from '~/tenant';

/**
 * Where a guardian, a student or an alumnus signs in: `/<slug>/portal/login`.
 *
 * This is the deliberate exception to the door.
 *
 * A school's console moved behind an address nobody can guess, because a console is the school's
 * whole register and only a handful of people ever open it. A portal is the opposite: five hundred
 * families, a printed card in a school bag, a link forwarded to a grandparent. An address shared
 * that widely is not a secret by the end of the first week, and pretending otherwise buys nothing
 * while costing a great deal — a guardian who cannot sign in is a school that stops using the
 * software. So the portal keeps a findable front door, and the console does not.
 *
 * What makes that safe is the line drawn below: **this page signs in portal accounts and nothing
 * else.** A staff or admin account offered here is refused with the answer a wrong password gets, so
 * this page can never be used as a way around the console's door.
 */
const PORTAL_TYPES = ['guardian', 'student', 'alumni'];

export async function loader({ context, request }: Route.LoaderArgs) {
  // /install is the installation's own page and lives only at the root, so it is never prefixed.
  if (!(await context.app.installer.isInstalled())) throw redirect('/install');
  const prefix = tenantPrefix(context);
  const elsewhere = !sessionMatchesTenant(context, context.user);
  if (context.user && !elsewhere && PORTAL_TYPES.includes(String(context.user.user_type))) throw redirect(ctxPath(context, '/portal'));
  // The school in the URL, not whichever school was created first. Only the vendor's own
  // host-and-root, where no school was named, falls back to the installation's founder school.
  type SchoolRow = { name: string; name_bn: string | null; locale: string; theme: { accent?: string; logo?: string } | null };
  const school = context.tenant
    ? await context.app.db.findOne<SchoolRow>('schools', { id: context.tenant.schoolId })
    : await context.app.db.findOne<SchoolRow>('schools', {}, { orderBy: 'created_at ASC' });
  const next = safeNext(prefix, new URL(request.url).searchParams.get('next'), '/portal');
  const locale = ((school?.locale as Locale) === 'en' || (school?.locale as Locale) === 'bn' ? (school?.locale as Locale) : context.locale) as Locale;
  return { locale, school: school && { name: school.name, name_bn: school.name_bn, theme: school.theme ?? null }, next, elsewhere, turnstileSiteKey: context.app.config.env.TURNSTILE_SITE_KEY || null, otpEnabled: context.app.adapters.sms.kind !== 'log' || context.app.adapters.mail.kind !== 'log' };
}

/** A guardian, a student or an alumnus. Anybody else is answered as a wrong password. */
function isPortalAccount(user: { user_type?: string } | null | undefined): boolean {
  return !!user && PORTAL_TYPES.includes(String(user.user_type));
}

export async function action({ context, request }: Route.ActionArgs) {
  assertSameOrigin(request, context.app.config.appUrl);
  const fd = await request.formData();
  const intent = formString(fd, 'intent') || 'password';
  const prefix = tenantPrefix(context);
  const next = safeNext(prefix, formString(fd, 'next'), '/portal');
  const secure = context.app.config.appUrl.startsWith('https');
  const meta = { platform: 'web' as const, ip: request.headers.get('x-forwarded-for')?.split(',')[0] ?? null, userAgent: request.headers.get('user-agent') };
  try {
    if (intent === 'otp-request') {
      const target = formString(fd, 'identifier');
      const user = await context.app.auth.findByIdentifier(target);
      // A code is only ever sent to a portal account of the school in the URL; the answer is the same
      // either way, so this page never says whether a name belongs to a school or to its staff.
      if (user && sessionMatchesTenant(context, user) && isPortalAccount(user)) await context.app.auth.issueOtp({ schoolId: user.school_id, target, channel: target.includes('@') ? 'email' : 'sms', purpose: 'login', userId: user.id });
      return { otpSent: true, identifier: target };
    }
    if (intent === 'otp-verify') {
      const target = formString(fd, 'identifier');
      const user = await context.app.auth.findByIdentifier(target);
      if (!user || !sessionMatchesTenant(context, user) || !isPortalAccount(user)) return { error: 'login.failed' as const, otpSent: true, identifier: target };
      const r = await context.app.auth.loginWithOtp({ schoolId: user.school_id, target, code: formString(fd, 'code'), ...meta });
      return redirect(next, { headers: { 'Set-Cookie': sessionCookie(r.token, r.expiresAt, secure) } });
    }
    const identifier = formString(fd, 'identifier');
    const r = await context.app.auth.login({ identifier, password: formString(fd, 'password'), totp: formString(fd, 'totp') || undefined, remember: fd.get('remember') === 'on', ...meta });
    if ('totpRequired' in r) return { totpRequired: true, identifier };
    const user = r.user as { school_id: string; user_type: string };
    // Staff sign in at their school's own door and nowhere else. If this page admitted an admin, the
    // door would be decoration: anybody could sign in here and then open /dashboard.
    if (!isPortalAccount(user) || !sessionMatchesTenant(context, user)) {
      await context.app.auth.logout(r.token).catch(() => undefined);
      return { error: 'login.failed' as const, identifier };
    }
    return redirect(next, { headers: { 'Set-Cookie': sessionCookie(r.token, r.expiresAt, secure) } });
  } catch (e) {
    const err = e as { status?: number; message: string };
    return { error: err.status === 401 ? ('login.failed' as const) : err.message, identifier: formString(fd, 'identifier'), totpRequired: formString(fd, 'totp') !== '' && err.status === 401 ? false : undefined };
  }
}

export function meta({ data }: Route.MetaArgs) { return [{ title: data?.school?.name ? `${data.school.name} — Sign in` : 'Pathshala — Sign in' }]; }

export default function PortalLogin() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as { error?: string; totpRequired?: boolean; otpSent?: boolean; identifier?: string } | undefined;
  const nav = useNavigation();
  const tp = useTenantPath();
  const locale = data.locale;
  const tr = (k: Parameters<typeof t>[0]) => t(k, locale);
  const busy = nav.state !== 'idle';
  const schoolName = locale === 'bn' && data.school?.name_bn ? data.school.name_bn : data.school?.name;

  const accent = data.school?.theme?.accent;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-6" lang={locale} style={accent ? ({ '--accent': accent } as React.CSSProperties) : undefined}>
      <div className="mb-6">
        <div className="text-xs font-medium" style={{ color: 'var(--accent)' }}>{tr('app.name')}</div>
        {data.school?.theme?.logo && <img src={data.school.theme.logo} alt="" className="mb-2 h-12 w-auto" />}
        <h1 className="text-2xl">{schoolName ?? tr('login.title')}</h1>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{tr('login.portalOnly')}</p>
      </div>
      {data.elsewhere && <div className="banner banner-warn mb-4">{tr('login.otherSchool')}</div>}
      {result?.error && <div className="banner banner-bad mb-4">{result.error === 'login.failed' ? tr('login.failed') : result.error}</div>}
      {result?.otpSent ? (
        <Form method="post" className="card grid gap-3 p-4">
          <input type="hidden" name="intent" value="otp-verify" /><input type="hidden" name="next" value={data.next} /><input type="hidden" name="identifier" value={result.identifier} />
          <div><label className="label">{tr('login.totp').replace('Authenticator', 'SMS/email').replace('অথেনটিকেটর', 'এসএমএস/ইমেইল')}</label><input name="code" className="input num" inputMode="numeric" autoComplete="one-time-code" required autoFocus /></div>
          <button className="btn btn-primary" disabled={busy}>{tr('login.submit')}</button>
        </Form>
      ) : (
        <Form method="post" className="card grid gap-3 p-4">
          <input type="hidden" name="intent" value="password" /><input type="hidden" name="next" value={data.next} />
          <div><label className="label">{tr('login.identifier')}</label><input name="identifier" className="input" defaultValue={result?.identifier} required autoFocus autoComplete="username" /></div>
          {!result?.totpRequired && <div><label className="label">{tr('login.password')}</label><input name="password" className="input" type="password" required autoComplete="current-password" /></div>}
          {result?.totpRequired && <>
            <input type="hidden" name="password" value="" />
            <div><label className="label">{tr('login.totp')}</label><input name="totp" className="input num" inputMode="numeric" pattern="\d{6}" required autoFocus /></div>
          </>}
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="remember" defaultChecked /> {locale === 'bn' ? 'এই ডিভাইসে মনে রাখুন' : 'Remember this device'}</label>
          {data.turnstileSiteKey && <div className="cf-turnstile" data-sitekey={data.turnstileSiteKey} />}
          <button className="btn btn-primary" disabled={busy}>{tr('login.submit')}</button>
          {data.otpEnabled && <button className="btn btn-ghost btn-sm" name="intent" value="otp-request" formNoValidate>{tr('login.otp')}</button>}
        </Form>
      )}
      {data.turnstileSiteKey && <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />}
      <p className="mt-6 text-center text-xs" style={{ color: 'var(--muted)' }}><a href={`${tp('/portal/login')}?next=${encodeURIComponent(data.next)}`} onClick={e => { e.preventDefault(); document.cookie = `ps_locale=${locale === 'bn' ? 'en' : 'bn'}; Path=/; Max-Age=31536000`; window.location.reload(); }}>{tr('lang.switch')}</a></p>
    </main>
  );
}
