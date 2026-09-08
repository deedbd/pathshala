import { Fragment, useMemo, useState } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/settings';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Select, Tabs, api, formatDateTime, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

/**
 * Settings — the six screens a school could not reach at all before: its own profile, the typed
 * policy keys every nightly job reads, its operator logins, the permission matrix, the document
 * numbering, and the audit log.
 *
 * The loader reads through `context.app` (no HTTP hop on a server render); every write goes back
 * through `/api/*`, which is where the permissions, the refusals and the audit rows live. A secret
 * arrives here as `{ enc: true }` and there is nothing on this page that could show it.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const sid = user.school_id;
  const app = context.app;
  // the loader reads straight from the services, so it has to ask the same questions the API asks —
  // otherwise a page render would hand somebody the audit log that `/api/audit` would have refused
  const access = await app.rbac.accessFor(user.id);
  const may = (perm: string) => app.rbac.can(perm, access);
  if (['guardian', 'student', 'alumni'].includes(user.user_type) || !may('platform.view')) throw new Response('forbidden', { status: 403 });
  const [settings, school, campuses, shifts, sequences, users, roles, audit] = await Promise.all([
    app.settings.list(sid),
    app.settings.profile(sid),
    app.academic.campuses(sid),
    app.academic.shifts(sid),
    app.numbering.sequences(sid),
    may('core.users') ? app.rbac.users(sid) : Promise.resolve([]),
    may('core.roles') ? app.rbac.roles(sid) : Promise.resolve({ roles: [], permissions: [], modules: [] }),
    may('core.audit') ? app.audit.search(sid, { pageSize: 50 }) : Promise.resolve({ rows: [], total: 0, page: 0, pageSize: 50, actions: [], entityTypes: [] }),
  ]);
  for (const row of app.settings.missing(settings)) settings[row.key] = row;
  return {
    locale: (user.locale as Locale) || context.locale,
    me: user.id,
    canWrite: may('platform.settings'),
    canUsers: may('core.users'), canRoles: may('core.roles'), canAudit: may('core.audit'),
    settings: Object.values(settings).sort((a, b) => a.key.localeCompare(b.key)),
    school, campuses, shifts, sequences, users, roles, audit,
  };
}
export function meta() { return [{ title: 'Pathshala — Settings' }]; }

type Tab = 'school' | 'policies' | 'users' | 'roles' | 'numbering' | 'audit';

export default function Settings() {
  const d = useLoaderData<typeof loader>();
  const rv = useRevalidator();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<Tab>('school');
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ what: string; value: string } | null>(null);
  const [drawer, setDrawer] = useState<null | 'campus' | 'shift' | 'invite' | 'userRoles' | 'sequence'>(null);
  const [target, setTarget] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, close = true) => {
    setBusy(true); setErr(null);
    try { await fn(); if (close) setDrawer(null); rv.revalidate(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const form = (e: React.FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  const when = (v: unknown) => (v ? formatDateTime(String(v), d.locale) : '—');

  return (
    <div>
      <div><h1 className="text-2xl">{tr('set.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('set.purpose')}</p></div>
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}
      {secret && <div className="mt-4"><Banner kind="warn"><strong>{secret.what}</strong>: <code>{secret.value}</code> — {tr('set.copyNow')}</Banner></div>}
      {!d.canWrite && <div className="mt-4"><Banner kind="info">{tr('set.readOnly')}</Banner></div>}

      {/* a tab only appears where the person could also call the endpoint behind it */}
      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'school' as const, label: tr('set.school') },
        { key: 'policies' as const, label: tr('set.policies'), count: d.settings.length },
        ...(d.canUsers ? [{ key: 'users' as const, label: tr('set.users'), count: d.users.length }] : []),
        ...(d.canRoles ? [{ key: 'roles' as const, label: tr('set.roles'), count: d.roles.roles.length }] : []),
        { key: 'numbering' as const, label: tr('set.numbering'), count: d.sequences.length },
        ...(d.canAudit ? [{ key: 'audit' as const, label: tr('set.audit'), count: d.audit.total }] : []),
      ]} /></div>

      {tab === 'school' && <SchoolTab d={d} tr={tr} run={run} busy={busy} form={form} open={k => setDrawer(k)} setTarget={setTarget} />}
      {tab === 'policies' && <PoliciesTab d={d} tr={tr} setErr={setErr} setMsg={setMsg} />}
      {tab === 'users' && <UsersTab d={d} tr={tr} run={run} when={when} open={k => setDrawer(k)} setTarget={setTarget} setSecret={setSecret} setMsg={setMsg} />}
      {tab === 'roles' && <RolesTab d={d} tr={tr} setErr={setErr} setMsg={setMsg} />}
      {tab === 'numbering' && <NumberingTab d={d} tr={tr} open={() => setDrawer('sequence')} setTarget={setTarget} />}
      {tab === 'audit' && <AuditTab d={d} tr={tr} when={when} setErr={setErr} />}

      {/* ---- school drawers ---- */}
      <Drawer open={drawer === 'campus'} onClose={() => setDrawer(null)} title={tr('set.addCampus')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/school/campuses', { method: 'POST', json: { name: f.name, code: f.code, address: f.address || null, phone: f.phone || null, isMain: f.isMain === 'on' } })); }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field>
          <Field label={tr('set.code')}><Input name="code" required maxLength={12} placeholder="MAIN" /></Field>
          <Field label={tr('set.address')}><Input name="address" /></Field>
          <Field label={tr('common.phone')}><Input name="phone" /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isMain" /> {tr('set.mainCampus')}</label>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'shift'} onClose={() => setDrawer(null)} title={tr('set.addShift')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = form(e); run(() => api('/api/school/shifts', { method: 'POST', json: { name: f.name, startTime: f.startTime, endTime: f.endTime } })); }}>
          <Field label={tr('common.name')}><Input name="name" required /></Field>
          <Field label={tr('set.startTime')}><Input name="startTime" type="time" required defaultValue="08:00" /></Field>
          <Field label={tr('set.endTime')}><Input name="endTime" type="time" required defaultValue="13:00" /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      {/* ---- users drawers ---- */}
      <Drawer open={drawer === 'invite'} onClose={() => setDrawer(null)} title={tr('set.invite')}>
        <form className="grid gap-3" onSubmit={e => {
          e.preventDefault(); const f = form(e);
          const roles = d.roles.roles.filter(r => f[`r_${r.slug}`] === 'on').map(r => r.slug);
          run(async () => {
            const r = await api<{ password: string }>('/api/users', { method: 'POST', json: { displayName: f.displayName, phone: f.phone || undefined, email: f.email || undefined, roles: roles.length ? roles : ['staff'] } });
            setSecret({ what: tr('set.oneTimePassword'), value: r.password });
            setMsg(tr('set.invitationSent'));
          });
        }}>
          <Field label={tr('common.name')}><Input name="displayName" required /></Field>
          <Field label={tr('common.phone')}><Input name="phone" placeholder="01XXXXXXXXX" /></Field>
          <Field label={tr('set.email')}><Input name="email" type="email" /></Field>
          <div className="grid grid-cols-2 gap-1 text-sm">
            {d.roles.roles.map(r => <label key={r.slug} className="flex items-center gap-1"><input type="checkbox" name={`r_${r.slug}`} defaultChecked={r.slug === 'staff'} /> {r.name}</label>)}
          </div>
          <Button disabled={busy}>{tr('set.invite')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'userRoles'} onClose={() => setDrawer(null)} title={tr('set.changeRoles')}>
        {(() => {
          const u = d.users.find(x => x.id === target);
          if (!u) return null;
          return <form className="grid gap-3" onSubmit={e => {
            e.preventDefault(); const f = form(e);
            const roles = d.roles.roles.filter(r => f[`r_${r.slug}`] === 'on').map(r => r.slug);
            run(() => api(`/api/users/${u.id}/roles`, { method: 'POST', json: { roles } }));
          }}>
            <p className="text-sm">{u.displayName}</p>
            <div className="grid grid-cols-2 gap-1 text-sm">
              {d.roles.roles.map(r => <label key={r.slug} className="flex items-center gap-1"><input type="checkbox" name={`r_${r.slug}`} defaultChecked={u.roles.some(x => x.slug === r.slug)} /> {r.name}</label>)}
            </div>
            <Button disabled={busy}>{tr('common.save')}</Button>
          </form>;
        })()}
      </Drawer>

      {/* ---- numbering drawer ---- */}
      <Drawer open={drawer === 'sequence'} onClose={() => setDrawer(null)} title={tr('set.numbering')}>
        {(() => {
          const s = d.sequences.find(x => x.id === target);
          if (!s) return null;
          return <form className="grid gap-3" onSubmit={e => {
            e.preventDefault(); const f = form(e);
            run(() => api(`/api/sequences/${s.id}`, { method: 'PATCH', json: { prefix: f.prefix, padding: Number(f.padding), nextValue: Number(f.nextValue), resetYearly: f.resetYearly === 'on' } }));
          }}>
            <p className="text-sm num">{s.key}</p>
            <Field label={tr('set.prefix')}><Input name="prefix" defaultValue={s.prefix} maxLength={20} /></Field>
            <Field label={tr('set.padding')}><Input name="padding" type="number" min={0} max={12} defaultValue={s.padding} /></Field>
            <Field label={tr('set.nextValue')} hint={`${tr('set.issued')}: ${s.issued}`}><Input name="nextValue" type="number" min={s.nextValue} defaultValue={s.nextValue} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="resetYearly" defaultChecked={s.resetYearly} /> {tr('set.yearly')}</label>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>{tr('set.numberingNote')}</p>
            <Button disabled={busy}>{tr('common.save')}</Button>
          </form>;
        })()}
      </Drawer>
    </div>
  );
}

