import { useEffect, useRef, useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/chat';
import { Banner, Button, Input, api, formatDateTime, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

type Msg = { id: string; body: string | null; sender_id: string | null; sender_name: string | null; sent_at: string };

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const url = new URL(request.url);
  const conversations = await context.app.communication.conversations(user.school_id, user.id);
  const id = url.searchParams.get('id') ?? (conversations[0] ? String(conversations[0].id) : null);
  const messages = id ? await context.app.communication.messages(user.school_id, id, user.id) : [];
  return { locale: (user.locale as Locale) || context.locale, userId: user.id, conversations, id, messages };
}
export function meta() { return [{ title: 'Pathshala — Messages' }]; }

export default function Chat() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [text, setText] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [d.messages]);
  // live: the server publishes to `user:<id>` over SSE when someone sends a message
  useEffect(() => {
    if (typeof window === 'undefined' || !('EventSource' in window)) return;
    const es = new EventSource('/events');
    es.addEventListener('message', () => rv.revalidate());
    return () => es.close();
  }, [rv]);
  const send = async (e: React.FormEvent) => {
    e.preventDefault(); if (!text.trim() || !d.id) return;
    setBusy(true); setErr(null);
    try { await api(`/api/chat/${d.id}/messages`, { method: 'POST', json: { body: text } }); setText(''); rv.revalidate(); } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  const title = (c: Record<string, unknown>) => String(c.subject ?? (c.kind === 'direct' ? tr('chat.direct') : tr('chat.section')));

  return (
    <div>
      <h1 className="text-2xl">{tr('chat.title')}</h1>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      <div className="mt-4 grid gap-4 lg:grid-cols-[280px_1fr]">
        <aside className="card overflow-hidden">
          <ul className="divide-y" style={{ borderColor: 'var(--line)' }}>
            {d.conversations.map(c => (
              <li key={String(c.id)}><button className="w-full px-3 py-2 text-left" style={String(c.id) === d.id ? { background: 'var(--accent-soft)' } : undefined} onClick={() => { const n = new URLSearchParams(sp); n.set('id', String(c.id)); setSp(n); }}>
                <div className="flex items-center gap-2"><span className="flex-1 truncate text-sm font-medium">{title(c)}</span>{Number(c.unread) > 0 && <span className="chip chip-accent">{String(c.unread)}</span>}</div>
                <div className="truncate text-xs" style={{ color: 'var(--muted)' }}>{String(c.last_body ?? '—')}</div>
              </button></li>
            ))}
            {d.conversations.length === 0 && <li className="p-4 text-sm" style={{ color: 'var(--muted)' }}>{tr('chat.empty')}</li>}
          </ul>
        </aside>
        <section className="card flex h-[70vh] flex-col">
          <div className="flex-1 overflow-y-auto p-4">
            {(d.messages as unknown as Msg[]).map(m => {
              const mine = m.sender_id === d.userId;
              return <div key={m.id} className={`mb-3 flex ${mine ? 'justify-end' : ''}`}><div className="max-w-[75%] rounded-[var(--radius-card)] px-3 py-2 text-sm" style={{ background: mine ? 'var(--accent)' : 'var(--surface-2)', color: mine ? '#fff' : 'var(--ink)' }}>
                {!mine && <div className="text-xs font-medium" style={{ opacity: 0.8 }}>{m.sender_name}</div>}
                <div className="whitespace-pre-wrap">{m.body}</div>
                <div className="mt-1 text-[10px]" style={{ opacity: 0.7 }}>{formatDateTime(m.sent_at, d.locale)}</div>
              </div></div>;
            })}
            {d.messages.length === 0 && <p className="text-sm" style={{ color: 'var(--muted)' }}>—</p>}
            <div ref={bottom} />
          </div>
          <form className="flex gap-2 border-t p-3" style={{ borderColor: 'var(--line)' }} onSubmit={send}>
            <Input value={text} onChange={e => setText(e.target.value)} placeholder={tr('chat.write')} disabled={!d.id} />
            <Button disabled={busy || !d.id || !text.trim()}>{tr('chat.send')}</Button>
          </form>
        </section>
      </div>
    </div>
  );
}
