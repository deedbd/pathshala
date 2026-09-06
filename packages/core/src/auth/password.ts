import bcrypt from 'bcryptjs';

const ROUNDS = 10; // ~80 ms on a shared-hosting core; pure JS bcryptjs (no native bcrypt)

export async function hashPassword(plain: string): Promise<string> { return bcrypt.hash(plain, ROUNDS); }
export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return false;
  try { return await bcrypt.compare(plain, hash); } catch { return false; }
}
export function needsRehash(hash: string): boolean { return bcrypt.getRounds(hash) < ROUNDS; }
