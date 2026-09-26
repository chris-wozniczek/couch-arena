import { internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { rateLimit, requirePlayer } from './lib';

export const check = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const p = await requirePlayer(ctx, key);
    await rateLimit(ctx, `turn:${p._id}`, 20, 3_600_000);
  },
});
