/// <reference types="node" />
'use node';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';

const FALLBACK = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

/**
 * Short-lived Cloudflare Realtime TURN credentials. The TURN key id and API token live only in Convex
 * environment variables and never reach the client.
 */
export const iceServers = action({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<{ iceServers: RTCIceServerLike[]; turn: boolean }> => {
    await ctx.runMutation(internal.turnLimit.check, { key });
    const id = process.env.CLOUDFLARE_TURN_KEY_ID;
    const token = process.env.CLOUDFLARE_TURN_KEY_API_TOKEN;
    if (!id || !token) return { iceServers: FALLBACK, turn: false };
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }),
        },
      );
      if (!res.ok) return { iceServers: FALLBACK, turn: false };
      const data = (await res.json()) as { iceServers: RTCIceServerLike | RTCIceServerLike[] };
      const list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
      return { iceServers: list, turn: true };
    } catch {
      return { iceServers: FALLBACK, turn: false };
    }
  },
});

interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}
