/** Menu-level screens: camera setup, calibration, results, leaderboard, online lobby. */
import QRCode from 'qrcode';
import { Calibrator, CALIBRATION_PHASES, estimateDistance } from '../core/calibration';
import { utcDay } from '../core/daily';
import type { InputHub } from '../game/input';
import { saveProfile } from '../game/input';
import type { ResultInfo } from '../game/context';
import { api, backendAvailable, clientKey, convex, ensurePlayer } from '../net/backend';
import { listCameras, openCamera, stopCamera } from '../tracking/camera';
import type { OpenCamera } from '../tracking/camera';
import { LightingProbe } from '../tracking/quality';
import { h } from './dom';
import { shareClip, xIntent } from './recorder';
import { drawCamera, drawSkeleton, PLAYER_COLORS } from './skeleton';

export type Screen = { el: HTMLElement; dispose: () => void };

/** Live camera preview with tracked skeletons; returns a stop function. */
export function livePreview(
  canvas: HTMLCanvasElement,
  input: InputHub,
  opts: { lanes?: boolean; dim?: number; color?: () => string } = {},
): () => void {
  const ctx = canvas.getContext('2d')!;
  let raf = 0;
  const draw = () => {
    raf = requestAnimationFrame(draw);
    const r = canvas.getBoundingClientRect();
    const w = Math.max(160, Math.round(r.width * Math.min(2, devicePixelRatio)));
    const hh = Math.round((w * 9) / 16);
    if (canvas.width !== w) {
      canvas.width = w;
      canvas.height = hh;
    }
    drawCamera(ctx, input.mediapipe ? input.video : null, opts.dim ?? 1);
    if (opts.lanes) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(canvas.width / 2 - 1, 0, 2, canvas.height);
    }
    input.assigned.forEach(
      (p, i) =>
        p &&
        drawSkeleton(
          ctx,
          p,
          opts.color?.() ?? PLAYER_COLORS[i]!,
          input.players === 2 ? `P${i + 1}` : undefined,
        ),
    );
  };
  draw();
  return () => cancelAnimationFrame(raf);
}

// ---- Camera setup ------------------------------------------------------------------------------

const FRAMING_COLORS = { bad: '#ff4d64', warn: '#ffc53d', ok: '#3ddc84' } as const;

