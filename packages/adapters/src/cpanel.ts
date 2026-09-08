import type { Logger } from './interfaces.js';

/**
 * The hosting panel, behind an interface like everything else that is hosting-specific.
 *
 * A custom domain needs two things on shared hosting and only one of them is DNS. Apache will not
 * route an unknown hostname to our folder at all until the domain exists as an alias in the cPanel
 * account: the records can be perfect and the request still lands on the server's default page. So
 * where the vendor has issued an API token we make the alias ourselves the moment they paste the
 * domain, and where they have not, the caller is told exactly what to add by hand.
 *
 * `NoCPanel` is the honest answer on every other host — a VPS, Docker, a Kubernetes cluster — where
 * there is no panel and none is needed. It reports `configured: false` rather than pretending.
 *
 * The token never appears in a log line, an error message or a returned object: it is an account
 * credential for the whole hosting account, not for one school.
 */
export interface CPanelAdapter {
  readonly kind: 'cpanel' | 'none';
  /** Whether this installation actually has credentials for a panel. */
  readonly configured: boolean;
  /** Makes `domain` an alias of the account, so Apache routes it to our folder. */
  addAlias(domain: string): Promise<CPanelAliasResult>;
  /** Every domain the account already answers on: main, addons, parked and subdomains. */
  listAliases(): Promise<CPanelAliasList>;
}

export interface CPanelAliasResult {
  configured: boolean;
  created: boolean;
  /** The account already answered on this name; nothing was changed. */
  alreadyThere: boolean;
  error: string | null;
}
export interface CPanelAliasList { configured: boolean; domains: string[]; error: string | null }

export interface CPanelOptions { url: string; user: string; token: string; log?: Logger; timeoutMs?: number }

/** cPanel's UAPI over HTTPS, authenticated with an account API token. */
export class CPanelApi implements CPanelAdapter {
  readonly kind = 'cpanel' as const;
  readonly configured = true;
  private base: string;
  private timeoutMs: number;
  constructor(private opts: CPanelOptions) {
    this.base = opts.url.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async listAliases(): Promise<CPanelAliasList> {
    try {
      const data = await this.call<{ main_domain?: string; addon_domains?: string[]; parked_domains?: string[]; sub_domains?: string[] }>('DomainInfo', 'list_domains');
      const domains = [data.main_domain, ...(data.addon_domains ?? []), ...(data.parked_domains ?? []), ...(data.sub_domains ?? [])]
        .filter((d): d is string => !!d).map(d => d.toLowerCase());
      return { configured: true, domains: [...new Set(domains)], error: null };
    } catch (e) {
      return { configured: true, domains: [], error: this.clean(e) };
    }
  }

  async addAlias(domain: string): Promise<CPanelAliasResult> {
    const wanted = domain.toLowerCase().replace(/^www\./, '');
    const existing = await this.listAliases();
    if (existing.error) return { configured: true, created: false, alreadyThere: false, error: existing.error };
    if (existing.domains.some(d => d === wanted || d === `www.${wanted}`)) {
      return { configured: true, created: false, alreadyThere: true, error: null };
    }
    try {
      // Park is cPanel's "alias": the domain answers on the same document root, www included
      await this.call('Park', 'park', { domain: wanted });
      this.opts.log?.info(`cpanel: ${wanted} added as an alias`);
      return { configured: true, created: true, alreadyThere: false, error: null };
    } catch (e) {
      return { configured: true, created: false, alreadyThere: false, error: this.clean(e) };
    }
  }

  private async call<T>(module: string, fn: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.base}/execute/${module}/${fn}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Authorization: `cpanel ${this.opts.user}:${this.opts.token}`, accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`cPanel answered ${res.status}`);
      const body = await res.json() as { status?: number; errors?: string[] | null; data?: T };
      if (body.status !== 1) throw new Error(body.errors?.[0] ?? 'cPanel refused the request');
      return (body.data ?? {}) as T;
    } finally { clearTimeout(timer); }
  }

  /** Whatever comes back, it never carries the token — the URL never holds it and neither does this. */
  private clean(e: unknown): string {
    return String((e as Error)?.message ?? e).replace(this.opts.token, '***').slice(0, 300);
  }
}

/** No panel here. Every caller must cope with this answer, because most hosts are not cPanel. */
export class NoCPanel implements CPanelAdapter {
  readonly kind = 'none' as const;
  readonly configured = false;
  async addAlias(): Promise<CPanelAliasResult> { return { configured: false, created: false, alreadyThere: false, error: null }; }
  async listAliases(): Promise<CPanelAliasList> { return { configured: false, domains: [], error: null }; }
}

export function createCPanel(env: { CPANEL_URL?: string; CPANEL_USER?: string; CPANEL_API_TOKEN?: string }, log?: Logger): CPanelAdapter {
  if (env.CPANEL_URL && env.CPANEL_USER && env.CPANEL_API_TOKEN) {
    return new CPanelApi({ url: env.CPANEL_URL, user: env.CPANEL_USER, token: env.CPANEL_API_TOKEN, log });
  }
  return new NoCPanel();
}
