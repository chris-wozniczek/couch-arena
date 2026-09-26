# Couch Arena

Kinect Sports-style **webcam boxing in the browser**. No controllers, no install: jab, cross, hook and uppercut at your camera; slip, duck and guard for real.

**Play:** https://couch-arena-psi.vercel.app

Modes:

- **Fight**: three rounds against a rigged 3D AI boxer (Rookie, Contender or Champion). Includes KO slow-motion replay.
- **Daily**: a seeded daily challenge opponent with its own leaderboard.
- **2 Players**: two boxers on **one camera**. MediaPipe tracks up to 2 poses; players are assigned to the left and right lanes of the frame, and assignment survives swaps and overlap.
- **Online**: 1v1 over WebRTC. Share a room link or QR code, or use quick match.
- **Training**: combo caller, punch count, peak speed and calories over 3 × 60 s rounds.
- **Leaderboards**: arcade, daily and training boards.
- **Demo**: an attract-mode exhibition bout driven by synthetic poses through the same input pipeline.
- **Highlights**: press **R** (or ● REC) to record a 15 s clip from the canvas plus game audio. It saves as MP4 where the browser supports it and WebM otherwise, and you can download or share it to X/TikTok.

## Controls

| Action            | Webcam                              | Keyboard fallback (P1 / P2)          |
| ----------------- | ----------------------------------- | ------------------------------------ |
| Jab / cross       | straight punch, lead / rear hand    | A / S · J / K                        |
| Hooks             | lead / rear hook                    | Q / W · U / I                        |
| Uppercuts         | lead / rear uppercut                | Z / X · N / M                        |
| Guard             | both gloves up by your face         | on by default; E / O drops the guard |
| Slip left / right | move your head sideways             | ← / →                                |
| Duck              | drop your head below your shoulders | ↓                                    |
| Record highlight  | —                                   | R                                    |
| Debug / perf HUD  | —                                   | D                                    |
| Menu              | —                                   | Esc                                  |

URL flags: `?input=synthetic` for keyboard/synthetic input, `?webgl` to force the WebGL2 backend, `?room=CODE` to join an online room.

## How it works

```
 webcam ──► camera.ts (picker, 1280×720@60 / 1920×1080@30, Continuity Camera)
   │  ImageBitmap (transfer)
   ▼
 pose.worker.ts  MediaPipe PoseLandmarker HEAVY|FULL, GPU delegate → CPU fallback, numPoses 1|2
   │  landmarks + timestamps           ▲ same PoseSource interface
   ▼                                   │ syntheticSource.ts (demo / keyboard) · future native bridge
 InputHub ── LaneAssigner (2P) ──► PlayerTracker ×N
   │   One Euro filter per landmark, short-horizon prediction, per-player calibration
   ▼
 src/core (pure TypeScript, no DOM/three)
   punch.ts  jab/cross/hook/uppercut from elbow angle, wrist velocity/path, apparent size (z)
   defense.ts guard / slip / duck with hysteresis + cooldowns
   combat.ts · scoring.ts · ai.ts · match.ts · fitness.ts · netcode.ts · daily.ts
   ▼
 game/modes ──► World (three.js WebGPU → WebGL2) at display rate, decoupled from tracking
   arena, PBR ring, HDRI, spotlights, fog, crowd · GTAO, bloom, motion blur, DoF replay, AgX
   rigged boxer (animation blend layers) · first-person gloves with arm IK · Web Audio synth

 Online:   browser A ◄── WebRTC DataChannels ──► browser B
             "pose" unordered/unreliable · "events" reliable (punches, hits, round state)
           Convex: rooms, presence, quick match, signaling tables (offer/answer/ICE),
                   TURN credential action (Cloudflare Realtime), result tickets, leaderboards
```

- **The game logic is portable.** Everything in `src/core` is pure, typed TypeScript with no dependency on the camera, DOM or renderer, so it can be ported to Swift, or run in a WKWebView where Apple Vision provides landmarks. `PoseSource` (`src/core/types.ts`) is the only seam a native bridge needs to implement.
- **Latency.** Pose inference runs in a Web Worker and never blocks rendering. Landmarks are One-Euro filtered and extrapolated ahead by the measured pipeline latency (capped at 90 ms). The debug HUD (**D**) shows render fps, tracking fps, inference ms, capture→result time, an end-to-end estimate, a flash test, JS heap and a skeleton overlay.
- **Model choice.** The camera setup screen benchmarks HEAVY against FULL on your machine. Auto picks HEAVY when its p90 fits the real-time budget and FULL otherwise, and caches the choice. You can override it manually.
- **Quality.** Rendering runs at maximum quality by default. Adaptive quality only steps down when frame time stays over budget. Tracking pauses while the tab is hidden.
- **Online authority.** Each client is authoritative over its own punches. The defender resolves blocks and slips at the attacker's timestamp using its own pose history (`src/core/netcode.ts`). Disconnects trigger ICE restart and re-signaling via a room epoch.
- **Anti-cheat basics.** The server issues a result ticket when a match starts. When a score is submitted, the server checks duration, punch rates, peak speed and score consistency before accepting it, and it rate-limits per player.

