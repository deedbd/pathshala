import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { formatNumber, type Locale } from './i18n';
import { chipClass } from './status';

export function Button({ variant = 'primary', size = 'md', className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  return <button className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${className}`} {...rest} />;
}

export function Field({ label, hint, error, children, className = '' }: { label: string; hint?: string; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs" style={{ color: 'var(--bad)' }}>{error}</span> : hint ? <span className="mt-1 block text-xs" style={{ color: 'var(--muted)' }}>{hint}</span> : null}
    </label>
  );
}
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className={`input ${props.className ?? ''}`} />; }
export function Select({ options, placeholder, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[]; placeholder?: string }) {
  return <select {...rest} className={`input ${rest.className ?? ''}`}>{placeholder && <option value="">{placeholder}</option>}{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...props} className={`input ${props.className ?? ''}`} rows={props.rows ?? 4} />; }

export function Chip({ status, children }: { status?: string | null; children?: ReactNode }) { return <span className={chipClass(status)}>{children ?? status}</span>; }
export function Banner({ kind = 'info', children }: { kind?: 'info' | 'ok' | 'warn' | 'bad'; children: ReactNode }) { return <div className={`banner banner-${kind}`}>{children}</div>; }
export function Kpi({ label, value, locale = 'bn' }: { label: string; value: number | string; locale?: Locale }) { return <div className="kpi"><div className="kpi-label">{label}</div><div className="kpi-value num">{typeof value === 'number' ? formatNumber(value, locale) : value}</div></div>; }
export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return <div className="card p-8 text-center"><div className="display text-base">{title}</div>{body && <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>{body}</p>}{action && <div className="mt-4">{action}</div>}</div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string; count?: number }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b" style={{ borderColor: 'var(--line)' }} role="tablist">
      {tabs.map(t => <button key={t.key} role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)} className="whitespace-nowrap px-3 py-2 text-sm" style={{ color: value === t.key ? 'var(--accent)' : 'var(--muted)', borderBottom: value === t.key ? '2px solid var(--accent)' : '2px solid transparent', fontWeight: value === t.key ? 600 : 400 }}>{t.label}{t.count != null && <span className="chip ml-1">{t.count}</span>}</button>)}
    </div>
  );
}

/** Right-hand drawer (560 px on desktop, full width on phones). Closes on Esc and backdrop click. */
export function Drawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0" style={{ background: 'rgb(23 32 42 / 0.4)' }} onClick={onClose} />
      <div className="relative flex h-full w-full max-w-[560px] flex-col" style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-float)' }}>
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--line)' }}><h2 className="text-base">{title}</h2><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="border-t px-4 py-3" style={{ borderColor: 'var(--line)' }}>{footer}</div>}
      </div>
    </div>
  );
}

export interface Column<T> { key: string; label: string; render?: (row: T) => ReactNode; className?: string; sortValue?: (row: T) => string | number }
/** Data table with search, client sort, pagination and an empty state. Server-side paging: pass `total` and `onPage`. */
export function DataTable<T extends { id?: unknown }>({ rows, columns, locale = 'bn', searchable = true, pageSize = 25, onRowClick, empty, total, onPage, page = 0, searchPlaceholder, toolbar }: { rows: T[]; columns: Column<T>[]; locale?: Locale; searchable?: boolean; pageSize?: number; onRowClick?: (row: T) => void; empty?: ReactNode; total?: number; onPage?: (page: number) => void; page?: number; searchPlaceholder?: string; toolbar?: ReactNode }) {
  const [q, setQ] = useState(''); const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null); const [localPage, setLocalPage] = useState(0);
  const filtered = useMemo(() => {
    let r = rows;
    if (q) { const needle = q.toLowerCase(); r = r.filter(row => JSON.stringify(row).toLowerCase().includes(needle)); }
    if (sort) { const col = columns.find(c => c.key === sort.key); r = [...r].sort((a, b) => { const av = col?.sortValue ? col.sortValue(a) : String((a as Record<string, unknown>)[sort.key] ?? ''); const bv = col?.sortValue ? col.sortValue(b) : String((b as Record<string, unknown>)[sort.key] ?? ''); return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir; }); }
    return r;
  }, [rows, q, sort, columns]);
  const serverPaged = total != null && onPage;
  const pageRows = serverPaged ? filtered : filtered.slice(localPage * pageSize, (localPage + 1) * pageSize);
  const pages = serverPaged ? Math.ceil((total ?? 0) / pageSize) : Math.ceil(filtered.length / pageSize);
  const cur = serverPaged ? page : localPage;
  return (
    <div className="card">
      {(searchable || toolbar) && <div className="flex flex-wrap items-center gap-2 border-b p-3" style={{ borderColor: 'var(--line)' }}>{searchable && <input className="input max-w-xs" placeholder={searchPlaceholder ?? (locale === 'bn' ? 'খুঁজুন…' : 'Search…')} value={q} onChange={e => { setQ(e.target.value); setLocalPage(0); }} />}<div className="ml-auto flex items-center gap-2">{toolbar}</div></div>}
      <div className="overflow-x-auto">
        <table className="table"><thead><tr>{columns.map(c => <th key={c.key} className={c.className}><button className="text-left" onClick={() => setSort(s => s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 })}>{c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button></th>)}</tr></thead>
          <tbody>
            {pageRows.map((row, i) => <tr key={String(row.id ?? i)} onClick={onRowClick ? () => onRowClick(row) : undefined} style={onRowClick ? { cursor: 'pointer' } : undefined}>{columns.map(c => <td key={c.key} className={c.className}>{c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '')}</td>)}</tr>)}
            {pageRows.length === 0 && <tr><td colSpan={columns.length} className="py-8 text-center text-sm" style={{ color: 'var(--muted)' }}>{empty ?? (locale === 'bn' ? 'কিছু নেই' : 'Nothing here yet')}</td></tr>}
          </tbody></table>
      </div>
      {pages > 1 && <div className="flex items-center justify-between border-t px-3 py-2 text-xs" style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}><span>{formatNumber(cur + 1, locale)} / {formatNumber(pages, locale)}</span><div className="flex gap-1"><button className="btn btn-secondary btn-sm" disabled={cur === 0} onClick={() => serverPaged ? onPage!(cur - 1) : setLocalPage(cur - 1)}>‹</button><button className="btn btn-secondary btn-sm" disabled={cur >= pages - 1} onClick={() => serverPaged ? onPage!(cur + 1) : setLocalPage(cur + 1)}>›</button></div></div>}
    </div>
  );
}

/** Small fetch helper for console pages: JSON in/out, throws with the server's message. */
export async function api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(path, { ...init, headers: { ...(init?.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) }, body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body, credentials: 'same-origin' });
  const text = await r.text(); let data: unknown = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) { const d = data as { error?: string; issues?: { path: string; message: string }[] }; throw new Error(d?.issues ? d.issues.map(i => `${i.path}: ${i.message}`).join(', ') : d?.error || r.statusText); }
  return data as T;
}
