import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { LiveClock, LocaleToggle, api, formatDateTime, t, type Locale } from '@pathshala/ui';
import { useTenantPath } from '~/tenant';

interface Found { kind: string; id: string; title: string; subtitle: string; href: string }
interface Note { id: string; title: string; body: string; created_at: string; status: string }

/**
 * The bar across the top of every console page.
 *
 * A school office does not think in modules: somebody rings about "Rahim in class four" or reads out
 * an invoice number, and the answer has to be one box away. Beside it are the things a head teacher
 * glances at rather than opens — the time the school itself is keeping, in both calendars, what has
 * arrived, and the language the person reads in.
 */
export function TopBar({ locale, timeZone, year, notifications = 0 }: { locale: Locale; timeZone: string; year?: string | null; notifications?: number }) {
  const tr = (k: Parameters<typeof t>[0]) => t(k, locale);
  const tp = useTenantPath();
  const { pathname } = useLocation();
  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b px-4 py-2" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
      <Search locale={locale} />
      <div className="ml-auto flex items-center gap-2">
        {year && <span className="chip" title={tr('top.year')}>{year}</span>}
        <LiveClock locale={locale} timeZone={timeZone} compact />
        <NotificationBell locale={locale} count={notifications} />
        <ThemeToggle locale={locale} />
        <LocaleToggle locale={locale} />
      </div>
      <div className="w-full text-xs" style={{ color: 'var(--muted)' }}>
        <Link to={tp('/dashboard')} className="underline-offset-2 hover:underline">{tr('nav.dashboard')}</Link>
        {pathname.split('/').filter(Boolean).slice(-1).map(seg => <span key={seg}> › {seg}</span>)}
      </div>
    </header>
  );
}

/** Students, staff, guardians, invoices and books — whatever this person is allowed to open. */
function Search({ locale }: { locale: Locale }) {
  const tr = (k: Parameters<typeof t>[0]) => t(k, locale);
  const tp = useTenantPath();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Found[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  // "/" puts the cursor here, the way every console a teacher already uses does
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement | null)?.tagName ?? '');
      if (e.key === '/' && !typing) { e.preventDefault(); box.current?.focus(); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // one request per pause in typing, not one per keystroke: a shared host has other work to do
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const id = setTimeout(async () => {
      try {
        const r = await api<{ results: Found[] }>(`/api/search?q=${encodeURIComponent(q)}`);
        setHits(r.results); setOpen(true);
      } catch { setHits([]); }
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  return (
    <div className="relative min-w-[200px] flex-1 sm:max-w-[420px]">
      <input
        ref={box} className="input" type="search" value={q} placeholder={tr('top.search')}
        onChange={e => setQ(e.target.value)} onFocus={() => hits.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && hits.length > 0 && (
        <ul className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-[60vh] overflow-auto rounded-[var(--radius-card)] border p-1" style={{ borderColor: 'var(--line)', background: 'var(--surface)', boxShadow: 'var(--shadow-float)' }}>
          {hits.map(h => (
            <li key={`${h.kind}:${h.id}`}>
              <Link to={tp(h.href)} className="flex items-center gap-2 rounded-[var(--radius-ctl)] px-2 py-2 text-sm hover:bg-[var(--accent-soft)]" onClick={() => setOpen(false)}>
                <span className="chip">{tr(`top.kind.${h.kind}` as never)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{h.title}</span>
                  <span className="block truncate text-xs" style={{ color: 'var(--muted)' }}>{h.subtitle}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What has arrived for this person, unread first. */
function NotificationBell({ locale, count }: { locale: Locale; count: number }) {
  const tr = (k: Parameters<typeof t>[0]) => t(k, locale);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [unread, setUnread] = useState(count);
  return (
    <div className="relative">
      <button
        className="btn btn-ghost btn-sm" aria-label={tr('top.notifications')} aria-expanded={open}
        onClick={async () => {
          setOpen(o => !o);
          if (notes === null) { try { setNotes(await api<Note[]>('/api/notifications')); } catch { setNotes([]); } }
        }}
      >
        ●{unread > 0 && <span className="chip chip-bad ml-1">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-40 max-h-[60vh] w-[320px] overflow-auto rounded-[var(--radius-card)] border p-2" style={{ borderColor: 'var(--line)', background: 'var(--surface)', boxShadow: 'var(--shadow-float)' }}>
          {notes === null ? <p className="p-2 text-sm" style={{ color: 'var(--muted)' }}>{tr('common.loading')}</p>
            : notes.length === 0 ? <p className="p-2 text-sm" style={{ color: 'var(--muted)' }}>{tr('top.noNotifications')}</p>
              : notes.map(n => (
                <button
                  key={n.id} className="block w-full rounded-[var(--radius-ctl)] p-2 text-left text-sm hover:bg-[var(--accent-soft)]"
                  onClick={async () => { await api(`/api/notifications/${n.id}/read`, { method: 'POST', json: {} }).catch(() => undefined); setUnread(u => Math.max(0, u - 1)); }}
                >
                  <span className="block font-medium">{n.title}</span>
                  <span className="block" style={{ color: 'var(--muted)' }}>{n.body}</span>
                  <span className="block text-xs" style={{ color: 'var(--muted)' }}>{formatDateTime(n.created_at, locale)}</span>
                </button>
              ))}
        </div>
      )}
    </div>
  );
}

/**
 * Light or dark, kept in this browser. The palette already answers `prefers-color-scheme`, so the
 * button only exists for the person whose eyes disagree with their operating system.
 */
function ThemeToggle({ locale }: { locale: Locale }) {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  useEffect(() => {
    const saved = (localStorage.getItem('ps_theme') as 'light' | 'dark' | null) ?? null;
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    setTheme(saved ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  }, []);
  return (
    <button
      className="btn btn-ghost btn-sm" aria-label={t('top.theme', locale)}
      onClick={() => {
        const next = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('ps_theme', next); } catch { /* a private window keeps nothing */ }
        setTheme(next);
      }}
    >{theme === 'dark' ? '☾' : '☀'}</button>
  );
}