## Privacy

Video never leaves your device. Pose inference runs locally in your browser. Online matches only send pose keypoints and punch events, peer-to-peer over WebRTC. The backend stores your nickname, a hashed anonymous client key, rooms/signaling messages and submitted match stats. TURN credentials are minted server-side and are short-lived.

## Run locally

```bash
npm install
npx convex dev          # optional: creates a dev deployment and writes VITE_CONVEX_URL to .env.local
npm run dev             # http://localhost:5173
```

The app works without Convex. Online play and leaderboards are simply disabled. To use TURN in your own deployment, set `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_KEY_API_TOKEN` as Convex env vars.

| Command                                                     |                                                                                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint && npm run format:check && npm run typecheck` | static checks                                                                                                                                                                                |
| `npm test`                                                  | Vitest: punch classifier on landmark fixtures, defense, scoring, AI, match flow, lanes, netcode reconciliation                                                                               |
| `npm run build`                                             | typecheck + production build                                                                                                                                                                 |
| `npm run e2e`                                               | Playwright: synthetic single-player fight, plus Chrome fake camera fed with a recorded boxing clip (`--use-fake-device-for-media-stream --use-file-for-fake-video-capture`). Needs `ffmpeg`. |

**Deployment.** Vercel builds production with `npx convex deploy --cmd "npm run build"` (using `CONVEX_DEPLOY_KEY`), so the Convex functions and the frontend ship together. Preview builds point at the production Convex URL.

## Testing on a real Mac

The cloud VM only verifies correctness. Real latency and performance have to be measured on your hardware. Use Chrome or Safari on Apple Silicon:

1. Open **Camera setup**. Check that the resolution/fps line reads 1280×720 @ 60 (or 1920×1080 @ 30), and that an iPhone shows up as _Continuity Camera_ in the picker if you have one.
2. Click **Benchmark HEAVY vs FULL** and note both p50/p90. Auto should choose HEAVY if its p90 is ≤ 24 ms.
3. Complete the 10 s calibration standing about 2 m back, with your upper body in the frame guide.
4. Press **D** in a fight. Render should hold your display rate (60/120), and tracking should run at about 30–60 fps. Note the inference ms and the capture→result time.
5. Use the **Flash test**: punch as soon as the screen flashes. The flash→punch number includes your reaction time (~200 ms), so compare it against a normal reaction test. The perceived gloves-follow-hands lag should feel under 100 ms.
6. Punch recognition: throw 10 each of jab, cross, hooks and uppercuts. Watch the hit feed for misclassifications and false positives while you are just moving around.
7. Defense: slip left/right, duck, and hold your guard while the AI attacks.
8. 2 Players: stand side by side, then swap sides and briefly overlap. Lanes should stay assigned to the same person.
9. Online: open a room on the Mac and join from another device or network. The debug HUD shows RTT and whether a TURN relay is in use.
10. Record a highlight (**R**) and check that it plays in QuickTime and uploads to X.
11. Activity Monitor: check CPU/GPU usage and fan noise over a full 3-round fight.

## Credits & licenses

- Boxer character and animations: [Quaternius](https://quaternius.com) _Universal Base Characters_ and _Universal Animation Library_, **CC0 1.0**.
- Arena HDRI: [Poly Haven — Empty Warehouse 01](https://polyhaven.com/a/empty_warehouse_01) by Sergej Majboroda, **CC0**.
- Pose models: Google MediaPipe PoseLandmarker (full/heavy), **Apache 2.0**.
- Test fixture `tests/fixtures/boxing-training.webm`: re-encoded from [“Boxing training”](https://commons.wikimedia.org/wiki/File:Boxing_training.webm) on Wikimedia Commons, **CC BY-SA 3.0**.
- three.js (MIT), Convex (Apache 2.0), qrcode (MIT). All sound is synthesized at runtime with Web Audio.
