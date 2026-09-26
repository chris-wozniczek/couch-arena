---
name: couch-arena-browser-testing
description: Browser testing of Couch Arena synthetic combat, isolated online peers, and fake webcam input on software-rendered VMs.
---

# Couch Arena browser testing

## Setup
- Check the requested revision and deployment first. A local build can use the requested Convex deployment by setting `VITE_CONVEX_URL` inline for `npx vite build`. Do not overwrite `.env.local` when switching backend targets for a test.
- Serve with `npx vite preview --port 4173 --host`. Vite embeds the Convex URL at build time, so changing the preview process environment alone is insufficient.
- On a software-rendered VM use `?webgl&input=synthetic&quality=low`. Low render FPS should not prevent the simulation clock or punch detection from advancing.
- Keep unused game pages blank. For two-peer testing use two separate browser profiles/contexts: the anonymous Convex client key is stored per profile, and two tabs sharing a profile can rejoin as the same player.
- Display both peer windows side by side during online testing to reduce background-tab throttling. Verify health values are mirrored and the debug HUD reports a connected network; connection alone is not punch-sync evidence.

## UI paths
- Menu cards expose `data-testid`: `menu-fight`, `menu-2-players`, `menu-online`, `menu-leaderboards`, `menu-demo`, `menu-camera-setup`.
- P1 punches: A/S/Q/W/Z/X; P2 punches: J/K/U/I/N/M. D toggles debug, Esc returns to menu.
- Online: Create private room, then open `?room=CODE&input=synthetic&webgl&quality=low` in the isolated guest.
- Leaderboards: Arcade, Daily and Training must each resolve to rows or the concrete empty state, not merely render their tabs.

## Fake webcam
- Launch Chrome with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`.
- For person detection use a known boxing video fixture converted to Y4M and `--use-file-for-fake-video-capture=/absolute/path/boxing.y4m`; consult the existing e2e camera test for fixture preparation.
- Open without `input=synthetic`, then Camera setup. A moving video alone proves capture, not pose readiness: require changing skeleton and check framing/inference status separately.
- Software inference can exceed a second; do not claim calibration or webcam gameplay from a preview when the screen still says No one detected.

## Devin Secrets Needed
None for anonymous public gameplay against an already configured backend. Deployment administration is separate from browser testing.