// ------------------------------------------------------------------ School
type D = Awaited<ReturnType<typeof loader>>;
type Tr = (k: Parameters<typeof t>[0]) => string;

function SchoolTab({ d, tr, run, busy, form, open, setTarget }: { d: D; tr: Tr; run: (fn: () => Promise<unknown>, close?: boolean) => Promise<void>; busy: boolean; form: (e: React.FormEvent<HTMLFormElement>) => Record<string, string>; open: (k: 'campus' | 'shift') => void; setTarget: (v: string | null) => void }) {
  const s = d.school;
  return <div className="mt-4 grid gap-4 lg:grid-cols-2">
    <div className="card p-4">
      <h2 className="text-base">{tr('set.profile')}</h2>
      <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={e => {
        e.preventDefault(); const f = form(e);
        run(() => api('/api/school', { method: 'PATCH', json: {
          name: f.name, nameBn: f.nameBn || null, institutionType: f.institutionType, eiin: f.eiin || null, mpoCode: f.mpoCode || null, board: f.board || null,
          address: f.address || null, phone: f.phone || null, email: f.email || null, website: f.website || null,
          timezone: f.timezone, currency: f.currency, locale: f.locale,
        } }), false);
      }}>
        <Field label={tr('common.name')}><Input name="name" required defaultValue={s.name} /></Field>
        <Field label={tr('set.nameBn')}><Input name="nameBn" defaultValue={s.nameBn ?? ''} /></Field>
        <Field label={tr('common.type')}><Select name="institutionType" defaultValue={s.institutionType} options={['school', 'college', 'school_college', 'madrasa', 'kindergarten', 'coaching', 'university'].map(v => ({ value: v, label: v }))} /></Field>
        <Field label={tr('set.board')}><Input name="board" defaultValue={s.board ?? ''} /></Field>
        <Field label={tr('set.eiin')}><Input name="eiin" defaultValue={s.eiin ?? ''} /></Field>
        <Field label={tr('set.mpo')}><Input name="mpoCode" defaultValue={s.mpoCode ?? ''} /></Field>
        <Field label={tr('common.phone')}><Input name="phone" defaultValue={s.phone ?? ''} /></Field>
        <Field label={tr('set.email')}><Input name="email" defaultValue={s.email ?? ''} /></Field>
        <Field label={tr('set.website')}><Input name="website" defaultValue={s.website ?? ''} /></Field>
        <Field label={tr('set.address')}><Input name="address" defaultValue={s.address ?? ''} /></Field>
        <Field label={tr('set.timezone')}><Input name="timezone" defaultValue={s.timezone} /></Field>
        <Field label={tr('set.currency')}><Input name="currency" maxLength={3} defaultValue={s.currency} /></Field>
        <Field label={tr('set.locale')}><Select name="locale" defaultValue={s.locale} options={[{ value: 'bn', label: 'বাংলা' }, { value: 'en', label: 'English' }]} /></Field>
        <div className="sm:col-span-2"><Button disabled={busy || !d.canWrite}>{tr('common.save')}</Button></div>
      </form>
    </div>
    <div className="grid gap-4">
      <div className="card p-4">
        <div className="flex items-center justify-between"><h2 className="text-base">{tr('set.campuses')}</h2>{d.canWrite && <Button size="sm" onClick={() => open('campus')}>{tr('set.addCampus')}</Button>}</div>
        <div className="mt-2 grid gap-2">
          {d.campuses.map(c => <div key={c.id} className="flex items-center justify-between rounded-[var(--radius-ctl)] p-2" style={{ background: 'var(--surface-2)' }}>
            <div><div className="text-sm">{c.name} <span className="num text-xs" style={{ color: 'var(--muted)' }}>{c.code}</span></div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>{c.address ?? '—'} · {c.sectionCount} {tr('set.sections')}</div></div>
            <div className="flex items-center gap-1">{c.isMain ? <Chip status="active">{tr('set.mainCampus')}</Chip> : null}<Chip status={c.status === 'active' ? 'active' : 'draft'}>{c.status}</Chip></div>
          </div>)}
          {d.campuses.length === 0 && <p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('common.none')}</p>}
        </div>
      </div>
      <div className="card p-4">
        <div className="flex items-center justify-between"><h2 className="text-base">{tr('set.shifts')}</h2>{d.canWrite && <Button size="sm" onClick={() => { setTarget(null); open('shift'); }}>{tr('set.addShift')}</Button>}</div>
        <div className="mt-2 grid gap-2">
          {d.shifts.map(sh => <div key={String(sh.id)} className="flex items-center justify-between rounded-[var(--radius-ctl)] p-2" style={{ background: 'var(--surface-2)' }}>
            <span className="text-sm">{String(sh.name)}</span>
            <span className="num text-sm" style={{ color: 'var(--muted)' }}>{String(sh.start_time).slice(0, 5)} – {String(sh.end_time).slice(0, 5)}</span>
          </div>)}
          {d.shifts.length === 0 && <p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('common.none')}</p>}
        </div>
      </div>
    </div>
  </div>;
}

