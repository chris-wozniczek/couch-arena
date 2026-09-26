import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export const role = v.union(v.literal('host'), v.literal('guest'));

export default defineSchema({
  /** Anonymous players, identified by a random client secret (only its hash is stored). */
  players: defineTable({
    keyHash: v.string(),
    nick: v.string(),
    createdAt: v.number(),
    lastSeen: v.number(),
  }).index('by_key', ['keyHash']),

  rooms: defineTable({
    code: v.string(),
    hostId: v.id('players'),
    guestId: v.optional(v.id('players')),
    hostNick: v.string(),
    guestNick: v.optional(v.string()),
    public: v.boolean(),
    status: v.union(v.literal('open'), v.literal('full'), v.literal('closed')),
    /** Bumped when either side restarts negotiation (reconnect). */
    epoch: v.number(),
    hostSeen: v.number(),
    guestSeen: v.number(),
    createdAt: v.number(),
  })
    .index('by_code', ['code'])
    .index('by_public_status', ['public', 'status']),

  /** WebRTC signaling mailbox. Rows are deleted once consumed. */
  signals: defineTable({
    roomId: v.id('rooms'),
    to: role,
    kind: v.union(v.literal('offer'), v.literal('answer'), v.literal('ice'), v.literal('bye')),
    payload: v.string(),
    epoch: v.number(),
    createdAt: v.number(),
  }).index('by_room_to', ['roomId', 'to']),

  /** Server-issued match tickets: submission must reference one and respect wall-clock duration. */
  tickets: defineTable({
    playerId: v.id('players'),
    mode: v.string(),
    day: v.optional(v.string()),
    issuedAt: v.number(),
    used: v.boolean(),
  }).index('by_player', ['playerId']),

  results: defineTable({
    playerId: v.id('players'),
    nick: v.string(),
    board: v.string(),
    score: v.number(),
    won: v.boolean(),
    method: v.string(),
    opponent: v.string(),
    landed: v.number(),
    thrown: v.number(),
    maxCombo: v.number(),
    peakSpeed: v.number(),
    durationMs: v.number(),
    createdAt: v.number(),
  })
    .index('by_board_score', ['board', 'score'])
    .index('by_player_board', ['playerId', 'board']),

  rateLimits: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index('by_key', ['key']),
});
