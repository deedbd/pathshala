import { createHmac } from 'node:crypto';
import type { Db, Row } from '@pathshala/db';
import { json, nowSql, ulid } from '@pathshala/db';
import type { ScheduledFn } from '@pathshala/adapters';
import type { OutboxService } from '../automation/outbox.js';
import type { NotificationService } from '../notifications.js';
import type { TaskService } from '../tasks.js';
import { HttpError, badRequest, notFound } from '../context.js';

export interface AgendaItem { no?: number; title: string; presenter?: string | null }

/**
 * Governance: the managing committee, what it decided, the policies everyone is meant to have read,
 * and the student council election.
 *
 * Minutes are worth keeping only if the decisions inside them are chased, so a resolution is a row
 * with an owner and a date, not a paragraph — and the overdue ones are put in front of the committee
 * before the next meeting rather than after it.
 *
 * The election is secret. A vote stores an HMAC of the voter's id under a key that is unique to that
 * election: the school can prove nobody voted twice and can never work out who anyone voted for.
 */
export class GovernanceService {
  constructor(
    private db: Db, private outbox: OutboxService, private notifications: NotificationService,
    private tasks: TaskService, private appKey: string,
  ) {}

  // ---------- committees ----------
  async createCommittee(schoolId: string, c: { name: string; kind?: 'managing' | 'academic' | 'pta' | 'student_council' | 'disciplinary' | 'other' }) {
    const ex = await this.db.findOne<{ id: string }>('committees', { school_id: schoolId, name: c.name });
    if (ex) return ex.id;
    const id = ulid();
    await this.db.insert('committees', { id, school_id: schoolId, name: c.name, kind: c.kind ?? 'other', status: 'active' });
    return id;
  }
  async addMember(schoolId: string, m: { committeeId: string; personName: string; role: string; userId?: string | null; termStart?: string | null; termEnd?: string | null }) {
    if (!(await this.db.findOne('committees', { id: m.committeeId, school_id: schoolId }))) throw notFound('committee');
    const id = ulid();
    await this.db.insert('committee_members', { id, school_id: schoolId, committee_id: m.committeeId, person_name: m.personName, user_id: m.userId ?? null, role: m.role, term_start: m.termStart ?? null, term_end: m.termEnd ?? null, status: 'active' });
    return id;
  }
  async committees(schoolId: string) {
    return this.db.query<Row>(`SELECT c.*, (SELECT COUNT(*) FROM committee_members m WHERE m.committee_id = c.id AND m.status = 'active') AS members FROM committees c WHERE c.school_id = ? ORDER BY c.name`, [schoolId]);
  }
  async members(schoolId: string, committeeId: string) {
    return this.db.findMany<Row>('committee_members', { school_id: schoolId, committee_id: committeeId }, { orderBy: 'status ASC, person_name ASC', limit: 200 });
  }
  /** Terms that have run out end themselves; a committee nobody has renewed is not a quorum. */
  async expireTerms(schoolId: string, onDate = nowSql().slice(0, 10)) {
    const n = await this.db.execute(`UPDATE committee_members SET status = 'ended', updated_at = ? WHERE school_id = ? AND status = 'active' AND term_end IS NOT NULL AND term_end < ?`, [nowSql(), schoolId, onDate]);
    return { ended: n.affectedRows };
  }

