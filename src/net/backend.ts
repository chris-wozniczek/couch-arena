/**
 * Convex client + anonymous identity. The client key is a random secret kept in localStorage; the server
 * stores only its hash. If `VITE_CONVEX_URL` is not configured, online features are disabled gracefully.
 */
import { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';

export { api };

const URL_ = import.meta.env.VITE_CONVEX_URL as string | undefined;
let client: ConvexClient | null = null;

export const backendAvailable = (): boolean => !!URL_;

export function convex(): ConvexClient {
  if (!URL_) throw new Error('Online features are not configured (VITE_CONVEX_URL missing)');
  client ??= new ConvexClient(URL_);
  return client;
}

function randomKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function clientKey(): string {
  let k = localStorage.getItem('ca.key');
  if (!k) {
    k = randomKey();
    localStorage.setItem('ca.key', k);
  }
  return k;
}

export function nickname(): string {
  return localStorage.getItem('ca.nick') ?? '';
}

export function setNickname(n: string): void {
  localStorage.setItem('ca.nick', n);
}

let ensured: Promise<{ nick: string }> | null = null;
let ensuredNick = '';

/** Registers/updates the anonymous player; returns the sanitized nickname. */
export function ensurePlayer(): Promise<{ nick: string }> {
  const nick = nickname() || `Boxer${Math.floor(Math.random() * 9000 + 1000)}`;
  if (!nickname()) setNickname(nick);
  if (ensured && ensuredNick === nick) return ensured;
  ensuredNick = nick;
  ensured = convex()
    .mutation(api.players.ensure, { key: clientKey(), nick })
    .then((r) => {
      setNickname(r.nick);
      ensuredNick = r.nick;
      return { nick: r.nick };
    })
    .catch((e: unknown) => {
      ensured = null;
      throw e;
    });
  return ensured;
}
