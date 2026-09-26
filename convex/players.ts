import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { cleanNick, playerByKey, rateLimit, sha256, validKey } from './lib';

/** Creates or updates the anonymous player for this client key. */
export const ensure = mutation({
  args: { key: v.string(), nick: v.string() },
  handler: async (ctx, { key, nick }) => {
    if (!validKey(key)) throw new Error('bad key');
    const now = Date.now();
    const existing = await playerByKey(ctx, key);
    const name = cleanNick(nick);
    if (existing) {
      if (existing.nick !== name) await rateLimit(ctx, `nick:${existing._id}`, 10, 3_600_000);
      await ctx.db.patch(existing._id, { nick: name, lastSeen: now });
      return { playerId: existing._id, nick: name };
    }
    const keyHash = await sha256(key);
    await rateLimit(ctx, 'players:create', 600, 60_000);
    const playerId = await ctx.db.insert('players', { keyHash, nick: name, createdAt: now, lastSeen: now });
    return { playerId, nick: name };
  },
});

export const me = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const p = await playerByKey(ctx, key);
    return p ? { playerId: p._id, nick: p.nick } : null;
  },
});