export function cameraSetup(
  input: InputHub,
  current: OpenCamera | null,
  onCamera: (c: OpenCamera) => void,
  onDone: () => void,
  onBack: () => void,
): Screen {
  const select = h('select', { 'aria-label': 'Camera' });
  const preview = h('canvas');
  const guide = h('div', { class: 'frame-guide' }, h('span', {}, 'Fit head, shoulders & hands in here'));
  /** Skeleton/guide tint: red = not usable, amber = adjust distance, green = ready to calibrate. */
  let framing: 'bad' | 'warn' | 'ok' = 'bad';
  const checks = {
    body: h('div', { class: 'check' }, h('i', { class: 'dot' }), h('span', {}, 'Upper body')),
    dist: h('div', { class: 'check' }, h('i', { class: 'dot' }), h('span', {}, 'Distance')),
    light: h('div', { class: 'check' }, h('i', { class: 'dot' }), h('span', {}, 'Lighting')),
    cam: h('div', { class: 'check' }, h('i', { class: 'dot' }), h('span', {}, 'Camera')),
    model: h('div', { class: 'check' }, h('i', { class: 'dot' }), h('span', {}, 'Tracking model')),
  };
  const set = (c: HTMLElement, level: 'ok' | 'warn' | 'bad' | '', text: string) => {
    c.className = `check ${level}`;
    c.querySelector('span')!.textContent = text;
  };
  const modelSel = h(
    'select',
    { 'aria-label': 'Model' },
    h('option', { value: 'auto' }, 'Auto (benchmark: HEAVY if real-time, else FULL)'),
    h('option', { value: 'heavy' }, 'HEAVY (best accuracy)'),
    h('option', { value: 'full' }, 'FULL (faster)'),
  );
  const benchBtn = h('button', { class: 'btn small' }, 'Benchmark both');
  const benchOut = h('div', { class: 'muted small' });
  const cont = h('button', { class: 'btn primary' }, 'Calibrate →');
  const el = h(
    'div',
    { class: 'screen' },
    h('h2', {}, 'CAMERA SETUP'),
    h(
      'div',
      { class: 'setup' },
      h('div', { class: 'preview' }, preview, guide),
      h(
        'div',
        { class: 'panel checks' },
        h('label', { class: 'small muted' }, 'Camera (iPhone Continuity Camera works great)'),
        select,
        ...Object.values(checks),
        h('label', { class: 'small muted', style: 'margin-top:8px' }, 'Pose model'),
        modelSel,
        h('div', { class: 'row', style: 'justify-content:flex-start' }, benchBtn),
        benchOut,
        h(
          'div',
          { class: 'small muted' },
          'Stand ~2 m back so your head, shoulders, elbows and hands are inside the outline. The skeleton turns green when framing and distance are good (amber = adjust distance). Face a light source; avoid a bright window behind you.',
        ),
      ),
    ),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => onBack() }, 'Back'), cont),
  );
  let cam = current;
  let alive = true;
  const probe = new LightingProbe();
  const stopPreview = livePreview(preview, input, { color: () => FRAMING_COLORS[framing] });

  const open = async (id?: string) => {
    try {
      if (cam && id && cam.deviceId === id) return;
      stopCamera(cam);
      cam = await openCamera(id);
      input.video.srcObject = cam.stream;
      await input.video.play();
      onCamera(cam);
      await refreshList();
      const m = modelSel.value as 'auto' | 'full' | 'heavy';
      await input.useCamera(m);
    } catch (e) {
      set(checks.cam, 'bad', `Camera error: ${(e as Error).message}`);
    }
  };
  const refreshList = async () => {
    const cams = await listCameras();
    select.replaceChildren(
      ...cams.map((c) =>
        h(
          'option',
          { value: c.deviceId, selected: cam?.deviceId === c.deviceId },
          `${c.label}${c.kind === 'continuity' ? ' (iPhone)' : ''}`,
        ),
      ),
    );
  };
  select.addEventListener('change', () => void open(select.value));
  modelSel.addEventListener('change', () => {
    const m = modelSel.value;
    if (m !== 'auto') void input.mediapipe?.setModel(m as 'full' | 'heavy');
  });
  benchBtn.addEventListener('click', async () => {
    const mp = input.mediapipe;
    if (!mp) return;
    benchBtn.disabled = true;
    benchOut.textContent = 'Benchmarking…';
    const res = await mp.benchmarkBoth();
    benchOut.textContent = res
      .map((r) => `${r.model.toUpperCase()}: p50 ${r.p50.toFixed(1)} ms · p90 ${r.p90.toFixed(1)} ms`)
      .join('  |  ');
    const heavy = res.find((r) => r.model === 'heavy');
    await mp.setModel(heavy && heavy.p90 <= 24 ? 'heavy' : 'full');
    benchBtn.disabled = false;
  });
  cont.addEventListener('click', () => onDone());
  if (!cam) void open();
  else {
    void refreshList();
    void input.useCamera();
  }

  const timer = window.setInterval(() => {
    if (!alive) return;
    const f = input.trackers[0].features;
    const lp = probe.sample(input.video);
    if (cam)
      set(
        checks.cam,
        cam.frameRate >= 50 ? 'ok' : 'warn',
        `${cam.width}×${cam.height} @ ${Math.round(cam.frameRate)} fps`,
      );
    const st = input.mediapipe?.stats;
    if (st)
      set(
        checks.model,
        st.backend === 'loading' ? '' : st.inferenceMs < 30 ? 'ok' : 'warn',
        `${st.backend} · ${st.inferenceMs.toFixed(1)} ms · ${st.fps.toFixed(0)} fps`,
      );
    if (!input.trackers[0].present || !f) {
      framing = 'bad';
      set(checks.body, 'bad', 'No one detected — step into frame');
      set(checks.dist, '', 'Distance');
    } else {
      set(
        checks.body,
        f.valid ? 'ok' : 'warn',
        f.valid ? 'Upper body visible' : 'Show head, shoulders, elbows & hands',
      );
      const d = estimateDistance(f.shoulderWidth, f.img.shoulderWidth, 16 / 9);
      const sw = f.img.shoulderWidth;
      framing = !f.valid ? 'bad' : sw > 0.42 || sw < 0.13 ? 'warn' : 'ok';
      set(
        checks.dist,
        sw > 0.42 ? 'bad' : sw < 0.13 ? 'warn' : 'ok',
        sw > 0.42
          ? 'Too close — step back'
          : sw < 0.13
            ? 'Too far — step closer'
            : `Good distance (~${d.toFixed(1)} m)`,
      );
    }
    guide.className = `frame-guide ${framing}`;
    if (lp)
      set(
        checks.light,
        lp.verdict === 'ok' ? 'ok' : 'warn',
        lp.verdict === 'ok'
          ? 'Lighting good'
          : lp.verdict === 'dark'
            ? 'Too dark — add light in front of you'
            : lp.verdict === 'backlit'
              ? 'Backlit — avoid windows behind you'
              : 'Low contrast — brighter light helps',
      );
  }, 250);
  return {
    el,
    dispose: () => {
      alive = false;
      clearInterval(timer);
      stopPreview();
    },
  };
}