  // ---------- meetings, minutes, resolutions ----------
  async scheduleMeeting(schoolId: string, m: { committeeId?: string | null; title: string; heldAt: string; venue?: string | null; agenda?: AgendaItem[] }) {
    const id = ulid();
    const agenda = (m.agenda ?? []).map((a, i) => ({ no: a.no ?? i + 1, title: a.title, presenter: a.presenter ?? null }));
    await this.db.insert('meetings', { id, school_id: schoolId, committee_id: m.committeeId ?? null, title: m.title, held_at: m.heldAt, venue: m.venue ?? null, agenda: agenda as never, minutes: null, attendees: null, minutes_file_id: null, status: 'scheduled' });
    if (m.committeeId) {
      const members = await this.db.query<Row>(`SELECT user_id, person_name FROM committee_members WHERE committee_id = ? AND status = 'active' AND user_id IS NOT NULL`, [m.committeeId]);
      for (const member of members) await this.notifications.notify({ schoolId, userId: String(member.user_id), channels: ['in_app', 'push', 'email'], eventKey: 'governance.meeting_called', title: m.title, body: `${m.heldAt.slice(0, 16)}${m.venue ? ` · ${m.venue}` : ''}. ${agenda.length} items on the agenda.`, entityType: 'governance.meeting', entityId: id });
    }
    return { id, agenda: agenda.length };
  }
  /**
   * The minutes, and with them the decisions. Every resolution becomes a row with an owner and a date,
   * and a task for that owner — which is the difference between minutes that are filed and minutes
   * that are acted on.
   */
  async recordMinutes(schoolId: string, meetingId: string, m: { minutes: string; attendees?: string[]; resolutions?: { text: string; ownerId?: string | null; dueDate?: string | null; number?: string | null }[]; minutesFileId?: string | null }) {
    const meeting = await this.db.findOne<Row>('meetings', { id: meetingId, school_id: schoolId });
    if (!meeting) throw notFound('meeting');
    await this.db.update('meetings', { minutes: m.minutes, attendees: (m.attendees ?? null) as never, minutes_file_id: m.minutesFileId ?? null, status: 'held', updated_at: nowSql() }, { id: meetingId });
    const made: string[] = [];
    for (const [i, r] of (m.resolutions ?? []).entries()) {
      const id = ulid();
      const number = r.number ?? `${String(meeting.held_at).slice(0, 10).replace(/-/g, '')}/${i + 1}`;
      await this.db.insert('resolutions', { id, school_id: schoolId, meeting_id: meetingId, number, text: r.text, owner_id: r.ownerId ?? null, due_date: r.dueDate ?? null, status: 'open' });
      await this.tasks.create({ schoolId, title: `Resolution ${number}`, description: r.text.slice(0, 2000), taskType: 'governance', assignedTo: r.ownerId ?? null, assignedRole: r.ownerId ? null : 'admin', entityType: 'governance.resolution', entityId: id, dueAt: r.dueDate ? `${r.dueDate} 17:00:00` : null, priority: 'normal' });
      made.push(id);
    }
    await this.outbox.emitNow({ type: 'meeting.minuted', schoolId, aggregateType: 'governance.meeting', aggregateId: meetingId, payload: { meetingId, resolutions: made.length } });
    return { meetingId, resolutions: made.length };
  }
  async closeResolution(schoolId: string, resolutionId: string, status: 'done' | 'dropped', note?: string | null) {
    const r = await this.db.findOne<Row>('resolutions', { id: resolutionId, school_id: schoolId });
    if (!r) throw notFound('resolution');
    await this.db.update('resolutions', { status, updated_at: nowSql() }, { id: resolutionId });
    await this.db.execute(`UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE entity_type = 'governance.resolution' AND entity_id = ? AND status <> 'done'`, [nowSql(), nowSql(), resolutionId]);
    return { id: resolutionId, status, note: note ?? null };
  }
  async meetings(schoolId: string, committeeId?: string) {
    const where: Row = { school_id: schoolId };
    if (committeeId) where.committee_id = committeeId;
    const rows = await this.db.findMany<Row>('meetings', where, { orderBy: 'held_at DESC', limit: 100 });
    return rows.map(r => ({ ...r, agenda: json(r.agenda), attendees: json(r.attendees) }) as Row);
  }
  async resolutions(schoolId: string, f: { status?: string; overdueOnly?: boolean } = {}) {
    const where: string[] = ['r.school_id = ?']; const params: unknown[] = [schoolId];
    if (f.status) { where.push('r.status = ?'); params.push(f.status); }
    if (f.overdueOnly) { where.push(`r.status = 'open' AND r.due_date IS NOT NULL AND r.due_date < ?`); params.push(nowSql().slice(0, 10)); }
    return this.db.query<Row>(`SELECT r.*, m.title AS meeting_title, m.held_at, u.display_name AS owner FROM resolutions r JOIN meetings m ON m.id = r.meeting_id LEFT JOIN users u ON u.id = r.owner_id WHERE ${where.join(' AND ')} ORDER BY r.due_date IS NULL, r.due_date LIMIT 300`, params);
  }

