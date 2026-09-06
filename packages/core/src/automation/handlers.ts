import type { EventEnvelope, EventType } from '@pathshala/events';

export type SystemHandler<T extends EventType = EventType> = (event: EventEnvelope<T>) => Promise<void>;

/**
 * System handlers (🔒 rows in docs/AUTOMATION.md) — always-on reactions written in code.
 * Each handler has a stable name used for idempotency in `event_consumptions` (`system:<name>`).
 */
export class HandlerRegistry {
  private map = new Map<string, { name: string; fn: SystemHandler }[]>();

  on<T extends EventType>(type: T, name: string, fn: SystemHandler<T>) {
    if (!this.map.has(type)) this.map.set(type, []);
    const list = this.map.get(type)!;
    if (list.some(h => h.name === name)) throw new Error(`handler ${name} already registered for ${type}`);
    list.push({ name, fn: fn as SystemHandler });
    return this;
  }
  for(type: string) { return this.map.get(type) ?? []; }
  names() { return [...this.map.entries()].flatMap(([t, hs]) => hs.map(h => `${t} → ${h.name}`)); }
}
