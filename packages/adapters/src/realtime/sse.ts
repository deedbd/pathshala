import type { RealtimeAdapter } from '../interfaces.js';
import type { ServerResponse } from 'node:http';

/** In-process pub/sub delivered over Server-Sent Events (Passenger allows long responses; WebSocket does not fit shared hosting). */
export class SseRealtime implements RealtimeAdapter {
  readonly kind = 'sse';
  private subs = new Map<string, Set<(event: string, data: unknown) => void>>();
  private clients = new Set<ServerResponse>();

  publish(channel: string, event: string, data: unknown) {
    for (const cb of this.subs.get(channel) ?? []) { try { cb(event, data); } catch { /* subscriber error must not break publisher */ } }
  }
  subscribe(channel: string, cb: (event: string, data: unknown) => void) {
    if (!this.subs.has(channel)) this.subs.set(channel, new Set());
    this.subs.get(channel)!.add(cb);
    return () => { this.subs.get(channel)?.delete(cb); };
  }
  /** Express handler: `GET /events?channels=a,b` — keeps the response open and streams published events. */
  handler(channelsOf: (req: { query: Record<string, unknown> }) => string[]) {
    return (req: { query: Record<string, unknown>; on(ev: 'close', cb: () => void): void }, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 5000\n\n`);
      this.clients.add(res);
      const unsubs = channelsOf(req).map(ch => this.subscribe(ch, (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ channel: ch, data })}\n\n`)));
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); unsubs.forEach(u => u()); this.clients.delete(res); });
    };
  }
  get clientCount() { return this.clients.size; }
}