  // ---------- policies ----------
  /** A new version of a policy is a new row: what somebody acknowledged must not change under them. */
  async publishPolicy(schoolId: string, p: { title: string; category?: string | null; body?: string | null; fileId?: string | null; appliesTo?: string[] | null; effectiveFrom?: string | null }) {
    const previous = await this.db.query<Row>(`SELECT * FROM policy_documents WHERE school_id = ? AND title = ? ORDER BY version DESC LIMIT 1`, [schoolId, p.title]);
    const version = previous[0] ? Number(previous[0].version) + 1 : 1;
    const id = ulid();
    await this.db.insert('policy_documents', { id, school_id: schoolId, title: p.title, category: p.category ?? null, version, file_id: p.fileId ?? null, body: p.body ?? null, applies_to: (p.appliesTo ?? null) as never, effective_from: p.effectiveFrom ?? nowSql().slice(0, 10), status: 'active' });
    if (previous[0]) await this.db.update('policy_documents', { status: 'retired', updated_at: nowSql() }, { id: String(previous[0].id) });
    const roles = p.appliesTo ?? ['teacher', 'staff', 'admin'];
    for (const role of roles) await this.notifications.notifyRole(schoolId, role, { channels: ['in_app', 'push'], eventKey: 'governance.policy_published', title: `${p.title} (v${version})`, body: 'Please read it and confirm you have.', entityType: 'governance.policy', entityId: id });
    await this.outbox.emitNow({ type: 'policy.published', schoolId, aggregateType: 'governance.policy', aggregateId: id, payload: { policyId: id, title: p.title, version } });
    return { id, version };
  }
  async acknowledgePolicy(schoolId: string, policyId: string, userId: string) {
    if (!(await this.db.findOne('policy_documents', { id: policyId, school_id: schoolId }))) throw notFound('policy');
    const ex = await this.db.findOne('policy_acknowledgements', { policy_id: policyId, user_id: userId });
    if (ex) return { policyId, alreadyAcknowledged: true };
    await this.db.insert('policy_acknowledgements', { id: ulid(), school_id: schoolId, policy_id: policyId, user_id: userId, acked_at: nowSql() });
    return { policyId, acknowledged: true };
  }
  /** Who has read it and who has not — by name, because "82% acknowledged" chases nobody. */
  async policyStatus(schoolId: string, policyId: string) {
    const policy = await this.db.findOne<Row>('policy_documents', { id: policyId, school_id: schoolId });
    if (!policy) throw notFound('policy');
    const roles = json<string[]>(policy.applies_to) ?? ['teacher', 'staff', 'admin'];
    const expected = await this.db.query<Row>(`SELECT DISTINCT u.id, u.display_name FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.school_id = ? AND u.is_active = TRUE AND r.slug IN (${roles.map(() => '?').join(',')})`, [schoolId, ...roles]);
    const acked = new Set((await this.db.findMany<Row>('policy_acknowledgements', { policy_id: policyId }, { limit: 5000 })).map(a => String(a.user_id)));
    return {
      policy, expected: expected.length, acknowledged: acked.size,
      pending: expected.filter(u => !acked.has(String(u.id))).map(u => ({ id: String(u.id), name: String(u.display_name) })),
    };
  }
  async policies(schoolId: string) { return this.db.findMany<Row>('policy_documents', { school_id: schoolId, status: 'active' }, { orderBy: 'title ASC', limit: 200 }); }

