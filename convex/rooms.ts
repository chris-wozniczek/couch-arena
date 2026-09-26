import { internalMutation, mutation, query } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { v } from 'convex/values';
import { rateLimit, requirePlayer } from './lib';
import { role } from './schema';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const STALE_MS = 20_000;

function randomCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
}

async function newRoom(ctx: MutationCtx, host: Doc<'players'>, isPublic: boolean): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = randomCode();
    const clash = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code))
      .first();
    if (clash) continue;
    const now = Date.now();
    await ctx.db.insert('rooms', {
      code,
      hostId: host._id,
      hostNick: host.nick,
      public: isPublic,
      status: 'open',
      epoch: 0,
      hostSeen: now,
      guestSeen: 0,
      createdAt: now,
    });
    return code;
  }
  throw new Error('could not allocate room');
}

export const create = mutation({
  args: { key: v.string(), public: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const p = await requirePlayer(ctx, args.key);
    await rateLimit(ctx, `room:create:${p._id}`, 20, 60_000);
    return { code: await newRoom(ctx, p, args.public ?? false), role: 'host' as const };
  },
});

/** Joins a room by code. Rejoining as the same player (reconnect) is allowed. */
export const join = mutation({
  args: { key: v.string(), code: v.string() },
  handler: async (ctx, { key, code }) => {
    const p = await requirePlayer(ctx, key);
    await rateLimit(ctx, `room:join:${p._id}`, 60, 60_000);
    const room = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code.toUpperCase()))
      .first();
    if (!room || room.status === 'closed') throw new Error('Room not found');
    const now = Date.now();
    if (room.hostId === p._id) {
      await ctx.db.patch(room._id, { hostSeen: now });
      return { code: room.code, role: 'host' as const };
    }
    if (room.guestId && room.guestId !== p._id && now - room.guestSeen < STALE_MS)
      throw new Error('Room is full');
    await ctx.db.patch(room._id, {
      guestId: p._id,
      guestNick: p.nick,
      guestSeen: now,
      status: 'full',
    });
    return { code: room.code, role: 'guest' as const };
  },
});

/** Quick match: join the oldest open public room with a live host, or open a new public room. */
export const quickMatch = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const p = await requirePlayer(ctx, key);
    await rateLimit(ctx, `room:quick:${p._id}`, 30, 60_000);
    const now = Date.now();
    const open = await ctx.db
      .query('rooms')
      .withIndex('by_public_status', (q) => q.eq('public', true).eq('status', 'open'))
      .order('asc')
      .take(20);
    for (const r of open) {
      if (r.hostId === p._id) continue;
      if (now - r.hostSeen > STALE_MS) continue;
      await ctx.db.patch(r._id, { guestId: p._id, guestNick: p.nick, guestSeen: now, status: 'full' });
      return { code: r.code, role: 'guest' as const };
    }
    return { code: await newRoom(ctx, p, true), role: 'host' as const };
  },
});

export const get = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const r = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code.toUpperCase()))
      .first();
    if (!r) return null;
    return {
      code: r.code,
      status: r.status,
      hostNick: r.hostNick,
      guestNick: r.guestNick ?? null,
      epoch: r.epoch,
      hostSeen: r.hostSeen,
      guestSeen: r.guestSeen,
      public: r.public,
    };
  },
});

/** Presence heartbeat (every ~5 s while in a room). */
export const heartbeat = mutation({
  args: { key: v.string(), code: v.string(), role },
  handler: async (ctx, a) => {
    const p = await requirePlayer(ctx, a.key);
    const r = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', a.code))
      .first();
    if (!r) return;
    const now = Date.now();
    if (a.role === 'host' && r.hostId === p._id) await ctx.db.patch(r._id, { hostSeen: now });
    if (a.role === 'guest' && r.guestId === p._id) await ctx.db.patch(r._id, { guestSeen: now });
  },
});

/** Starts a new negotiation epoch (used on reconnect). Old signals are discarded. */
export const bumpEpoch = mutation({
  args: { key: v.string(), code: v.string() },
  handler: async (ctx, a) => {
    const p = await requirePlayer(ctx, a.key);
    const r = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', a.code))
      .first();
    if (!r || (r.hostId !== p._id && r.guestId !== p._id)) throw new Error('not in room');
    await rateLimit(ctx, `room:epoch:${r._id}`, 30, 60_000);
    await ctx.db.patch(r._id, { epoch: r.epoch + 1 });
    const old = await ctx.db
      .query('signals')
      .filter((q) => q.eq(q.field('roomId'), r._id))
      .collect();
    for (const s of old) await ctx.db.delete(s._id);
    return r.epoch + 1;
  },
});

export const leave = mutation({
  args: { key: v.string(), code: v.string() },
  handler: async (ctx, a) => {
    const p = await requirePlayer(ctx, a.key);
    const r = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', a.code))
      .first();
    if (!r) return;
    if (r.hostId === p._id) await ctx.db.patch(r._id, { status: 'closed' });
    else if (r.guestId === p._id)
      await ctx.db.patch(r._id, { guestId: undefined, guestNick: undefined, guestSeen: 0, status: 'open' });
  },
});

/** Cron: close abandoned rooms and purge stale signaling rows. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rooms = await ctx.db
      .query('rooms')
      .filter((q) => q.neq(q.field('status'), 'closed'))
      .take(500);
    for (const r of rooms) {
      if (now - Math.max(r.hostSeen, r.guestSeen) > 10 * 60_000)
        await ctx.db.patch(r._id, { status: 'closed' });
      else if (r.status === 'full' && now - r.guestSeen > 60_000)
        await ctx.db.patch(r._id, { status: 'open', guestId: undefined, guestNick: undefined });
    }
    const sig = await ctx.db
      .query('signals')
      .filter((q) => q.lt(q.field('createdAt'), now - 5 * 60_000))
      .take(1000);
    for (const s of sig) await ctx.db.delete(s._id);
    const rl = await ctx.db
      .query('rateLimits')
      .filter((q) => q.lt(q.field('windowStart'), now - 3 * 3_600_000))
      .take(1000);
    for (const x of rl) await ctx.db.delete(x._id);
  },
});
