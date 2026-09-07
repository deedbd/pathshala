import { useState } from 'react';
import { useLoaderData, useRevalidator, useSearchParams } from 'react-router';
import type { Route } from './+types/admissions';
import { Banner, Button, Chip, DataTable, Drawer, Field, Input, Kpi, Select, Tabs, api, formatDate, formatMoney, t, type Locale } from '@pathshala/ui';
import { requireUser } from '~/lib';

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context, request); const sid = user.school_id; const url = new URL(request.url);
  const campaigns = await context.app.admissions.campaigns(sid);
  const campaignId = url.searchParams.get('campaignId') ?? (campaigns[0] ? String(campaigns[0].id) : null);
  const [campaign, applications, enquiries, offers, tests, classes, requests, printJobs] = await Promise.all([
    campaignId ? context.app.admissions.campaign(sid, campaignId).catch(() => null) : null,
    campaignId ? context.app.admissions.applications(sid, { campaignId }) : [],
    context.app.admissions.enquiries(sid),
    campaignId ? context.app.admissions.offers(sid, campaignId) : [],
    campaignId ? context.app.admissions.tests(sid, campaignId) : [],
    context.app.academic.classes(sid),
    context.app.documents.requests(sid),
    context.app.documents.printJobs(sid),
  ]);
  return { locale: (user.locale as Locale) || context.locale, campaigns, campaignId, campaign, applications, enquiries, offers, tests, classes, requests, printJobs };
}
export function meta() { return [{ title: 'Pathshala — Admissions' }]; }