// ------------------------------------------------------------------ Policies
function PoliciesTab({ d, tr, setErr, setMsg }: { d: D; tr: Tr; setErr: (v: string | null) => void; setMsg: (v: string | null) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const groups = useMemo(() => {
    const by = new Map<string, D['settings']>();
    for (const s of d.settings) { const list = by.get(s.module) ?? []; list.push(s); by.set(s.module, list); }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [d.settings]);

  const asText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  const save = async (row: D['settings'][number]) => {
    const { key, type } = row;
    setSaving(key); setErr(null);
    try {
      // an untouched field saves what is already there, not an empty string
      const raw = draft[key] ?? asText(row.value);
      // a scalar goes as itself; a list or an object is typed as JSON, and a typo is refused here
      // rather than stored as a string a job cannot read
      let value: unknown = raw;
      if (raw.trim() === '' && type !== 'string') value = null;   // cleared means "unset", not "empty"
      else if (type === 'number') value = Number(raw);
      else if (type === 'boolean') value = raw === 'true';
      else if (type === 'list' || type === 'object') { try { value = JSON.parse(raw); } catch { throw new Error(`${key}: that is not valid JSON`); } }
      if (type === 'number' && Number.isNaN(value as number)) throw new Error(`${key}: that is not a number`);
      const r = await api<{ effect: string }>('/api/settings', { method: 'PUT', json: { key, value } });
      setMsg(r.effect);
    } catch (e) { setErr((e as Error).message); }
    finally { setSaving(null); }
  };

  return <div className="mt-4">
    <p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('set.policiesNote')}</p>
    {groups.map(([mod, rows]) => <div key={mod} className="mt-4">
      <h2 className="text-base">{mod}</h2>
      <div className="card mt-2 overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead><tr><th className="p-2 text-left">{tr('set.key')}</th><th className="p-2 text-left">{tr('set.value')}</th><th className="p-2 text-left">{tr('set.readBy')}</th></tr></thead>
          <tbody>
            {rows.map(s => <tr key={s.key} style={{ borderTop: '1px solid var(--line)' }}>
              <td className="p-2 align-top"><div className="num">{s.key}</div><div className="text-xs" style={{ color: 'var(--muted)' }}>{s.note}</div></td>
              <td className="p-2 align-top">
                {s.secret
                  ? <div><Chip status={s.value ? 'active' : 'pending'}>{s.value ? tr('set.secretSet') : tr('set.secretUnset')}</Chip><div className="text-xs" style={{ color: 'var(--muted)' }}>{tr('set.secretNote')}</div></div>
                  : <div className="flex flex-wrap items-center gap-2">
                    {s.type === 'boolean'
                      ? <Select value={draft[s.key] ?? String(s.value === true)} onChange={e => setDraft(x => ({ ...x, [s.key]: e.target.value }))} options={[{ value: 'true', label: tr('common.yes') }, { value: 'false', label: tr('common.no') }]} />
                      : <Input className="min-w-[180px] max-w-[260px]" value={draft[s.key] ?? asText(s.value)} onChange={e => setDraft(x => ({ ...x, [s.key]: e.target.value }))} />}
                    <Button size="sm" variant="secondary" disabled={saving === s.key || !d.canWrite} onClick={() => save(s)}>{tr('common.save')}</Button>
                    {s.value === null && <span className="text-xs" style={{ color: 'var(--muted)' }}>{tr('set.notSet')}</span>}
                  </div>}
              </td>
              <td className="p-2 align-top text-xs" style={{ color: 'var(--muted)' }}>{s.readBy ?? tr('set.notRead')}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>)}
  </div>;
}

// ------------------------------------------------------------------ Users
function UsersTab({ d, tr, run, when, open, setTarget, setSecret, setMsg }: {
  d: D; tr: Tr; when: (v: unknown) => string;
  run: (fn: () => Promise<unknown>, close?: boolean) => Promise<void>;
  open: (k: 'invite' | 'userRoles') => void; setTarget: (v: string | null) => void;
  setSecret: (v: { what: string; value: string } | null) => void; setMsg: (v: string | null) => void;
}) {
  return <div className="mt-4">
    <div className="mb-3 flex items-center justify-between">
      <p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('set.usersNote')}</p>
      {d.canWrite && <Button size="sm" onClick={() => open('invite')}>{tr('set.invite')}</Button>}
    </div>
    <DataTable locale={d.locale} rows={d.users} columns={[
      { key: 'displayName', label: tr('common.name') },
      { key: 'phone', label: tr('common.phone'), className: 'num', render: r => r.phone ?? r.email ?? r.username ?? '—' },
      { key: 'roles', label: tr('set.roles'), render: r => <span className="flex flex-wrap gap-1">{r.roles.map(x => <span key={x.slug} className="chip">{x.name}</span>)}</span> },
      { key: 'twoFactor', label: tr('set.twoFactor'), render: r => r.twoFactor ? <Chip status="active">TOTP</Chip> : <Chip status="pending">{tr('common.no')}</Chip> },
      { key: 'lastLoginAt', label: tr('set.lastLogin'), render: r => r.lastLoginAt ? when(r.lastLoginAt) : tr('set.neverSignedIn') },
      { key: 'isActive', label: tr('common.status'), render: r => r.isActive ? <Chip status="active">{tr('common.yes')}</Chip> : <Chip status="failed">{tr('set.disabled')}</Chip> },
      { key: 'id', label: '', render: r => d.canWrite ? <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="secondary" onClick={() => { setTarget(r.id); open('userRoles'); }}>{tr('set.changeRoles')}</Button>
        <Button size="sm" variant="secondary" onClick={() => run(async () => {
          const x = await api<{ password: string }>(`/api/users/${r.id}/reset`, { method: 'POST', json: {} });
          setSecret({ what: `${tr('set.oneTimePassword')} — ${r.displayName}`, value: x.password }); setMsg(tr('set.invitationSent'));
        }, false)}>{tr('set.resetPassword')}</Button>
        <Button size="sm" variant={r.isActive ? 'danger' : 'secondary'} disabled={r.id === d.me && r.isActive} onClick={() => run(() => api(`/api/users/${r.id}/disable`, { method: 'POST', json: { active: !r.isActive } }), false)}>{r.isActive ? tr('set.disable') : tr('set.enable')}</Button>
      </div> : null },
    ]} />
  </div>;
}

// ------------------------------------------------------------------ Roles
type Grants = Record<string, string[]>;

function RolesTab({ d, tr, setErr, setMsg }: { d: D; tr: Tr; setErr: (v: string | null) => void; setMsg: (v: string | null) => void }) {
  const loaded: Grants = useMemo(() => Object.fromEntries(d.roles.roles.map(r => [r.id, [...r.permissions]])), [d.roles]);
  const [grants, setGrants] = useState<Grants>(loaded);
  // what the server holds, as far as this page knows: it moves when a save succeeds, so "unsaved
  // changes" stops counting the ones that have just been written
  const [base, setBase] = useState<Grants>(loaded);
  const [openModule, setOpenModule] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const byModule = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of d.roles.permissions) { const l = m.get(p.module) ?? []; l.push(p.key); m.set(p.module, l); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [d.roles]);

  const held = (roleId: string, keys: string[]) => keys.filter(k => (grants[roleId] ?? []).includes(k));
  const cycle = (roleId: string, keys: string[]) => {
    const have = held(roleId, keys);
    const view = keys.filter(k => k.endsWith('.view'));
    const next = have.length === 0 ? view : have.length === view.length && view.every(v => have.includes(v)) ? keys : [];
    setGrants(g => ({ ...g, [roleId]: [...(g[roleId] ?? []).filter(k => !keys.includes(k)), ...next] }));
  };
  const toggle = (roleId: string, key: string) => setGrants(g => {
    const cur = g[roleId] ?? [];
    return { ...g, [roleId]: cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key] };
  });
  const dirty = d.roles.roles.filter(r => !r.locked && (grants[r.id] ?? []).slice().sort().join('|') !== (base[r.id] ?? []).slice().sort().join('|'));

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      for (const r of dirty) await api(`/api/roles/${r.id}/permissions`, { method: 'PUT', json: { permissions: grants[r.id] ?? [] } });
      setBase(grants);
      setMsg(tr('set.matrixLive'));
    } catch (e) { setErr((e as Error).message); }
    finally { setSaving(false); }
  };

  return <div className="mt-4">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('set.matrixNote')}</p>
      <Button size="sm" disabled={saving || !dirty.length || !d.canWrite} onClick={save}>{tr('set.saveMatrix')}{dirty.length ? ` (${dirty.length})` : ''}</Button>
    </div>
    <div className="card overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead><tr>
          <th className="p-2 text-left">{tr('set.module')}</th>
          {d.roles.roles.map(r => <th key={r.id} className="p-2 text-left">{r.name}<div className="num text-xs" style={{ color: 'var(--muted)' }}>{r.holders} {tr('set.holders')}</div></th>)}
        </tr></thead>
        <tbody>
          {byModule.map(([mod, keys]) => <Fragment key={mod}>
            <tr style={{ borderTop: '1px solid var(--line)' }}>
              <td className="p-2"><button className="btn btn-ghost btn-sm px-0" onClick={() => setOpenModule(m => (m === mod ? null : mod))}>{openModule === mod ? '▾' : '▸'} {mod}</button></td>
              {d.roles.roles.map(r => {
                const have = held(r.id, keys);
                const all = r.locked || have.length === keys.length;
                const label = all ? tr('set.all') : have.length === 0 ? tr('set.none') : `${have.length}/${keys.length}`;
                return <td key={r.id} className="p-2">
                  <button className={`chip ${all ? 'chip-ok' : have.length ? 'chip-accent' : ''}`} title={r.locked ? tr('set.lockedRole') : ''} disabled={r.locked || !d.canWrite} onClick={() => cycle(r.id, keys)}>{label}</button>
                </td>;
              })}
            </tr>
            {openModule === mod && keys.map(k => <tr key={`${mod}:${k}`} style={{ background: 'var(--surface-2)' }}>
              <td className="num p-2 pl-6 text-xs">{k}</td>
              {d.roles.roles.map(r => <td key={r.id} className="p-2">
                <input type="checkbox" disabled={r.locked || !d.canWrite} checked={r.locked || (grants[r.id] ?? []).includes(k)} onChange={() => toggle(r.id, k)} />
              </td>)}
            </tr>)}
          </Fragment>)}
        </tbody>
      </table>
    </div>
    <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{tr('set.lockedRole')}</p>
  </div>;
}

