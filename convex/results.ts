import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { rateLimit, requirePlayer } from './lib';
import { computeScore, validateSummary } from '../src/core/scoring';
import type { MatchSummary } from '../src/core/scoring';
import { dailyChallenge, goalMet, utcDay } from '../src/core/daily';

const MODES = v.union(v.literal('arcade'), v.literal('daily'), v.literal('fitness'));
/** Allowance for client/server clock drift and network when comparing durations. */
const SLACK_MS = 4_000;

/** Issues a match ticket at the start of a scored match. */
export const begin = mutation({
  args: { key: v.string(), mode: MODES },
  handler: async (ctx, { key, mode }) => {
    const p = await requirePlayer(ctx, key);
    await rateLimit(ctx, `ticket:${p._id}`, 30, 3_600_000);
    const ticket = await ctx.db.insert('tickets', {
      playerId: p._id,
      mode,
      day: mode === 'daily' ? utcDay() : undefined,
      issuedAt: Date.now(),
      used: false,
    });
    return { ticket, day: mode === 'daily' ? utcDay() : null };
  },
});

export const submit = mutation({
  args: {
    key: v.string(),
    ticket: v.id('tickets'),
    summary: v.object({
      mode: MODES,
      opponent: v.string(),
      durationMs: v.number(),
      thrown: v.number(),
      landed: v.number(),
      damageDealt: v.number(),
      damageTaken: v.number(),
      knockdownsScored: v.number(),
      maxCombo: v.number(),
      peakSpeed: v.number(),
      won: v.boolean(),
      method: v.string(),
    }),
  },
  handler: async (ctx, { key, ticket, summary }) => {
    const p = await requirePlayer(ctx, key);
    await rateLimit(ctx, `submit:${p._id}`, 20, 3_600_000);
    const t = await ctx.db.get(ticket);
    if (!t || t.playerId !== p._id || t.used) return { ok: false, reason: 'invalid ticket' } as const;
    if (t.mode !== summary.mode) return { ok: false, reason: 'mode mismatch' } as const;
    await ctx.db.patch(t._id, { used: true });
    const elapsed = Date.now() - t.issuedAt;
    if (summary.durationMs > elapsed + SLACK_MS)
      return { ok: false, reason: 'duration exceeds wall clock' } as const;
    if (elapsed > 2 * 3_600_000) return { ok: false, reason: 'ticket expired' } as const;
    const s: MatchSummary = summary;
    const val = validateSummary(s);
    if (!val.ok) return { ok: false, reason: val.reason ?? 'invalid' } as const;
    let board: string = s.mode;
    if (s.mode === 'daily') {
      const day = t.day ?? utcDay();
      const ch = dailyChallenge(day);
      if (s.opponent !== ch.opponent.id) return { ok: false, reason: 'wrong opponent' } as const;
      if (!goalMet(ch.goal, s)) return { ok: false, reason: 'goal not met' } as const;
      board = `daily:${day}`;
    }
    const score = computeScore(s);
    const prev = await ctx.db
      .query('results')
      .withIndex('by_player_board', (q) => q.eq('playerId', p._id).eq('board', board))
      .first();
    const row = {
      playerId: p._id,
      nick: p.nick,
      board,
      score,
      won: s.won,
      method: s.method,
      opponent: s.opponent,
      landed: s.landed,
      thrown: s.thrown,
      maxCombo: s.maxCombo,
      peakSpeed: Math.round(s.peakSpeed * 10) / 10,
      durationMs: s.durationMs,
      createdAt: Date.now(),
    };
    let best = true;
    if (prev) {
      if (prev.score >= score) best = false;
      else await ctx.db.replace(prev._id, row);
    } else await ctx.db.insert('results', row);
    const above = await ctx.db
      .query('results')
      .withIndex('by_board_score', (q) => q.eq('board', board).gt('score', score))
      .collect();
    return { ok: true, score, best, rank: above.length + 1, board } as const;
  },
});

export const top = query({
  args: { board: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { board, limit }) => {
    const rows = await ctx.db
      .query('results')
      .withIndex('by_board_score', (q) => q.eq('board', board))
      .order('desc')
      .take(Math.min(100, limit ?? 50));
    return rows.map((r) => ({
      id: r._id,
      nick: r.nick,
      score: r.score,
      won: r.won,
      method: r.method,
      opponent: r.opponent,
      landed: r.landed,
      thrown: r.thrown,
      maxCombo: r.maxCombo,
      peakSpeed: r.peakSpeed,
      durationMs: r.durationMs,
      createdAt: r.createdAt,
    }));
  },
});

export const daily = query({
  args: {},
  handler: async () => {
    const day = utcDay();
    const c = dailyChallenge(day);
    return { day, id: c.id, title: c.title, description: c.description, opponent: c.opponent.name };
  },
});
