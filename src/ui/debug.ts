/**
 * Debug / performance HUD (toggle with `D` or the gear button): render fps, tracking fps + inference ms,
 * pipeline delay, estimated end-to-end latency, JS heap, quality tier, and a flash test for measuring
 * true motion-to-photon latency with a phone slow-mo camera.
 */
import { h } from './dom';

export interface DebugSource {
  renderFps: () => number;
  frameMs: () => number;
  tracking: () => { fps: number; inferenceMs: number; pipelineMs: number; backend: string } | null;
  engine: () => { backend: string; tier: string };
  latencyMs: () => number;
  net?: () => { rtt: number; relay: boolean; state: string } | null;
}

export class DebugHud {
  el: HTMLDivElement;
  private text: HTMLDivElement;
  private graph: HTMLCanvasElement;
  private hist: number[] = [];
  visible = false;
  showSkeleton = true;
  private flashEl: HTMLDivElement | null = null;
  private flashStart = 0;
  onToggleSkeleton: ((on: boolean) => void) | null = null;
  lastPunchLatency = 0;

  constructor(
    root: HTMLElement,
    private src: DebugSource,
  ) {
    this.text = h('div');
    this.graph = h('canvas', { class: 'graph', width: 230, height: 40 });
    this.el = h(
      'div',
      { class: 'debug hidden' },
      this.text,
      this.graph,
      h(
        'div',
        { class: 'row', style: 'justify-content:flex-start;margin-top:6px;gap:6px' },
        h(
          'button',
          { class: 'btn small', style: 'padding:4px 8px', onclick: () => this.flashTest() },
          'Flash test',
        ),
        h(
          'button',
          {
            class: 'btn small',
            style: 'padding:4px 8px',
            onclick: () => {
              this.showSkeleton = !this.showSkeleton;
              this.onToggleSkeleton?.(this.showSkeleton);
            },
          },
          'Skeleton',
        ),
      ),
    );
    root.append(this.el);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'd' && !(e.target instanceof HTMLInputElement)) this.toggle();
    });
    setInterval(() => this.refresh(), 250);
  }

  toggle(on = !this.visible): void {
    this.visible = on;
    this.el.classList.toggle('hidden', !on);
  }

  /**
   * Flash test: flashes the screen white and starts a timer; a punch detected by the tracker after the
   * flash reports reaction+pipeline time. For true glass-to-glass latency, film the screen and your fist
   * with a 240 fps phone camera and count frames between fist motion and the on-screen glove motion.
   */
  flashTest(): void {
    this.flashEl?.remove();
    this.flashEl = h('div', { class: 'flash' });
    document.body.append(this.flashEl);
    this.flashStart = performance.now();
    setTimeout(() => this.flashEl?.remove(), 80);
  }

  /** Called when any punch is recognized; closes an open flash test. */
  onPunch(recognizedAt: number): void {
    if (this.flashStart && recognizedAt > this.flashStart && recognizedAt - this.flashStart < 2000) {
      this.lastPunchLatency = recognizedAt - this.flashStart;
      this.flashStart = 0;
    }
  }

  private refresh(): void {
    const fps = this.src.renderFps();
    this.hist.push(this.src.frameMs());
    if (this.hist.length > 115) this.hist.shift();
    if (!this.visible) return;
    const t = this.src.tracking();
    const e = this.src.engine();
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const net = this.src.net?.();
    const rows = [
      `render <b>${fps.toFixed(0)} fps</b> (${this.src.frameMs().toFixed(1)} ms) ${e.backend} · ${e.tier}`,
      t
        ? `track <b>${t.fps.toFixed(0)} fps</b> · infer <b>${t.inferenceMs.toFixed(1)} ms</b> · ${t.backend}`
        : 'track —',
      t ? `capture→result <b>${t.pipelineMs.toFixed(0)} ms</b>` : '',
      `est. punch→screen <b>${this.src.latencyMs().toFixed(0)} ms</b> (after prediction)`,
      mem ? `heap <b>${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB</b>` : '',
      this.lastPunchLatency
        ? `flash→punch <b>${this.lastPunchLatency.toFixed(0)} ms</b> (incl. reaction)`
        : '',
      net ? `net <b>${net.state}</b> rtt ${net.rtt.toFixed(0)} ms${net.relay ? ' (TURN relay)' : ''}` : '',
    ].filter(Boolean);
    this.text.innerHTML = rows.join('<br>');
    const g = this.graph.getContext('2d')!;
    g.clearRect(0, 0, 230, 40);
    g.strokeStyle = 'rgba(255,255,255,0.2)';
    g.beginPath();
    g.moveTo(0, 40 - 16.7);
    g.lineTo(230, 40 - 16.7);
    g.stroke();
    g.strokeStyle = '#3ddc84';
    g.beginPath();
    this.hist.forEach((v, i) =>
      i ? g.lineTo(i * 2, 40 - Math.min(40, v)) : g.moveTo(0, 40 - Math.min(40, v)),
    );
    g.stroke();
  }
}
