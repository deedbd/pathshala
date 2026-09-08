import { Form } from 'react-router';
import type { AppLoadContext } from 'react-router';
import { t, type Locale } from '@pathshala/ui';
import { assertSameOrigin, formString, sessionCookie } from '~/lib';
import { safeNext, sessionMatchesTenant, tenantPrefix } from '~/tenant';
import { clientIp, noteAttempt, notFound, throttled } from '~/door-owner';

/**
 * A school's own sign-in door.
 *
 * Every school gets an address nobody can guess — `https://school.edu.bd/x/<door>`, or
 * `https://pathshala.deedbd.com/<slug>/x/<door>` on the installation's shared host — generated when
 * the school is provisioned and emailed to the school. There is no `/login` any more: a generic
 * sign-in page is the one address every scanner on the internet already knows to try, and the owner
 * does not want a client's console to be findable at all.
 *
 * **The door is not the security boundary and nothing here is written as if it were.** The password,
 * the second factor, the session and the roles decide who gets in, exactly as before; a wrong door
 * just means there is no page. What the door buys is that a stranger has nothing to hammer, and a
 * school whose address leaks is one click away from a new one.
 *
 * The guardian and student portal is deliberately left outside all of this, at `/<slug>/portal`. An
 * address shared with five hundred families is not a secret by the end of the first week, and a
 * guardian who cannot sign in is a school that stops using the software — so families keep a
 * findable front door and only the console, which is where a school's whole register lives, moves
 * behind a private one.
 */
type Args = { context: AppLoadContext; request: Request; params: { door?: string } };

/**
 * The door is drawn only where a school owns the address, only for that school's own door, and only
 * five times a quarter of an hour from one caller. Everything refused is a 404: a 403 would tell a
 * stranger they had found a school's console and were one guess away from its sign-in form.
 */
async function guard({ context, request, params }: Args) {
  const tenant = context.tenant;
  if (!tenant) notFound();
  const ip = clientIp(request);
  const key = `school-door:${tenant.schoolId}:${ip ?? 'unknown'}`;
  if (throttled(key)) notFound();
  if (!(await context.app.tenant.resolveDoor(tenant.schoolId, params.door))) { noteAttempt(key); notFound(); }
  return { tenant, ip, key };
}

type SchoolBrand = { name: string; name_bn: string | null; locale: string; theme: { accent?: string; logo?: string } | null };

export async function schoolDoorLoader(args: Args) {
  const { context, request } = args;
  const { tenant } = await guard(args);
  if (!(await context.app.installer.isInstalled())) notFound();
  const school = await context.app.db.findOne<SchoolBrand>('schools', { id: tenant.schoolId });
  const prefix = tenantPrefix(context);
  const next = safeNext(prefix, new URL(request.url).searchParams.get('next'));
  const locale = ((school?.locale as Locale) === 'en' || (school?.locale as Locale) === 'bn' ? (school?.locale as Locale) : context.locale) as Locale;
  return {
    kind: 'school' as const,
    locale, next,
    school: school ? { name: school.name, name_bn: school.name_bn, theme: school.theme ?? null } : null,
    // a session belonging to another school standing at this door is shown this school's form
    elsewhere: !sessionMatchesTenant(context, context.user),
    turnstileSiteKey: context.app.config.env.TURNSTILE_SITE_KEY || null,
    otpEnabled: context.app.adapters.sms.kind !== 'log' || context.app.adapters.mail.kind !== 'log',
  };
}

export async function schoolDoorAction(args: Args) {
  const { context, request } = args;
  const { key } = await guard(args);
  assertSameOrigin(request, context.app.config.appUrl);
  const fd = await request.formData();
  const intent = formString(fd, 'intent') || 'password';
  const prefix = tenantPrefix(context);
  const next = safeNext(prefix, formString(fd, 'next'));
  const secure = context.app.config.appUrl.startsWith('https');
  const meta = { platform: 'web' as const, ip: request.headers.get('x-forwarded-for')?.split(',')[0] ?? null, userAgent: request.headers.get('user-agent') };
  const failed = (identifier: string, extra: Record<string, unknown> = {}) => {
    noteAttempt(key);
    return { kind: 'school' as const, error: 'login.failed' as const, identifier, ...extra };
  };
  try {
    if (intent === 'otp-request') {
      const target = formString(fd, 'identifier');
      const user = await context.app.auth.findByIdentifier(target);
      // a code is only ever sent for an account of the school whose door this is, and the answer is
      // the same either way, so this page never says whether a name belongs to some other school
      if (user && sessionMatchesTenant(context, user)) await context.app.auth.issueOtp({ schoolId: user.school_id, target, channel: target.includes('@') ? 'email' : 'sms', purpose: 'login', userId: user.id });
      return { kind: 'school' as const, otpSent: true, identifier: target };
    }
    if (intent === 'otp-verify') {
      const target = formString(fd, 'identifier');
      const user = await context.app.auth.findByIdentifier(target);
      if (!user || !sessionMatchesTenant(context, user)) return failed(target, { otpSent: true });
      const r = await context.app.auth.loginWithOtp({ schoolId: user.school_id, target, code: formString(fd, 'code'), ...meta });
      return new Response(null, { status: 302, headers: { Location: next, 'Set-Cookie': sessionCookie(r.token, r.expiresAt, secure) } });
    }
    const identifier = formString(fd, 'identifier');
    const r = await context.app.auth.login({ identifier, password: formString(fd, 'password'), totp: formString(fd, 'totp') || undefined, remember: fd.get('remember') === 'on', ...meta });
    if ('totpRequired' in r) return { kind: 'school' as const, totpRequired: true, identifier };
    // The Pathshala team does not sign in at a school's door. The session is dropped and the answer
    // is the one a wrong password gets, so this page never admits that such an account exists.
    try {
      await context.app.owner.requireOwner(r.user as { id: string; school_id: string; user_type: string });
      await context.app.auth.logout(r.token).catch(() => undefined);
      return failed(identifier);
    } catch { /* an ordinary school account: carry on */ }
    // …and neither does a member of another school on the same installation: a door is one school's.
    if (!sessionMatchesTenant(context, r.user as { school_id: string })) {
      await context.app.auth.logout(r.token).catch(() => undefined);
      return failed(identifier);
    }
    return new Response(null, { status: 302, headers: { Location: next, 'Set-Cookie': sessionCookie(r.token, r.expiresAt, secure) } });
  } catch (e) {
    if (e instanceof Response) throw e;
    noteAttempt(key);
    const err = e as { status?: number; message: string };
    return { kind: 'school' as const, error: err.status === 401 ? ('login.failed' as const) : err.message, identifier: formString(fd, 'identifier') };
  }
}

export function SchoolDoorPage({ data, result, busy, doorPath }: {
  data: Awaited<ReturnType<typeof schoolDoorLoader>>;
  result: { error?: string; totpRequired?: boolean; otpSent?: boolean; identifier?: string } | undefined;
  busy: boolean;
  doorPath: string;
}) {
  const locale = data.locale;
  const tr = (k: Parameters<typeof t>[0]) => t(k, locale);
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
      {/* the language switch reloads *this* address, door and all: there is nowhere else to send it */}
      <p className="mt-6 text-center text-xs" style={{ color: 'var(--muted)' }}>
        <a href={`${doorPath}?next=${encodeURIComponent(data.next)}`} onClick={e => { e.preventDefault(); document.cookie = `ps_locale=${locale === 'bn' ? 'en' : 'bn'}; Path=/; Max-Age=31536000`; window.location.reload(); }}>{tr('lang.switch')}</a>
      </p>
    </main>
  );
}
