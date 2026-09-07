import type { Logger } from './interfaces.js';

export interface WhatsAppMessage { to: string; text: string; templateName?: string | null; variables?: string[] }
export interface VoiceCall { to: string; text: string; locale?: 'bn' | 'en'; audioUrl?: string | null }

export interface WhatsAppAdapter {
  readonly kind: string;
  send(m: WhatsAppMessage): Promise<{ providerMsgId?: string; cost?: number }>;
}
export interface VoiceAdapter {
  readonly kind: string;
  /** Places one call that reads `text` out (or plays `audioUrl`). Returns the provider's call id. */
  call(c: VoiceCall): Promise<{ providerCallId?: string; cost?: number }>;
}

/** Default until a school connects a provider: log only, so nothing silently fails to reach anyone. */
export class LogWhatsApp implements WhatsAppAdapter {
  readonly kind = 'log';
  sent: WhatsAppMessage[] = [];
  constructor(private log?: Logger) {}
  async send(m: WhatsAppMessage) { this.sent.push(m); this.log?.info(`[whatsapp→${m.to}] ${m.text}`); return { providerMsgId: `log-${Date.now()}`, cost: 0 }; }
}
export class LogVoice implements VoiceAdapter {
  readonly kind = 'log';
  placed: VoiceCall[] = [];
  constructor(private log?: Logger) {}
  async call(c: VoiceCall) { this.placed.push(c); this.log?.info(`[voice→${c.to}] ${c.text}`); return { providerCallId: `log-${Date.now()}`, cost: 0 }; }
}

export interface HttpWhatsAppOptions {
  /** Meta Cloud API: https://graph.facebook.com/v21.0/<phone-number-id>/messages */
  url: string;
  token: string;
  /** A template is required outside the 24-hour window; free text only works inside it. */
  defaultTemplate?: string | null;
  languageCode?: string;
  costPerMessage?: number;
}

/**
 * WhatsApp through the Meta Cloud API, which is what a Bangladeshi school can actually get.
 *
 * Outside the 24-hour service window Meta only delivers a pre-approved template, so a message with a
 * template name is sent as one and plain text is sent only when the school has said the conversation
 * is already open. Anything else would be accepted by the API and quietly delivered to nobody.
 */
export class MetaWhatsApp implements WhatsAppAdapter {
  readonly kind = 'meta';
  constructor(private o: HttpWhatsAppOptions) {}
  async send(m: WhatsAppMessage) {
    const to = m.to.replace(/[^\d]/g, '');
    const template = m.templateName ?? this.o.defaultTemplate ?? null;
    const payload = template
      ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: template, language: { code: this.o.languageCode ?? 'bn' }, components: m.variables?.length ? [{ type: 'body', parameters: m.variables.map(v => ({ type: 'text', text: v })) }] : [] } }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: m.text } };
    const res = await fetch(this.o.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.o.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`whatsapp ${res.status}: ${text.slice(0, 200)}`);
    return { providerMsgId: text.match(/"id"\s*:\s*"([^"]+)"/)?.[1], cost: this.o.costPerMessage };
  }
}

export interface HttpVoiceOptions {
  /** One URL with {to} and {text} placeholders, as the BD IVR gateways offer. */
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  costPerCall?: number;
}

/** A generic IVR gateway: one URL, the number and what to say. */
export class HttpVoice implements VoiceAdapter {
  readonly kind = 'http';
  constructor(private o: HttpVoiceOptions) {}
  async call(c: VoiceCall) {
    const fill = (t: string) => t.replace(/{to}/g, encodeURIComponent(c.to.replace(/^\+/, ''))).replace(/{text}/g, encodeURIComponent(c.text)).replace(/{audio}/g, encodeURIComponent(c.audioUrl ?? ''));
    const method = this.o.method ?? 'GET';
    const init: RequestInit = { method, headers: { 'User-Agent': 'Pathshala', ...(this.o.headers ?? {}) } };
    if (method === 'POST') {
      init.body = this.o.body ? fill(this.o.body) : JSON.stringify({ to: c.to, text: c.text, audio: c.audioUrl ?? null });
      (init.headers as Record<string, string>)['Content-Type'] = this.o.body && !this.o.body.trim().startsWith('{') ? 'application/x-www-form-urlencoded' : 'application/json';
    }
    const res = await fetch(fill(this.o.url), init);
    const text = await res.text();
    if (!res.ok) throw new Error(`voice gateway ${res.status}: ${text.slice(0, 200)}`);
    return { providerCallId: text.match(/"(?:call_id|callId|id)"\s*:\s*"?([\w-]+)/i)?.[1] ?? text.trim().slice(0, 60), cost: this.o.costPerCall };
  }
}
