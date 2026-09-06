import { randomBytes } from 'node:crypto';

// Crockford base32 ULID (26 chars): 10 chars time (ms) + 16 chars randomness.
// Monotonic within a process so rows inserted in the same millisecond still sort by insertion order.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = 0;
let lastRand: number[] = [];

export function ulid(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 9; i >= 0; i--) { time = ALPHABET[t % 32] + time; t = Math.floor(t / 32); }
  let rand: number[];
  if (now === lastTime) {
    rand = lastRand.slice();
    // increment the random part
    for (let i = 15; i >= 0; i--) { if (rand[i] < 31) { rand[i]++; break; } rand[i] = 0; }
  } else {
    const bytes = randomBytes(16);
    rand = Array.from(bytes, b => b % 32);
  }
  lastTime = now; lastRand = rand;
  return time + rand.map(v => ALPHABET[v]).join('');
}

export function isUlid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
}

export function ulidTime(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + ALPHABET.indexOf(ch);
  return t;
}