// ---- Calibration -------------------------------------------------------------------------------

export function calibration(input: InputHub, slot: 0 | 1, onDone: () => void, onSkip: () => void): Screen {
  const preview = h('canvas');
  const prompt = h('div', { class: 'prompt' }, 'Step into frame');
  const bars = CALIBRATION_PHASES.map(() => h('i'));
  const who = input.players === 2 ? `PLAYER ${slot + 1} ${slot === 0 ? '(LEFT)' : '(RIGHT)'} — ` : '';
  const el = h(
    'div',
    { class: 'screen' },
    h('div', { class: 'calib-pip preview' }, preview),
    h(
      'div',
      { class: 'calib' },
      h('div', { class: 'small muted', style: 'letter-spacing:0.2em' }, `${who}CALIBRATION · 10 SECONDS`),
      prompt,
      h('div', { class: 'steps' }, ...bars.map((b) => h('div', {}, b))),
      h(
        'div',
        { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn small', onclick: () => onSkip() }, 'Skip (use defaults)'),
      ),
    ),
  );
  const stopPreview = livePreview(preview, input, { lanes: input.players === 2 });
  const aspect = input.lastFrame ? input.lastFrame.width / input.lastFrame.height : 16 / 9;
  const cal = new Calibrator(aspect);
  let finished = false;
  const unsub = input.onUpdate((i, u) => {
    if (i !== slot || finished || !u.features) return;
    cal.push(u.features);
    const s = cal.state;
    prompt.textContent = u.features.valid ? s.prompt : 'Show your whole upper body';
    const idx = CALIBRATION_PHASES.findIndex((p) => p.phase === s.phase);
    bars.forEach(
      (b, k) =>
        (b.style.width = `${k < idx || s.phase === 'done' ? 100 : k === idx ? s.progress * 100 : 0}%`),
    );
    if (cal.done) {
      finished = true;
      const p = cal.result();
      saveProfile(slot, p);
      input.trackers[slot].setProfile(p);
      prompt.textContent = `Calibrated! Reach ${(p.armLength * 100).toFixed(0)} cm · ${p.stance}`;
      setTimeout(onDone, 900);
    }
  });
  return {
    el,
    dispose: () => {
      unsub();
      stopPreview();
    },
  };
}

// ---- Results -----------------------------------------------------------------------------------

export function results(r: ResultInfo, onMenu: () => void): Screen {
  const status = h('div', { class: 'muted small' });
  const clipBox = h('div', { class: 'row', style: 'flex-direction:column' });
  const el = h(
    'div',
    { class: 'screen' },
    h(
      'div',
      { class: 'panel results', style: 'text-align:center' },
      h('h2', {}, r.title),
      h('div', { class: 'muted' }, r.subtitle),
      h(
        'div',
        { class: 'grid2' },
        ...r.stats.map(([k, v]) =>
          h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k)),
        ),
      ),
      status,
      clipBox,
      h(
        'div',
        { class: 'row', style: 'margin-top:16px' },
        h('button', { class: 'btn primary', onclick: () => r.again() }, 'Again'),
        h('button', { class: 'btn', onclick: () => onMenu() }, 'Menu'),
      ),
    ),
  );
  if (r.clip) clipBox.append(clipView(r.clip, 'KO replay'));
  if (r.summary && r.summary.mode && backendAvailable()) {
    if (!r.ticket) status.textContent = 'Offline — score not submitted.';
    else {
      status.textContent = 'Submitting score…';
      void (async () => {
        try {
          const res = await convex().mutation(api.results.submit, {
            key: clientKey(),
            ticket: r.ticket as never,
            summary: r.summary!,
          });
          status.textContent = res.ok
            ? `Score ${res.score.toLocaleString()} · rank #${res.rank} ${res.best ? '· new personal best!' : ''}`
            : `Not ranked: ${res.reason}`;
        } catch (e) {
          status.textContent = `Could not submit: ${(e as Error).message}`;
        }
      })();
    }
  }
  return { el, dispose: () => {} };
}

