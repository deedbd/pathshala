import type { Logger, SmsAdapter, SmsMessage } from './interfaces.js';

/** Default until a school buys SMS: log only. Notifications still land in-app and by push/email. */
export class LogSms implements SmsAdapter {
  readonly kind = 'log';
  sent: SmsMessage[] = [];
  constructor(private log?: Logger) {}
  async send(m: SmsMessage) { this.sent.push(m); this.log?.info(`[sms→${m.to}] ${m.text}`); return { providerMsgId: `log-${Date.now()}`, cost: 0 }; }
  async balance() { return null; }
}

export interface HttpSmsOptions {
  /** e.g. https://api.example.com/send?api_key=KEY&to={to}&msg={text}&senderid={sender} — placeholders {to} {text} {sender} */
  url: string;
  method?: 'GET' | 'POST';
  senderId?: string;
  headers?: Record<string, string>;
  /** POST body template (JSON or form); same placeholders. Default: JSON {to,text,sender}. */
  body?: string;
  costPerSms?: number;
  balanceUrl?: string;
}

/**
 * Generic HTTP gateway used by Bangladeshi SMS providers (BulkSMSBD, SSL Wireless, Alpha SMS, Banglalink…):
 * every one of them is "call one URL with to/text/key". Anything more exotic becomes its own class later.
 */
export class HttpSms implements SmsAdapter {
  readonly kind = 'http';
  constructor(private o: HttpSmsOptions) {}
  private fill(t: string, m: SmsMessage) {
    return t.replace(/{to}/g, encodeURIComponent(m.to.replace(/^\+/, ''))).replace(/{text}/g, encodeURIComponent(m.text)).replace(/{sender}/g, encodeURIComponent(m.senderId ?? this.o.senderId ?? ''));
  }
  async send(m: SmsMessage) {
    const method = this.o.method ?? 'GET';
    const url = this.fill(this.o.url, m);
    const init: RequestInit = { method, headers: { 'User-Agent': 'Pathshala', ...(this.o.headers ?? {}) } };
    if (method === 'POST') {
      const body = this.o.body ? this.fill(this.o.body, m) : JSON.stringify({ to: m.to, text: m.text, sender: m.senderId ?? this.o.senderId ?? '' });
      init.body = body;
      (init.headers as Record<string, string>)['Content-Type'] = this.o.body && !this.o.body.trim().startsWith('{') ? 'application/x-www-form-urlencoded' : 'application/json';
    }
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`sms gateway ${res.status}: ${text.slice(0, 200)}`);
    const id = text.match(/"(?:message_id|messageId|id|smsid)"\s*:\s*"?([\w-]+)/i)?.[1] ?? text.trim().slice(0, 60);
    return { providerMsgId: id, cost: this.o.costPerSms };
  }
  async balance() {
    if (!this.o.balanceUrl) return null;
    try { const t = await (await fetch(this.o.balanceUrl)).text(); const n = Number(t.match(/[\d.]+/)?.[0]); return Number.isFinite(n) ? n : null; } catch { return null; }
  }
}