// ------------------------------------------------------------------ Numbering
function NumberingTab({ d, tr, open, setTarget }: { d: D; tr: Tr; open: () => void; setTarget: (v: string | null) => void }) {
  return <div className="mt-4">
    <p className="mb-3 text-sm" style={{ color: 'var(--muted)' }}>{tr('set.numberingNote')}</p>
    <DataTable locale={d.locale} searchable={false} rows={d.sequences} columns={[
      { key: 'key', label: tr('set.sequence'), className: 'num' },
      { key: 'prefix', label: tr('set.prefix'), className: 'num', render: r => r.prefix || '—' },
      { key: 'padding', label: tr('set.padding'), className: 'num' },
      { key: 'resetYearly', label: tr('set.resetPolicy'), render: r => r.resetYearly ? <Chip status="active">{tr('set.yearly')}</Chip> : <Chip status="draft">{tr('set.neverReset')}</Chip> },
      { key: 'issued', label: tr('set.issued'), className: 'num' },
      { key: 'example', label: tr('set.example'), className: 'num' },
      { key: 'id', label: '', render: r => d.canWrite ? <Button size="sm" variant="secondary" onClick={() => { setTarget(r.id); open(); }}>{tr('common.save')}</Button> : null },
    ]} />
  </div>;
}

// ------------------------------------------------------------------ Audit
function AuditTab({ d, tr, when, setErr }: { d: D; tr: Tr; when: (v: unknown) => string; setErr: (v: string | null) => void }) {
  const [rows, setRows] = useState(d.audit.rows);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(d.audit.total);
  const [f, setF] = useState<{ action: string; entityType: string; from: string; to: string }>({ action: '', entityType: '', from: '', to: '' });

  const load = async (next: typeof f, p: number) => {
    setErr(null);
    try {
      const q = new URLSearchParams({ page: String(p), pageSize: '50' });
      for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
      const r = await api<typeof d.audit>(`/api/audit?${q}`);
      setRows(r.rows); setTotal(r.total); setPage(r.page);
    } catch (e) { setErr((e as Error).message); }
  };
  const change = (patch: Partial<typeof f>) => { const next = { ...f, ...patch }; setF(next); load(next, 0); };

  return <div className="mt-4">
    <p className="mb-3 text-sm" style={{ color: 'var(--muted)' }}>{tr('set.auditNote')}</p>
    <div className="mb-3 flex flex-wrap items-end gap-2">
      <Field label={tr('set.action')}><Select value={f.action} onChange={e => change({ action: e.target.value })} options={[{ value: '', label: tr('set.anyAction') }, ...d.audit.actions.map(a => ({ value: a, label: a }))]} /></Field>
      <Field label={tr('set.entity')}><Select value={f.entityType} onChange={e => change({ entityType: e.target.value })} options={[{ value: '', label: tr('set.anyEntity') }, ...d.audit.entityTypes.map(a => ({ value: a, label: a }))]} /></Field>
      <Field label={tr('set.from')}><Input type="date" value={f.from} onChange={e => change({ from: e.target.value })} /></Field>
      <Field label={tr('set.to')}><Input type="date" value={f.to} onChange={e => change({ to: e.target.value })} /></Field>
      <Button size="sm" variant="ghost" onClick={() => change({ action: '', entityType: '', from: '', to: '' })}>{tr('set.clearFilter')}</Button>
    </div>
    <DataTable locale={d.locale} searchable={false} rows={rows} pageSize={50} total={total} page={page} onPage={p => load(f, p)} columns={[
      { key: 'created_at', label: tr('set.when'), render: r => when(r.created_at) },
      { key: 'actor_name', label: tr('set.actor'), render: r => r.actor_name ?? tr('set.system') },
      { key: 'action', label: tr('set.action'), render: r => <span className="chip">{r.action}</span> },
      { key: 'entity_type', label: tr('set.entity'), render: r => <span className="num">{r.entity_type}</span> },
      { key: 'entity_id', label: 'ID', className: 'num', render: r => r.entity_id ?? '—' },
      { key: 'ip', label: tr('set.ip'), className: 'num', render: r => r.ip ?? '—' },
    ]} />
  </div>;
}