export function clipView(
  clip: { url: string; ext: string; blob: Blob; mime: string; durationMs: number },
  label: string,
): HTMLElement {
  const text = 'I just boxed in my living room with a webcam 🥊 #CouchArena';
  const url = location.origin;
  return h(
    'div',
    { class: 'row', style: 'flex-direction:column;margin-top:10px' },
    h(
      'div',
      { class: 'small muted' },
      `${label} · ${(clip.durationMs / 1000).toFixed(1)} s ${clip.ext.toUpperCase()}`,
    ),
    h('video', {
      class: 'clip-video',
      src: clip.url,
      controls: true,
      autoplay: true,
      muted: true,
      loop: true,
      playsinline: true,
    }),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        { class: 'btn', onclick: () => void shareClip({ ...clip, ext: clip.ext as 'mp4' | 'webm' }, text) },
        'Share / Save',
      ),
      h('a', { class: 'btn', href: clip.url, download: `couch-arena.${clip.ext}` }, 'Download'),
      h('a', { class: 'btn', href: xIntent(text, url), target: '_blank', rel: 'noopener' }, 'Post on X'),
    ),
    h(
      'div',
      { class: 'small muted' },
      'TikTok: download the clip, then upload it from the TikTok app or tiktok.com/upload.',
    ),
  );
}

// ---- Leaderboard -------------------------------------------------------------------------------

export function leaderboard(onBack: () => void): Screen {
  const tabs: Array<[string, string]> = [
    ['arcade', 'Arcade'],
    [`daily:${utcDay()}`, 'Daily'],
    ['fitness', 'Training'],
  ];
  const body = h('tbody');
  const tabEls = tabs.map(([id, label]) => h('button', { class: 'tab', onclick: () => load(id) }, label));
  const daily = h('div', { class: 'muted small', style: 'margin-bottom:10px' });
  const el = h(
    'div',
    { class: 'screen' },
    h(
      'div',
      { class: 'panel results' },
      h('h2', {}, 'LEADERBOARDS'),
      h('div', { class: 'tabs' }, ...tabEls),
      daily,
      h(
        'div',
        { class: 'lb-wrap' },
        h(
          'table',
          { class: 'lb' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', {}, '#'),
              h('th', {}, 'Boxer'),
              h('th', {}, 'Score'),
              h('th', {}, 'Result'),
              h('th', {}, 'Landed'),
              h('th', {}, 'Combo'),
              h('th', {}, 'Peak'),
            ),
          ),
          body,
        ),
      ),
      h(
        'div',
        { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn', onclick: () => onBack() }, 'Back'),
      ),
    ),
  );
  let unsub: (() => void) | null = null;
  let myNick = '';
  const load = (board: string) => {
    tabEls.forEach((t, i) => t.classList.toggle('on', tabs[i]![0] === board));
    unsub?.();
    if (!backendAvailable()) {
      body.replaceChildren(h('tr', {}, h('td', { colspan: 7 }, 'Leaderboards need the online backend.')));
      return;
    }
    body.replaceChildren(h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'Loading…')));
    unsub = convex().onUpdate(api.results.top, { board, limit: 50 }, (rows) => {
      if (!rows.length) {
        body.replaceChildren(
          h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'No scores yet — be the first!')),
        );
        return;
      }
      body.replaceChildren(
        ...rows.map((r, i) =>
          h(
            'tr',
            { class: r.nick === myNick ? 'me' : '' },
            h('td', { class: 'rank' }, String(i + 1)),
            h('td', {}, r.nick),
            h('td', {}, r.score.toLocaleString()),
            h('td', {}, r.method === 'fitness' ? '—' : `${r.won ? 'W' : 'L'} · ${r.method}`),
            h('td', {}, `${r.landed}/${r.thrown}`),
            h('td', {}, String(r.maxCombo)),
            h('td', {}, `${r.peakSpeed.toFixed(1)} m/s`),
          ),
        ),
      );
    });
  };
  if (backendAvailable()) {
    void ensurePlayer()
      .then((p) => (myNick = p.nick))
      .catch(() => {});
    void convex()
      .query(api.results.daily, {})
      .then((d) => (daily.textContent = `${d.title} — ${d.description}`))
      .catch(() => {});
  }
  load('arcade');
  return { el, dispose: () => unsub?.() };
}

