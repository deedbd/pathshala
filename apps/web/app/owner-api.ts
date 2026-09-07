import type { AppLoadContext } from 'react-router';

/**
 * The vendor console's view of the owner service (`packages/core/src/modules/owner.ts`, served at
 * `/api/owner`).
 *
 * It is declared here rather than imported from `@pathshala/core` because the owner module ships
 * beside this console: the pages are typed against the agreed shape, and a build that does not yet
 * carry the service still compiles — `ownerApi` refuses at runtime and the layout renders the same
 * plain refusal it renders for a 403. Where the contract does not say what a field holds, the type
 * is deliberately loose and the page renders what is there.
 */
export type Row = Record<string, unknown>;

export interface OwnerOverview {
  schools: { total: number; active: number; trial: number; pastDue: number; suspended: number };
  students: number;
  staff: number;
  mrr: number;
  currency: string;
  invoicesOutstanding: number;
  ticketsOpen: number;
  health: { failedJobs: number; staleBackups: number; stuckEvents: number };
}

export interface OwnerSchoolRow {
  id: string;
  name: string;
  code: string;
  institutionType: string;
  locale: string;
  currency: string;
  status: string;
  createdAt: string;
  students: number;
  staff: number;
  plan: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: string | null;
  lastActivityAt: string | null;
  lastBackupAt: string | null;
  outstanding: number;
}
export interface OwnerSchoolsPage { rows: OwnerSchoolRow[]; total: number; limit: number; offset: number }

export interface OwnerSchoolDetail {
  school: Row | null;
  subscription: Row | null;
  usage: Row;
  invoices: Row[];
  admins: Row[];
  health: Row | Row[] | null;
  counts: Row;
}

/** Dunning buckets are either a list of rows or an age → figure map; both are rendered. */
export type OwnerBuckets = Row[] | Record<string, number | Row> | null;
export interface OwnerBilling { invoices: Row[]; buckets: OwnerBuckets; partners: Row[]; payouts: Row[] }

/** The watchdog's findings, per school. Shape is not fixed by the contract, so all of these are read. */
export interface OwnerHealthReport {
  rows?: Row[];
  schools?: Row[];
  findings?: Row[];
  failedJobs?: Row[];
  staleBackups?: Row[];
  stuckEvents?: Row[];
  checkedAt?: string;
}

export interface OwnerListFilter { q?: string; status?: string; planId?: string; schoolId?: string; limit?: number; offset?: number }

export interface OwnerApi {
  overview(): Promise<OwnerOverview>;
  schools(filter?: OwnerListFilter): Promise<OwnerSchoolsPage>;
  school(id: string): Promise<OwnerSchoolDetail>;
  billing(filter?: OwnerListFilter): Promise<OwnerBilling>;
  tickets(filter?: OwnerListFilter): Promise<Row[] | { rows: Row[]; total?: number }>;
  health(): Promise<OwnerHealthReport | Row[]>;
  /** Mutations are called over `/api/owner/*` from the browser, never from a loader. */
  provision(input: Row): Promise<{ schoolId: string; code: string; adminEmail: string; password: string; url: string }>;
  setStatus(id: string, status: string, reason: string): Promise<unknown>;
  setPlan(id: string, input: Row): Promise<unknown>;
  addAdmin(id: string, input: Row): Promise<{ email: string; password: string }>;
}

/** The owner service, or a refusal `ownerLoad` turns into the "not for you" page. */
export function ownerApi(context: AppLoadContext): OwnerApi {
  const owner = (context.app as unknown as { owner?: OwnerApi }).owner;
  if (!owner) throw Object.assign(new Error('the owner console is not installed on this server'), { status: 501 });
  return owner;
}

/** Whether the owner service refused this caller (or is absent), rather than failing at its work. */
export function isRefusal(e: unknown): boolean {
  const status = (e as { status?: unknown } | null | undefined)?.status;
  return status === 401 || status === 403 || status === 501;
}

/**
 * Runs one owner call. A refusal comes back as `null` so the page can say plainly whose console
 * this is; anything else is a real fault and is thrown on to the error boundary.
 */
export async function ownerLoad<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch (e) { if (isRefusal(e)) return null; throw e; }
}

/** Endpoints that answer either a bare list or a paged one. */
export function listOf<T>(x: T[] | { rows: T[] } | null | undefined): T[] {
  return Array.isArray(x) ? x : (x?.rows ?? []);
}
export function num(v: unknown): number { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; }
export function str(v: unknown): string { return v == null ? '' : String(v); }