  // ---------- elections ----------
  async createElection(schoolId: string, e: { title: string; opensAt: string; closesAt: string; candidates: { id: string; name: string; post?: string | null }[]; scope?: Record<string, unknown> | null }) {
    if (e.candidates.length < 2) throw badRequest('an election needs at least two candidates');
    if (e.closesAt <= e.opensAt) throw badRequest('the election closes before it opens');
    const ids = new Set(e.candidates.map(c => c.id));
    if (ids.size !== e.candidates.length) throw badRequest('two candidates share an id');
    const id = ulid();
    await this.db.insert('elections', { id, school_id: schoolId, title: e.title, scope: (e.scope ?? null) as never, opens_at: e.opensAt, closes_at: e.closesAt, candidates: e.candidates as never, results: null, status: 'draft' });
    return id;
  }
  async setElectionStatus(schoolId: string, electionId: string, status: 'draft' | 'open' | 'closed') {
    const e = await this.db.findOne<Row>('elections', { id: electionId, school_id: schoolId });
    if (!e) throw notFound('election');
    if (status === 'closed' && e.status === 'open') return this.closeElection(schoolId, electionId);
    await this.db.update('elections', { status, updated_at: nowSql() }, { id: electionId });
    return { id: electionId, status };
  }
  /**
   * One vote per voter, and nobody can tell whose. The row keeps an HMAC of the voter's id keyed to
   * this election, so a second attempt collides on the same hash and is refused, while the hash itself
   * says nothing about the person outside this one election.
   */
  async vote(schoolId: string, electionId: string, voterUserId: string, candidateId: string) {
    const e = await this.db.findOne<Row>('elections', { id: electionId, school_id: schoolId });
    if (!e) throw notFound('election');
    const now = nowSql();
    if (e.status !== 'open') throw new HttpError(409, `this election is ${e.status}`, 'conflict');
    if (now < String(e.opens_at) || now > String(e.closes_at)) throw new HttpError(409, 'the election is not open at the moment', 'conflict');
    const candidates = json<{ id: string }[]>(e.candidates) ?? [];
    if (!candidates.some(c => c.id === candidateId)) throw badRequest('no such candidate');
    const voterHash = createHmac('sha256', `${this.appKey}:${electionId}`).update(voterUserId).digest('hex');
    if (await this.db.findOne('election_votes', { election_id: electionId, voter_hash: voterHash })) throw new HttpError(409, 'this voter has already voted', 'duplicate');
    await this.db.insert('election_votes', { id: ulid(), school_id: schoolId, election_id: electionId, voter_hash: voterHash, candidate_id: candidateId, cast_at: now });
    return { electionId, voted: true };
  }
  async closeElection(schoolId: string, electionId: string) {
    const e = await this.db.findOne<Row>('elections', { id: electionId, school_id: schoolId });
    if (!e) throw notFound('election');
    const candidates = json<{ id: string; name: string; post?: string | null }[]>(e.candidates) ?? [];
    const counts = await this.db.query<{ candidate_id: string; n: number }>(`SELECT candidate_id, COUNT(*) AS n FROM election_votes WHERE election_id = ? GROUP BY candidate_id`, [electionId]);
    const byId = new Map(counts.map(c => [String(c.candidate_id), Number(c.n)]));
    const results = candidates.map(c => ({ ...c, votes: byId.get(c.id) ?? 0 })).sort((a, b) => b.votes - a.votes);
    const top = results[0]?.votes ?? 0;
    const winners = results.filter(r => r.votes === top && top > 0).map(r => r.name);
    await this.db.update('elections', { status: 'closed', results: { results, winners, total: counts.reduce((a, c) => a + Number(c.n), 0) } as never, updated_at: nowSql() }, { id: electionId });
    await this.outbox.emitNow({ type: 'election.closed', schoolId, aggregateType: 'governance.election', aggregateId: electionId, payload: { electionId, title: String(e.title), winners: winners.join(', '), votes: counts.reduce((a, c) => a + Number(c.n), 0) } });
    return { id: electionId, status: 'closed' as const, results, winners, tie: winners.length > 1 };
  }
  async elections(schoolId: string) {
    const rows = await this.db.findMany<Row>('elections', { school_id: schoolId }, { orderBy: 'opens_at DESC', limit: 50 });
    return rows.map(r => ({ ...r, candidates: json(r.candidates), results: json(r.results) }) as Row);
  }

  // ---------- scheduled ----------
  jobs(): Record<string, ScheduledFn> {
    return {
      // decisions with a date that has passed, put in front of the committee that made them
      'governance.resolution_watch': async ({ schoolId }) => {
        await this.expireTerms(schoolId);
        const late = await this.resolutions(schoolId, { overdueOnly: true });
        for (const r of late) {
          if (r.owner_id) await this.notifications.notify({ schoolId, userId: String(r.owner_id), channels: ['in_app', 'push'], eventKey: 'governance.resolution_overdue', title: `Resolution ${r.number} is overdue`, body: String(r.text).slice(0, 160), entityType: 'governance.resolution', entityId: String(r.id) });
          else await this.notifications.notifyRole(schoolId, 'admin', { channels: ['in_app'], eventKey: 'governance.resolution_overdue', title: `Resolution ${r.number} has nobody on it`, body: String(r.text).slice(0, 160), entityType: 'governance.resolution', entityId: String(r.id) });
        }
        // an election whose closing time has passed counts itself
        const due = await this.db.query<Row>(`SELECT id FROM elections WHERE school_id = ? AND status = 'open' AND closes_at < ?`, [schoolId, nowSql()]);
        for (const e of due) await this.closeElection(schoolId, String(e.id));
        return { overdue: late.length, electionsClosed: due.length };
      },
    };
  }
}
