import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/owner.support';
import { Banner, Button, Chip, DataTable, Drawer, Field, Select, Textarea, api, formatDate, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';
import { listOf, ownerApi, ownerLoad, str, type Row } from '~/owner-api';

const TICKET_STATUSES = ['open', 'in_progress', 'closed'];

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const status = new URL(request.url).searchParams.get('status') ?? '';
  const answer = await ownerLoad(() => ownerApi(context).tickets({ status: status || undefined }));
  return { locale: (user.locale as Locale) || context.locale, denied: answer === null, status, tickets: listOf(answer) };
}
export function meta() { return [{ title: 'Pathshala — Owner support' }]; }

export default function OwnerSupport() {
  const d = useLoaderData<typeof loader>();
  const rv = useRevalidator();
  const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [open, setOpen] = useState<Row | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  const date = (v: unknown) => (v ? formatDate(str(v), d.locale) : '—');
  const closed = (r: Row | null) => str(r?.status) === 'closed';

  if (d.denied) return <Banner kind="warn">{tr('own.refused')}</Banner>;

  return (
    <div>
      <div><h1 className="text-2xl">{tr('own.support')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('own.supportPurpose')}</p></div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Select value={d.status} onChange={e => setParam('status', e.target.value)} placeholder={tr('own.anyStatus')} options={TICKET_STATUSES.map(s => ({ value: s, label: s.replace('_', ' ') }))} className="max-w-[200px]" />
      </div>

      <div className="mt-3">
        <DataTable<Row> locale={d.locale} rows={d.tickets} searchPlaceholder={tr('own.searchSchools')} onRowClick={r => setOpen(r)} empty={tr('own.noTickets')} columns={[
          { key: 'school', label: tr('own.school'), render: r => str(r.school_name ?? r.school ?? r.school_id) },
          { key: 'subject', label: tr('own.subject'), render: r => str(r.subject) },
          { key: 'priority', label: tr('own.priority'), render: r => <Chip status={str(r.priority) === 'urgent' || str(r.priority) === 'high' ? 'failed' : 'pending'}>{str(r.priority)}</Chip> },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={str(r.status) === 'closed' ? 'done' : 'pending'}>{str(r.status)}</Chip> },
          { key: 'created_at', label: tr('own.opened'), render: r => date(r.created_at) },
        ]} />
      </div>

      <Drawer open={!!open} onClose={() => setOpen(null)} title={str(open?.subject) || tr('own.tickets')}>
        {open && <div className="grid gap-3">
          <div className="flex flex-wrap gap-2">
            <Chip status={closed(open) ? 'done' : 'pending'}>{str(open.status)}</Chip>
            <Chip status={str(open.priority) === 'urgent' || str(open.priority) === 'high' ? 'failed' : 'pending'}>{str(open.priority)}</Chip>
            <span className="chip">{str(open.school_name ?? open.school ?? open.school_id)}</span>
            <span className="chip">{date(open.created_at)}</span>
          </div>
          <div className="card whitespace-pre-wrap p-4 text-sm">{str(open.body)}</div>
          {str(open.resolution) && <div><div className="label">{tr('own.resolution')}</div><div className="card p-4 text-sm">{str(open.resolution)}</div></div>}
          {!closed(open) && <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); const id = str(open.id); run(async () => { await api(`/api/saas/tickets/${id}/close`, { method: 'POST', json: { resolution: str(f.get('resolution')) } }); setOpen(null); }); }}>
            <Field label={tr('own.resolution')}><Textarea name="resolution" maxLength={2000} rows={4} /></Field>
            <Button disabled={busy}>{tr('own.close')}</Button>
          </form>}
        </div>}
      </Drawer>
    </div>
  );
}