export default function Admissions() {
  const d = useLoaderData<typeof loader>(); const rv = useRevalidator(); const [sp, setSp] = useSearchParams();
  const tr = (k: Parameters<typeof t>[0]) => t(k, d.locale);
  const [tab, setTab] = useState<'applications' | 'enquiries' | 'offers' | 'documents'>('applications');
  const [drawer, setDrawer] = useState<null | 'campaign' | 'test' | 'document' | 'cards' | 'slots' | 'papers'>(null);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [papers, setPapers] = useState<{ id: string; missing: string[]; unverified: string[]; uploaded: { id: string; doc_type: string; file_id: string; verified_at: string | null }[] } | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); setDrawer(null); rv.revalidate(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set(k, v); setSp(n); };
  // run() closes whatever drawer is open when it finishes, so the papers drawer opens on its own
  const openPapers = async (applicationId: string) => {
    setErr(null);
    try { setPapers({ ...(await api(`/api/admissions/applications/${applicationId}/documents`)), id: applicationId }); setDrawer('papers'); }
    catch (e) { setErr((e as Error).message); }
  };
  const c = d.campaign;
  const money = (n: unknown) => formatMoney(Number(n ?? 0), d.locale);
  const counts = (status: string) => d.applications.filter(a => String(a.status) === status).length;
  // the merit sheet is per class; default to the class this campaign has the most applicants in
  const classOf = [...d.applications.reduce((m, a) => m.set(String(a.class_id), (m.get(String(a.class_id)) ?? 0) + 1), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl">{tr('adm.title')}</h1><p className="text-sm" style={{ color: 'var(--muted)' }}>{tr('adm.purpose')}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {d.campaigns.length > 0 && <Select value={d.campaignId ?? ''} onChange={e => setParam('campaignId', e.target.value)} options={d.campaigns.map(x => ({ value: String(x.id), label: `${x.name} (${x.status})` }))} className="max-w-[240px]" />}
          <Button size="sm" onClick={() => setDrawer('campaign')}>{tr('adm.newCampaign')}</Button>
        </div>
      </div>

      {c && <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label={tr('adm.applications')} value={d.applications.length} locale={d.locale} />
        <Kpi label={tr('adm.shortlisted')} value={counts('shortlisted') + counts('offered') + counts('enrolled')} locale={d.locale} />
        <Kpi label={tr('adm.waitlisted')} value={counts('waitlisted')} locale={d.locale} />
        <Kpi label={tr('adm.enrolled')} value={counts('enrolled')} locale={d.locale} />
        <div className="kpi"><div className="kpi-label">{tr('common.status')}</div><div className="mt-1"><Chip status={String(c.status) === 'open' ? 'active' : String(c.status)}>{String(c.status)}</Chip></div>
          <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>/{`admission/${c.public_form_slug}`}</div></div>
      </div>}
      {err && <div className="mt-4"><Banner kind="bad">{err}</Banner></div>}
      {msg && <div className="mt-4"><Banner kind="ok">{msg}</Banner></div>}

      {c && <div className="mt-4 flex flex-wrap gap-2">
        {String(c.status) !== 'open' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { await api(`/api/admissions/campaigns/${c.id}`, { method: 'PATCH', json: { status: 'open' } }); setMsg(tr('adm.opened')); })}>{tr('adm.open')}</Button>}
        {String(c.status) === 'open' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { await api(`/api/admissions/campaigns/${c.id}`, { method: 'PATCH', json: { status: 'closed' } }); setMsg(tr('adm.closed')); })}>{tr('adm.close')}</Button>}
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDrawer('test')}>{tr('adm.newTest')}</Button>
        <Button size="sm" disabled={busy} onClick={() => run(async () => { await api(`/api/admissions/campaigns/${c.id}/merit`, { method: 'POST', json: {} }); setMsg(tr('adm.meritQueued')); })}>{tr('adm.merit')}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(async () => { const r = await api<{ offers: number }>(`/api/admissions/campaigns/${c.id}/offers`, { method: 'POST', json: {} }); setMsg(`${r.offers} ${tr('adm.offers').toLowerCase()}`); })}>{tr('adm.makeOffers')}</Button>
        <Button size="sm" variant="secondary" disabled={busy || !classOf} onClick={() => run(async () => {
          const r = await api<{ fileId: string; ranked: number; seats: number }>(`/api/admissions/campaigns/${c.id}/merit/pdf?classId=${classOf}`, { method: 'POST', json: {} });
          setMsg(`${r.ranked} ranked for ${r.seats} seats`);
          const u = await api<{ url: string }>(`/api/files/${r.fileId}/url`); window.open(u.url, '_blank');
        })}>{tr('adm.meritPdf')}</Button>
        {d.tests.length > 0 && <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDrawer('slots')}>{tr('adm.makeSlots')}</Button>}
      </div>}

      <div className="mt-6"><Tabs value={tab} onChange={setTab} tabs={[
        { key: 'applications', label: tr('adm.applications'), count: d.applications.length },
        { key: 'enquiries', label: tr('adm.enquiries'), count: d.enquiries.length },
        { key: 'offers', label: tr('adm.offers'), count: d.offers.length },
        { key: 'documents', label: tr('doc.title'), count: d.requests.length },
      ]} /></div>

      {tab === 'applications' && <div className="mt-4"><DataTable locale={d.locale} rows={d.applications} columns={[
        { key: 'merit_rank', label: tr('adm.rank'), className: 'num', render: r => r.merit_rank == null ? '—' : String(r.merit_rank) },
        { key: 'application_no', label: tr('adm.applicationNo'), className: 'num' },
        { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
        { key: 'class_name', label: tr('common.class') },
        { key: 'guardian_phone', label: tr('common.phone'), className: 'num' },
        { key: 'test_score', label: tr('adm.score'), className: 'num', render: r => r.test_score == null ? '—' : String(Number(r.test_score)) },
        { key: 'status', label: tr('common.status'), render: r => <Chip status={statusChip(String(r.status))}>{String(r.status)}</Chip> },
        { key: 'id', label: '', render: r => <div className="flex gap-1">
          <Button size="sm" variant="secondary" onClick={() => openPapers(String(r.id))}>{tr('adm.docs')}</Button>
          {String(r.status) === 'offered' && <Button size="sm" onClick={() => run(async () => { const e = await api<{ admissionNo: string }>(`/api/admissions/applications/${r.id}/enrol`, { method: 'POST', json: {} }); setMsg(`${tr('adm.enrolled')}: ${e.admissionNo}`); })}>{tr('adm.enrol')}</Button>}
        </div> },
      ]} /></div>}

      {tab === 'enquiries' && <div className="mt-4"><DataTable locale={d.locale} rows={d.enquiries} columns={[
        { key: 'student_name', label: tr('adm.student') },
        { key: 'guardian_name', label: tr('adm.guardian') },
        { key: 'phone', label: tr('common.phone'), className: 'num' },
        { key: 'source', label: tr('adm.source') },
        { key: 'next_follow_up_at', label: tr('adm.followUp'), render: r => r.next_follow_up_at ? formatDate(String(r.next_follow_up_at).slice(0, 10), d.locale) : '—' },
        { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'converted' ? 'active' : String(r.status) === 'lost' ? 'failed' : 'pending'}>{String(r.status)}</Chip> },
        { key: 'id', label: '', render: r => String(r.status) === 'converted' || String(r.status) === 'lost' ? null : <Button size="sm" variant="secondary" onClick={() => run(async () => { await api(`/api/admissions/enquiries/${r.id}/followups`, { method: 'POST', json: { note: 'Called the guardian.', channel: 'call', status: 'contacted', nextAt: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 19).replace('T', ' ') } }); setMsg(tr('adm.followUpLogged')); })}>{tr('adm.logCall')}</Button> },
      ]} /></div>}

      {tab === 'offers' && <div className="mt-4"><DataTable locale={d.locale} rows={d.offers} columns={[
        { key: 'application_no', label: tr('adm.applicationNo'), className: 'num' },
        { key: 'first_name', label: tr('common.name'), render: r => `${r.first_name} ${r.last_name ?? ''}` },
        { key: 'expires_at', label: tr('adm.expires'), render: r => formatDate(String(r.expires_at).slice(0, 10), d.locale) },
        { key: 'accepted_at', label: tr('common.status'), render: r => <Chip status={r.accepted_at ? 'active' : r.revoked_at || r.declined_at ? 'failed' : 'pending'}>{r.accepted_at ? tr('adm.accepted') : r.revoked_at ? tr('adm.revoked') : r.declined_at ? tr('adm.declined') : tr('adm.waiting')}</Chip> },
        { key: 'offer_letter_file_id', label: tr('adm.letter'), render: r => r.offer_letter_file_id ? <Button size="sm" variant="secondary" onClick={async () => { const u = await api<{ url: string }>(`/api/files/${r.offer_letter_file_id}/url`); window.open(u.url, '_blank'); }}>PDF</Button> : null },
      ]} /></div>}

      {tab === 'documents' && <div className="mt-4">
        <div className="mb-3 flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDrawer('cards')}>{tr('doc.idCards')}</Button>
          <Button size="sm" onClick={() => setDrawer('document')}>{tr('doc.request')}</Button>
        </div>
        <DataTable locale={d.locale} rows={d.requests} columns={[
          { key: 'doc_type', label: tr('doc.type') },
          { key: 'person_type', label: tr('doc.for') },
          { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'issued' ? 'active' : String(r.status) === 'blocked' ? 'failed' : 'pending'}>{String(r.status)}</Chip> },
          { key: 'eligibility', label: tr('doc.blockers'), render: r => { const e = typeof r.eligibility === 'string' ? JSON.parse(r.eligibility) : r.eligibility; return (e?.blockers ?? []).map((b: { detail: string }) => b.detail).join('; ') || '—'; } },
          { key: 'id', label: '', render: r => String(r.status) === 'issued' ? null : <Button size="sm" disabled={String(r.status) === 'blocked'} onClick={() => run(async () => { const i = await api<{ documentNo: string }>(`/api/documents/requests/${r.id}/issue`, { method: 'POST', json: {} }); setMsg(`${tr('doc.issued')}: ${i.documentNo}`); })}>{tr('doc.issue')}</Button> },
        ]} />
        {d.printJobs.length > 0 && <>
          <h2 className="mt-6 text-lg">{tr('doc.printJobs')}</h2>
          <DataTable locale={d.locale} rows={d.printJobs} columns={[
            { key: 'kind', label: tr('doc.type') },
            { key: 'status', label: tr('common.status'), render: r => <Chip status={String(r.status) === 'ready' ? 'active' : 'pending'}>{String(r.status)}</Chip> },
            { key: 'file_id', label: '', render: r => r.file_id ? <Button size="sm" variant="secondary" onClick={async () => { const u = await api<{ url: string }>(`/api/files/${r.file_id}/url`); window.open(u.url, '_blank'); }}>PDF</Button> : null },
          ]} />
        </>}
      </div>}

      <Drawer open={drawer === 'slots'} onClose={() => setDrawer(null)} title={tr('adm.makeSlots')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { const r = await api<{ slots: number }>(`/api/admissions/tests/${f.testId}/interviews`, { method: 'POST', json: { from: `${f.date} ${f.time}:00`, minutes: Number(f.minutes), count: Number(f.count), venue: f.venue || null } }); setMsg(`${r.slots} slots`); }); }}>
          <Field label={tr('adm.tests')}><Select name="testId" required placeholder="—" options={d.tests.map(t2 => ({ value: String(t2.id), label: String(t2.name) }))} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.date')}><Input name="date" type="date" required /></Field><Field label="Start"><Input name="time" type="time" defaultValue="09:00" required /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label="Minutes each"><Input name="minutes" type="number" defaultValue={15} min={5} max={120} className="num" /></Field><Field label="How many"><Input name="count" type="number" defaultValue={20} min={1} max={400} className="num" /></Field></div>
          <Field label="Venue"><Input name="venue" placeholder="Principal's office" /></Field>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>One applicant to a slot. Each guardian is sent their own time when the applicant is put in one.</p>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
      <Drawer open={drawer === 'papers'} onClose={() => { setDrawer(null); setPapers(null); }} title={tr('adm.docs')}>
        {papers && <div className="grid gap-3">
          {papers.missing.length > 0 && <Banner kind="warn">{tr('adm.missing')}: {papers.missing.join(', ')}</Banner>}
          <table className="table"><thead><tr><th>{tr('common.type')}</th><th>{tr('common.status')}</th><th /></tr></thead><tbody>
            {papers.uploaded.map(u => <tr key={u.id}>
              <td>{String(u.doc_type)}</td>
              <td><Chip status={u.verified_at ? 'active' : 'pending'}>{u.verified_at ? tr('adm.verified') : tr('adm.unverified')}</Chip></td>
              <td className="flex gap-1">
                <Button size="sm" variant="secondary" onClick={async () => { const url = await api<{ url: string }>(`/api/files/${u.file_id}/url`); window.open(url.url, '_blank'); }}>{tr('common.download')}</Button>
                {!u.verified_at && <Button size="sm" onClick={async () => { await api(`/api/admissions/documents/${u.id}/verify`, { method: 'POST', json: {} }); await openPapers(papers.id); }}>{tr('adm.verify')}</Button>}
              </td>
            </tr>)}
          </tbody></table>
          <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>{tr('adm.upload')}
            <input type="file" className="hidden" onChange={async e => { const f = e.target.files?.[0]; if (!f) return; const docType = prompt(tr('adm.docTypeAsk'), papers.missing[0] ?? 'other'); e.currentTarget.value = ''; if (!docType) return; const b64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); }); try { await api(`/api/admissions/applications/${papers.id}/documents`, { method: 'POST', json: { docType, fileName: f.name, mimeType: f.type || undefined, base64: b64 } }); await openPapers(papers.id); } catch (ex) { setErr((ex as Error).message); } }} /></label>
        </div>}
      </Drawer>
      <Drawer open={drawer === 'campaign'} onClose={() => setDrawer(null)} title={tr('adm.newCampaign')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/admissions/campaigns', { method: 'POST', json: { name: f.name, opensAt: `${f.opensAt} 00:00:00`, closesAt: `${f.closesAt} 23:59:59`, formFee: Number(f.formFee || 0), selectionMode: f.selectionMode, offerValidityDays: Number(f.offerValidityDays || 7), classes: f.classId ? [{ classId: f.classId, seats: Number(f.seats || 40) }] : [] } })); }}>
          <Field label={tr('common.name')}><Input name="name" required placeholder="Admission 2027" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('adm.opens')}><Input name="opensAt" type="date" required /></Field><Field label={tr('adm.closes')}><Input name="closesAt" type="date" required /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('adm.formFee')}><Input name="formFee" type="number" className="num" defaultValue="0" /></Field><Field label={tr('adm.selection')}><Select name="selectionMode" options={[{ value: 'test', label: 'Test' }, { value: 'lottery', label: 'Lottery' }, { value: 'first_come', label: 'First come' }, { value: 'interview', label: 'Interview' }]} /></Field></div>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.class')}><Select name="classId" options={d.classes.map(x => ({ value: String(x.id), label: String(x.name) }))} /></Field><Field label={tr('adm.seats')}><Input name="seats" type="number" className="num" defaultValue="40" /></Field></div>
          <Field label={tr('adm.offerValidity')}><Input name="offerValidityDays" type="number" className="num" defaultValue="7" /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'test'} onClose={() => setDrawer(null)} title={tr('adm.newTest')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(() => api('/api/admissions/tests', { method: 'POST', json: { campaignId: d.campaignId, classId: f.classId, name: f.name, heldAt: `${f.heldAt} 10:00:00`, venue: f.venue, totalMarks: Number(f.totalMarks || 100) } })); }}>
          <Field label={tr('common.name')}><Input name="name" required placeholder="Admission test" /></Field>
          <Field label={tr('common.class')}><Select name="classId" required options={(d.campaign?.classes ?? []).map(x => ({ value: String(x.class_id), label: String(x.class_name) }))} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('common.date')}><Input name="heldAt" type="date" required /></Field><Field label={tr('ex.fullMarks')}><Input name="totalMarks" type="number" className="num" defaultValue="100" /></Field></div>
          <Field label={tr('adm.venue')}><Input name="venue" placeholder="Main hall" /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'document'} onClose={() => setDrawer(null)} title={tr('doc.request')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { const r = await api<{ status: string; blockers: { detail: string }[] }>('/api/documents/requests', { method: 'POST', json: { docType: f.docType, personType: 'student', studentId: f.studentId, reason: f.reason } }); setMsg(r.status === 'blocked' ? `${tr('doc.blocked')}: ${r.blockers.map(b => b.detail).join('; ')}` : tr('doc.requested')); }); }}>
          <Field label={tr('doc.type')}><Select name="docType" options={[{ value: 'tc', label: 'Transfer certificate' }, { value: 'testimonial', label: 'Testimonial' }, { value: 'character', label: 'Character certificate' }, { value: 'bonafide', label: 'Bonafide certificate' }]} /></Field>
          <Field label={tr('doc.studentId')} hint={tr('doc.studentIdHint')}><Input name="studentId" required /></Field>
          <Field label={tr('doc.reason')}><Input name="reason" /></Field>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>

      <Drawer open={drawer === 'cards'} onClose={() => setDrawer(null)} title={tr('doc.idCards')}>
        <form className="grid gap-3" onSubmit={e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; run(async () => { const r = await api<{ cards: number }>('/api/documents/id-cards', { method: 'POST', json: { personType: f.personType, validFrom: f.validFrom, validTo: f.validTo } }); setMsg(`${r.cards} ${tr('doc.idCards').toLowerCase()}`); }); }}>
          <Field label={tr('doc.for')}><Select name="personType" options={[{ value: 'student', label: 'Students' }, { value: 'staff', label: 'Staff' }]} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label={tr('doc.validFrom')}><Input name="validFrom" type="date" required /></Field><Field label={tr('doc.validTo')}><Input name="validTo" type="date" required /></Field></div>
          <Button disabled={busy}>{tr('common.save')}</Button>
        </form>
      </Drawer>
    </div>
  );
}

const statusChip = (s: string) => (s === 'enrolled' ? 'active' : s === 'rejected' || s === 'withdrawn' ? 'failed' : s === 'waitlisted' ? 'pending' : s);
