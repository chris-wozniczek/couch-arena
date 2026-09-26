import { mutation, query } from './_generated/server';
import type { QueryCtx } from './_generated/server';
import { v } from 'convex/values';
import { rateLimit, requirePlayer } from './lib';
import { role } from './schema';

async function roomFor(ctx: QueryCtx, key: string, code: string, as: 'host' | 'guest') {
  const p = await requirePlayer(ctx, key);
  const r = await ctx.db
    .query('rooms')
    .withIndex('by_code', (q) => q.eq('code', code))
    .first();
  if (!r) throw new Error('Room not found');
  const ok = as === 'host' ? r.hostId === p._id : r.guestId === p._id;
  if (!ok) throw new Error('not in room');
  return r;
}

/** Sends an SDP/ICE message to the other peer. Signaling only — never gameplay data. */
export const send = mutation({
  args: {
    key: v.string(),
    code: v.string(),
    from: role,
    kind: v.union(v.literal('offer'), v.literal('answer'), v.literal('ice'), v.literal('bye')),
    payload: v.string(),
    epoch: v.number(),
  },
  handler: async (ctx, a) => {
    if (a.payload.length > 16_000) throw new Error('payload too large');
    const r = await roomFor(ctx, a.key, a.code, a.from);
    await rateLimit(ctx, `sig:${r._id}:${a.from}`, 200, 60_000);
    if (a.epoch !== r.epoch) return false;
    await ctx.db.insert('signals', {
      roomId: r._id,
      to: a.from === 'host' ? 'guest' : 'host',
      kind: a.kind,
      payload: a.payload,
      epoch: a.epoch,
      createdAt: Date.now(),
    });
    return true;
  },
});

export const inbox = query({
  args: { key: v.string(), code: v.string(), as: role },
  handler: async (ctx, a) => {
    const r = await roomFor(ctx, a.key, a.code, a.as);
    const rows = await ctx.db
      .query('signals')
      .withIndex('by_room_to', (q) => q.eq('roomId', r._id).eq('to', a.as))
      .collect();
    return rows
      .filter((s) => s.epoch === r.epoch)
      .map((s) => ({ id: s._id, kind: s.kind, payload: s.payload, epoch: s.epoch }));
  },
});

export const ack = mutation({
  args: { key: v.string(), code: v.string(), as: role, ids: v.array(v.id('signals')) },
  handler: async (ctx, a) => {
    const r = await roomFor(ctx, a.key, a.code, a.as);
    for (const id of a.ids) {
      const s = await ctx.db.get(id);
      if (s && s.roomId === r._id && s.to === a.as) await ctx.db.delete(id);
    }
  },
});
