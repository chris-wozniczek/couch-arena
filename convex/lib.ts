import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const BANNED = /(fuck|shit|cunt|nigg|fag|rape|hitler|nazi)/i;

export function cleanNick(n: string): string {
  const s = n
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .slice(0, 16);
  if (s.length < 2 || BANNED.test(s)) return `Boxer${Math.floor(Math.random() * 9000 + 1000)}`;
  return s;
}

export function validKey(k: string): boolean {
  return /^[A-Za-z0-9_-]{22,64}$/.test(k);
}

export async function playerByKey(ctx: QueryCtx, key: string): Promise<Doc<'players'> | null> {
  if (!validKey(key)) return null;
  const keyHash = await sha256(key);
  return ctx.db
    .query('players')
    .withIndex('by_key', (q) => q.eq('keyHash', keyHash))
    .unique();
}

export async function requirePlayer(ctx: QueryCtx, key: string): Promise<Doc<'players'>> {
  const p = await playerByKey(ctx, key);
  if (!p) throw new Error('unknown player');
  return p;
}

/** Fixed-window rate limit. Throws when exceeded. */
export async function rateLimit(ctx: MutationCtx, key: string, max: number, windowMs: number): Promise<void> {
  const now = Date.now();
  const row = await ctx.db
    .query('rateLimits')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique();
  if (!row) {
    await ctx.db.insert('rateLimits', { key, windowStart: now, count: 1 });
    return;
  }
  if (now - row.windowStart > windowMs) {
    await ctx.db.patch(row._id, { windowStart: now, count: 1 });
    return;
  }
  if (row.count >= max) throw new Error('rate limited');
  await ctx.db.patch(row._id, { count: row.count + 1 });
}
