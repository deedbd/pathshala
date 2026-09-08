import { Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { Route } from './+types/login';
import { t, type Locale } from '@pathshala/ui';
import { assertSameOrigin, formString, sessionCookie } from '~/lib';
import { ctxPath, safeNext, sessionMatchesTenant, tenantPrefix, useTenantPath } from '~/tenant';

export async function loader({ context, request }: Route.LoaderArgs) {
  // /install is the installation's own page and lives only at the root, so it is never prefixed.
  if (!(await context.app.installer.isInstalled())) throw redirect('/install');
  const prefix = tenantPrefix(context);
  // Already signed in to *this* school → the console. Signed in to another school and standing at
  // this one's address → this school's sign-in form, and the other school's console is not offered.
  const elsewhere = !sessionMatchesTenant(context, context.user);
  if (context.user && !elsewhere) throw redirect(ctxPath(context, '/dashboard'));
  // The school in the URL, not whichever school was created first. Only the vendor's own
  // host-and-root, where no school was named, falls back to the installation's founder school.
  type SchoolRow = { name: string; name_bn: string | null; locale: string; theme: { accent?: string; logo?: string } | null };
  const school = context.tenant
    ? await context.app.db.findOne<SchoolRow>('schools', { id: context.tenant.schoolId })
    : await context.app.db.findOne<SchoolRow>('schools', {}, { orderBy: 'created_at ASC' });
  const next = safeNext(prefix, new URL(request.url).searchParams.get('next'));
  const locale = ((school?.locale as Locale) === 'en' || (school?.locale as Locale) === 'bn' ? (school?.locale as Locale) : context.locale) as Locale;
  return { locale, school: school && { name: school.name, name_bn: school.name_bn, theme: school.theme ?? null }, next, elsewhere, turnstileSiteKey: context.app.config.env.TURNSTILE_SITE_KEY || null, otpEnabled: context.app.adapters.sms.kind !== 'log' || context.app.adapters.mail.kind !== 'log' };
}

export async function action({ context, request }: Route.ActionArgs) {
  assertSameOrigin(request, context.app.config.appUrl);
  const fd = await request.formData();
  const intent = formString(fd, 'intent') || 'password';
  const prefix = tenantPrefix(context);
  const next = safeNext(prefix, formString(fd, 'next'));
  const secure = context.app.config.appUrl.startsWith('https');
  const meta = { platform: 'web' as const, ip: request.headers.get('x-forwarded-for')?.split(',')[0] ?? null, userAgent: request.headers.get('user-agent') };
  try {
    if (intent === 'otp-request') {
      const target = formString(fd, 'identifier');
      const user = await context.app.auth.findByIdentifier(target);
      // A code is only ever sent for an account of the school in the URL; the answer is the same either
      // way, so this page never says whether a name belongs to some other school on the installation.
      if (user && sessionMatchesTenant(context, user)) await context.app.auth.issueOtp({ schoolId: user.school_id, target, channel: target.includes('@') ? 'email' : 'sms', purpose: 'login', userId: user.id });
      return { otpSent: true, identifier: target };
    }
    if (intent === 'otp-verify') {
      const target = formString(fd, 'identifier');
      const user = await context.app.auth.findByIdentifier(target);
      if (!user) return { error: 'login.failed' as const, otpSent: true, identifier: target };
      if (!sessionMatchesTenant(context, user)) return { error: 'login.failed' as const, otpSent: true, identifier: target };
      const r = await context.app.auth.loginWithOtp({ schoolId: user.school_id, target, code: formString(fd, 'code'), ...meta });
      return redirect(next, { headers: { 'Set-Cookie': sessionCookie(r.token, r.expiresAt, secure) } });
    }
    const r = await context.app.auth.login({ identifier: formString(fd, 'identifier'), password: formString(fd, 'password'), totp: formString(fd, 'totp') || undefined, remember: fd.get('remember') === 'on', ...meta });
    if ('totpRequired' in r) return { totpRequired: true, identifier: formString(fd, 'identifier') };
    // The Pathshala team does not sign in on a school's page. The session is dropped and the answer
    // is the one a wrong password gets, so this page never admits that such an account exists.
    try {
      await context.app.owner.requireOwner(r.user as { id: string; school_id: string; user_type: string });
      await context.app.auth.logout(r.token).catch(() => undefined);
      return { error: 'login.failed' as const, identifier: formString(fd, 'identifier') };
    } catch { /* an ordinary school account: carry on */ }
    // A staff member of another school signing in at this school's address gets the wrong-password
    // answer, exactly as the vendor's own account does: an address is one school and only one.
    if (!sessionMatchesTenant(context, r.user as { school_id: string })) {
      await context.app.auth.logout(r.token).catch(() => undefined);
      return { error: 'login.failed' as const, identifier: formString(fd, 'identifier') };
    }
    return redirect(next, { headers: { 'Set-Cookie': sessionCookie(r.token, r.expiresAt, secure) } });
  } catch (e) {
    const err = e as { status?: number; message: string };
    return { error: err.status === 401 ? ('login.failed' as const) : err.message, identifier: formString(fd, 'identifier'), totpRequired: formString(fd, 'totp') !== '' && err.status === 401 ? false : undefined };
  }
}

export function meta({ data }: Route.MetaArgs) { return [{ title: data?.school?.name ? `${data.school.name} — Sign in` : 'Pathshala — Sign in' }]; }

export default function Login() {
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
      <p className="mt-6 text-center text-xs" style={{ color: 'var(--muted)' }}><a href={`${tp('/login')}?next=${encodeURIComponent(data.next)}`} onClick={e => { e.preventDefault(); document.cookie = `ps_locale=${locale === 'bn' ? 'en' : 'bn'}; Path=/; Max-Age=31536000`; window.location.reload(); }}>{tr('lang.switch')}</a></p>
    </main>
  );
}
