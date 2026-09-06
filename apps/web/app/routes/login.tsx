import { Form, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';
import type { Route } from './+types/login';
import { t, type Locale } from '@pathshala/ui';
import { assertSameOrigin, formString, sessionCookie } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  if (!(await context.app.installer.isInstalled())) throw redirect('/install');
  if (context.user) throw redirect('/dashboard');
  const school = await context.app.db.findOne<{ name: string; name_bn: string | null; locale: string }>('schools', {}, { orderBy: 'created_at ASC' });
  const next = new URL(request.url).searchParams.get('next') || '/dashboard';
  return { locale: context.locale as Locale, school, next, turnstileSiteKey: context.app.config.env.TURNSTILE_SITE_KEY || null, otpEnabled: context.app.adapters.sms.kind !== 'log' || context.app.adapters.mail.kind !== 'log' };
}

export async function action({ context, request }: Route.ActionArgs) {
  assertSameOrigin(request, context.app.config.appUrl);
  const fd = await request.formData();
  const intent = formString(fd, 'intent') || 'password';
  const next = formString(fd, 'next') || '/dashboard';
  const secure = context.app.config.appUrl.startsWith('https');
  const meta = { platform: 'web' as const, ip: request.headers.get('x-forwarded-for')?.split(',')[0] ?? null, userAgent: request.headers.get('user-agent') };
  try {
    if (intent === 'otp-request') {
      const target = formString(fd, 'identifier');
      const user = await context.app.auth.findByIdentifier(target);
      if (user) await context.app.auth.issueOtp({ schoolId: user.school_id, target, channel: target.includes('@') ? 'email' : 'sms', purpose: 'login', userId: user.id });
      return { otpSent: true, identifier: target };
    }
    if (intent === 'otp-verify') {
      const target = formString(fd, 'identifier');
      const user = await context.app.auth.findByIdentifier(target);
      if (!user) return { error: 'login.failed' as const, otpSent: true, identifier: target };
      const r = await context.app.auth.loginWithOtp({ schoolId: user.school_id, target, code: formString(fd, 'code'), ...meta });
      return redirect(next.startsWith('/') ? next : '/dashboard', { headers: { 'Set-Cookie': sessionCookie(r.token, r.expiresAt, secure) } });
    }
    const r = await context.app.auth.login({ identifier: formString(fd, 'identifier'), password: formString(fd, 'password'), totp: formString(fd, 'totp') || undefined, remember: fd.get('remember') === 'on', ...meta });
    if ('totpRequired' in r) return { totpRequired: true, identifier: formString(fd, 'identifier') };
    return redirect(next.startsWith('/') ? next : '/dashboard', { headers: { 'Set-Cookie': sessionCookie(r.token, r.expiresAt, secure) } });
  } catch (e) {
    const err = e as { status?: number; message: string };
    return { error: err.status === 401 ? ('login.failed' as const) : err.message, identifier: formString(fd, 'identifier'), totpRequired: formString(fd, 'totp') !== '' && err.status === 401 ? false : undefined };
  }
}

export function meta() { return [{ title: 'Pathshala — Sign in' }]; }

export default function Login() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as { error?: string; totpRequired?: boolean; otpSent?: boolean; identifier?: string } | undefined;
  const nav = useNavigation();
  const locale = data.locale;
  const tr = (k: Parameters<typeof t>[0]) => t(k, locale);
  const busy = nav.state !== 'idle';
  const schoolName = locale === 'bn' && data.school?.name_bn ? data.school.name_bn : data.school?.name;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-6" lang={locale}>
      <div className="mb-6">
        <div className="text-xs font-medium" style={{ color: 'var(--accent)' }}>{tr('app.name')}</div>
        <h1 className="text-2xl">{schoolName ?? tr('login.title')}</h1>
      </div>
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
      <p className="mt-6 text-center text-xs" style={{ color: 'var(--muted)' }}><a href={`/login?next=${encodeURIComponent(data.next)}`} onClick={e => { e.preventDefault(); document.cookie = `ps_locale=${locale === 'bn' ? 'en' : 'bn'}; Path=/; Max-Age=31536000`; window.location.reload(); }}>{tr('lang.switch')}</a></p>
    </main>
  );
}
