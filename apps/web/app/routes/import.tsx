import { useEffect, useState } from 'react';
import { useLoaderData } from 'react-router';
import type { Route } from './+types/import';
import { Banner, Button, Chip, DataTable, api, formatDateTime, formatNumber, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  return { locale: (user.locale as Locale) || context.locale, jobs: await context.app.importer.list(user.school_id) };
}
export function meta() { return [{ title: 'Pathshala — Import' }]; }

type Status = { id: string; status: string; total_rows: number; success_rows: number; error_rows: number; errors_file_id: string | null; progressPct: number; jobError: string | null };

export default function Import() {
  const d = useLoaderData<typeof loader>();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ id: string; total: number; valid: number; invalid: number; errors: { row: number; field: string; message: string }[] } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    if (!result || (status && ['success', 'failed'].includes(status.status))) return;
    const id = setInterval(async () => { try { setStatus(await api<Status>(`/api/import/jobs/${result.id}`)); } catch { /* keep polling */ } }, 1500);
    return () => clearInterval(id);
  }, [result, status]);
  const upload = async (file: File) => {
    setBusy(true); setErr(null); setResult(null); setStatus(null);
    try {
      const b64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
      setResult(await api('/api/import/students', { method: 'POST', json: { fileName: file.name, base64: b64 } }));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const errorLink = async (fileId: string) => { const r = await api<{ url: string }>(`/api/files/${fileId}/url`).catch(() => null); if (r?.url) window.open(r.url, '_blank'); };

  return (
    <div>
      <h1 className="text-2xl">{tr('imp.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('imp.purpose')}</p>
      <div className="card mt-4 flex flex-wrap items-center gap-3 p-4">
        <a className="btn btn-secondary" href="/api/import/template">{tr('imp.template')}</a>
        <label className="btn btn-primary" style={{ cursor: 'pointer' }}>{busy ? tr('common.loading') : tr('imp.upload')}<input type="file" accept=".xlsx,.xls" className="hidden" disabled={busy} onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); e.currentTarget.value = ''; }} /></label>
      </div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {result && <div className="card mt-4 p-4">
        <div className="flex flex-wrap items-center gap-4"><span className="chip chip-ok">{formatNumber(result.valid, d.locale)} {tr('imp.valid')}</span><span className={`chip ${result.invalid ? 'chip-bad' : ''}`}>{formatNumber(result.invalid, d.locale)} {tr('imp.invalid')}</span><span className="chip chip-warn">{status?.status === 'success' ? tr('imp.done') : tr('imp.running')} {status ? `${formatNumber(Math.round(status.progressPct), d.locale)}%` : ''}</span>{status?.errors_file_id && <Button size="sm" variant="secondary" onClick={() => errorLink(status.errors_file_id!)}>{tr('imp.errorFile')}</Button>}</div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}><div className="h-2" style={{ width: `${status?.progressPct ?? 0}%`, background: 'var(--auto)', transition: 'width .3s' }} /></div>
        {status?.jobError && <div className="mt-2 text-xs" style={{ color: 'var(--bad)' }}>{status.jobError}</div>}
        {result.errors.length > 0 && <table className="table mt-3"><thead><tr><th>Row</th><th>Field</th><th>Problem</th></tr></thead><tbody>{result.errors.map((e, i) => <tr key={i}><td className="num">{e.row}</td><td>{e.field}</td><td>{e.message}</td></tr>)}</tbody></table>}
      </div>}
      <h2 className="mt-6 text-base">{tr('imp.history')}</h2>
      <div className="mt-2"><DataTable locale={d.locale} searchable={false} rows={d.jobs} columns={[{ key: 'created_at', label: tr('common.date'), render: r => formatDateTime(String(r.created_at), d.locale) }, { key: 'total_rows', label: 'Rows', className: 'num' }, { key: 'success_rows', label: 'OK', className: 'num' }, { key: 'error_rows', label: 'Errors', className: 'num' }, { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status)} /> }, { key: 'errors_file_id', label: '', render: r => r.errors_file_id ? <Button size="sm" variant="secondary" onClick={() => errorLink(String(r.errors_file_id))}>{tr('imp.errorFile')}</Button> : null }]} /></div>
    </div>
  );
}
