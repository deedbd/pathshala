import { useEffect, useState } from 'react';
import type { Route } from './+types/install';
import { redirect, useLoaderData } from 'react-router';
import { t, type Locale } from '@pathshala/ui';

type Step = { step: string; status: string; detail: unknown; finished_at: string | null };
type Status = { installed: boolean; engine: string; steps: Step[]; busy: boolean; school?: { id: string; name: string } | null };

export async function loader({ context }: Route.LoaderArgs) {
  if (await context.app.installer.isInstalled()) throw redirect('/dashboard');
  const status = await context.app.installer.status();
  return { status, locale: context.locale as Locale, appUrl: context.app.config.appUrl };
}

export function meta() { return [{ title: 'Pathshala — Setup' }]; }

export default function Install() {
  const data = useLoaderData<typeof loader>();
  const [locale, setLocale] = useState<Locale>(data.locale);
  const [status, setStatus] = useState<Status>(data.status as Status);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selfTest, setSelfTest] = useState<Record<string, { ok?: boolean; error?: string; [k: string]: unknown }> | null>(null);
  const tr = (k: Parameters<typeof t>[0]) => t(k, locale);
  const stepStatus = (s: string) => status.steps.find(x => x.step === s)?.status ?? 'pending';
  const prepared = stepStatus('schema') === 'done' && stepStatus('seeds') === 'done';

  const api = async (path: string, body?: unknown) => {
    const r = await fetch(`/api/install/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.issues ? j.issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join(', ') : j.error || r.statusText);
    return j;
  };
  const refresh = async () => { try { setStatus(await api('status')); } catch (e) { setError((e as Error).message); } };

  // step 7: schema + seeds run in the background; poll until done
  useEffect(() => {
    if (prepared) return;
    let stop = false;
    const kick = async () => { try { if (!status.busy && stepStatus('schema') !== 'done') await api('prepare', {}); } catch (e) { setError((e as Error).message); } };
    void kick();
    const id = setInterval(() => { if (!stop) void refresh(); }, 1500);
    return () => { stop = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepared]);

  const createSchool = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setBusy(true); setError(null);
    const fd = new FormData(e.currentTarget);
    try { await api('school', Object.fromEntries(fd.entries())); await refresh(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const runSelfTest = async () => { setBusy(true); setError(null); try { const r = await api('selftest', {}); setSelfTest(r.checks); await refresh(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } };
  const finish = async () => { setBusy(true); setError(null); try { await api('finish', {}); window.location.href = '/dashboard'; } catch (err) { setError((err as Error).message); setBusy(false); } };

  const steps: [string, Parameters<typeof t>[0]][] = [['schema', 'install.schema'], ['seeds', 'install.seeds'], ['school', 'install.school'], ['selftest', 'install.selftest'], ['done', 'install.done']];

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-8" lang={locale}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl">{tr('install.title')}</h1>
          <p className="mt-1" style={{ color: 'var(--muted)' }}>{tr('install.subtitle')}</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setLocale(locale === 'bn' ? 'en' : 'bn')}>{tr('lang.switch')}</button>
      </div>

      <ol className="card mt-6 divide-y" style={{ borderColor: 'var(--line)' }}>
        {steps.map(([key, label], i) => {
          const st = stepStatus(key);
          const detail = status.steps.find(x => x.step === key)?.detail as Record<string, unknown> | null;
          return (
            <li key={key} className="flex items-center gap-3 px-4 py-3">
              <span className={`feed-icon ${st === 'done' ? 'feed-rule' : st === 'failed' ? '' : 'feed-system'}`} style={st === 'failed' ? { background: 'color-mix(in srgb, var(--bad) 15%, transparent)', color: 'var(--bad)' } : undefined}>{st === 'done' ? '✓' : st === 'failed' ? '!' : i + 1}</span>
              <div className="flex-1">
                <div className="font-medium">{tr(label)}</div>
                {key === 'schema' && st === 'done' && detail && <div className="text-xs" style={{ color: 'var(--muted)' }}>{String(detail.engine)} · {String(detail.statements)} statements</div>}
                {key === 'seeds' && st === 'done' && detail && <div className="text-xs" style={{ color: 'var(--muted)' }}>{Object.entries(detail).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>}
                {st === 'failed' && detail && <div className="text-xs" style={{ color: 'var(--bad)' }}>{String((detail as { error?: string }).error)}</div>}
              </div>
              <span className={`chip ${st === 'done' ? 'chip-ok' : st === 'failed' ? 'chip-bad' : st === 'running' ? 'chip-warn' : ''}`}>{t(`status.${st === 'done' ? 'done' : st === 'failed' ? 'failed' : st === 'running' ? 'running' : 'pending'}` as never, locale)}</span>
            </li>
          );
        })}
      </ol>

      {error && <div className="banner banner-bad mt-4">{error}</div>}
      {!prepared && <div className="banner banner-info mt-4">{tr('install.preparing')} <span className="text-xs">({status.engine})</span></div>}

      {prepared && stepStatus('school') !== 'done' && (
        <form onSubmit={createSchool} className="card mt-6 grid gap-4 p-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><label className="label">{tr('install.schoolName')}</label><input name="schoolName" className="input" required minLength={2} autoFocus /></div>
          <div className="sm:col-span-2"><label className="label">{tr('install.schoolNameBn')}</label><input name="schoolNameBn" className="input" lang="bn" /></div>
          <div><label className="label">{tr('install.type')}</label>
            <select name="institutionType" className="input" defaultValue="school">
              {['school', 'college', 'school_college', 'madrasa', 'kindergarten', 'coaching', 'university'].map(v => <option key={v} value={v}>{v.replace('_', ' + ')}</option>)}
            </select></div>
          <div><label className="label">{tr('install.locale')}</label>
            <select name="locale" className="input" defaultValue={locale}><option value="bn">বাংলা</option><option value="en">English</option></select></div>
          <div><label className="label">{tr('install.adminName')}</label><input name="adminName" className="input" required /></div>
          <div><label className="label">{tr('install.adminPhone')}</label><input name="adminPhone" className="input num" required placeholder="01XXXXXXXXX" inputMode="tel" /></div>
          <div><label className="label">{tr('install.adminEmail')}</label><input name="adminEmail" className="input" type="email" /></div>
          <div><label className="label">{tr('install.adminPassword')}</label><input name="adminPassword" className="input" type="password" required minLength={8} /></div>
          <div className="sm:col-span-2 flex justify-end"><button className="btn btn-primary" disabled={busy}>{tr('install.create')}</button></div>
        </form>
      )}

      {stepStatus('school') === 'done' && stepStatus('selftest') !== 'done' && (
        <div className="card mt-6 p-4">
          <p>{status.school?.name}</p>
          <button className="btn btn-primary mt-3" onClick={runSelfTest} disabled={busy}>{tr('install.runSelfTest')}</button>
          {selfTest && (
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {Object.entries(selfTest).map(([k, v]) => (
                <li key={k} className="flex items-center justify-between rounded-[var(--radius-ctl)] px-3 py-2" style={{ background: 'var(--surface-2)' }}>
                  <span className="font-medium">{k}</span>
                  <span className={`chip ${v.ok === false ? 'chip-bad' : v.ok ? 'chip-ok' : ''}`}>{v.ok === false ? (v.error ?? 'failed') : v.ok ? 'ok' : String(v.kind ?? '—')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {stepStatus('selftest') === 'done' && (
        <div className="card mt-6 p-4 flex items-center justify-between gap-4">
          <div><div className="font-medium">{status.school?.name}</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{data.appUrl}</div></div>
          <button className="btn btn-primary" onClick={finish} disabled={busy}>{tr('install.finish')}</button>
        </div>
      )}
    </main>
  );
}