// ---- Online lobby ------------------------------------------------------------------------------

export interface LobbyHandlers {
  onRoom: (code: string, role: 'host' | 'guest') => void;
  onBack: () => void;
}

export function lobby(initialCode: string | null, hnd: LobbyHandlers): Screen {
  const codeIn = h('input', {
    type: 'text',
    placeholder: 'ROOM CODE',
    maxlength: 6,
    style: 'text-transform:uppercase;letter-spacing:0.2em;min-width:160px',
  });
  const status = h('div', { class: 'muted small' });
  const el = h(
    'div',
    { class: 'screen' },
    h(
      'div',
      {
        class: 'panel',
        style: 'width:min(620px,92vw);text-align:center;display:flex;flex-direction:column;gap:16px',
      },
      h('h2', {}, 'ONLINE 1V1'),
      h(
        'div',
        { class: 'muted small' },
        'Peer-to-peer: only pose & punch data is exchanged — your video never leaves your device.',
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => void go(() => convex().mutation(api.rooms.create, { key: clientKey() })),
          },
          'Create private room',
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => void go(() => convex().mutation(api.rooms.quickMatch, { key: clientKey() })),
          },
          'Quick match',
        ),
      ),
      h(
        'div',
        { class: 'row' },
        codeIn,
        h('button', { class: 'btn', onclick: () => void join(codeIn.value) }, 'Join'),
      ),
      status,
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => hnd.onBack() }, 'Back')),
    ),
  );
  const go = async (fn: () => Promise<{ code: string; role: 'host' | 'guest' }>) => {
    if (!backendAvailable()) {
      status.textContent = 'Online backend not configured.';
      return;
    }
    status.textContent = 'Connecting…';
    try {
      await ensurePlayer();
      const r = await fn();
      hnd.onRoom(r.code, r.role);
    } catch (e) {
      status.textContent = (e as Error).message.replace(/^.*Uncaught Error: /s, '').split('\n')[0] ?? 'Error';
    }
  };
  const join = (code: string) =>
    go(() => convex().mutation(api.rooms.join, { key: clientKey(), code: code.trim().toUpperCase() }));
  if (initialCode) void join(initialCode);
  return { el, dispose: () => {} };
}

/** Waiting room shown to the host with the shareable link and QR code. */
export function waitingRoom(
  code: string,
  role: 'host' | 'guest',
  onCancel: () => void,
): Screen & { setStatus: (s: string) => void } {
  const link = `${location.origin}/?room=${code}`;
  const qr = h('canvas');
  void QRCode.toCanvas(qr, link, { width: 360, margin: 1 });
  const status = h(
    'div',
    { class: 'muted' },
    role === 'host' ? 'Waiting for your opponent…' : 'Connecting to host…',
  );
  const copy = h('button', { class: 'btn' }, 'Copy link');
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(link);
    copy.textContent = 'Copied!';
  });
  const el = h(
    'div',
    { class: 'screen' },
    h(
      'div',
      {
        class: 'panel',
        style: 'text-align:center;display:flex;flex-direction:column;gap:14px;align-items:center',
      },
      h('div', { class: 'small muted', style: 'letter-spacing:0.2em' }, 'ROOM'),
      h('div', { class: 'code', 'data-testid': 'room-code' }, code),
      h('div', { class: 'qr' }, qr),
      h('div', { class: 'small muted', style: 'user-select:text' }, link),
      h(
        'div',
        { class: 'row' },
        copy,
        navigator.share
          ? h(
              'button',
              {
                class: 'btn',
                onclick: () =>
                  void navigator
                    .share({ title: 'Couch Arena', text: 'Box me in Couch Arena!', url: link })
                    .catch(() => {}),
              },
              'Share',
            )
          : null,
      ),
      status,
      h('button', { class: 'btn', onclick: () => onCancel() }, 'Cancel'),
    ),
  );
  return { el, dispose: () => {}, setStatus: (s) => (status.textContent = s) };
}
