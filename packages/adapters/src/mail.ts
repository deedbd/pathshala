import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { Logger, MailAdapter, MailMessage } from './interfaces.js';

export interface SmtpOptions { host: string; port?: number; user?: string; pass?: string; from: string; secure?: boolean }

/** cPanel SMTP through Nodemailer (pure JS). Port 465 → implicit TLS, 587 → STARTTLS. */
export class SmtpMail implements MailAdapter {
  readonly kind = 'smtp';
  private t: Transporter;
  constructor(private o: SmtpOptions) {
    const port = o.port ?? 465;
    this.t = nodemailer.createTransport({ host: o.host, port, secure: o.secure ?? port === 465, auth: o.user ? { user: o.user, pass: o.pass ?? '' } : undefined, connectionTimeout: 10_000, greetingTimeout: 10_000 });
  }
  async send(m: MailMessage) {
    const info = await this.t.sendMail({ from: m.from ?? this.o.from, to: m.to, subject: m.subject, text: m.text, html: m.html, replyTo: m.replyTo, attachments: m.attachments });
    return { id: info.messageId };
  }
  async verify() { try { await this.t.verify(); return true; } catch { return false; } }
}

/** No SMTP configured: log the mail so installs never block on email. */
export class LogMail implements MailAdapter {
  readonly kind = 'log';
  sent: MailMessage[] = [];
  constructor(private log?: Logger) {}
  async send(m: MailMessage) { this.sent.push(m); this.log?.info(`[mail→${m.to}] ${m.subject}`); return { id: `log-${Date.now()}` }; }
  async verify() { return true; }
}
