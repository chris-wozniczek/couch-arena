/**
 * Synthesized sound design (no audio assets): punch impacts, blocks, whooshes, crowd bed + cheers, ring
 * bell, and announcer lines via SpeechSynthesis. All game audio also feeds `recordStream` for clips.
 */
import type { PunchType } from '../core/types';

export class Sound {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private crowdGain!: GainNode;
  private crowdFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private dest!: MediaStreamAudioDestinationNode;
  private voice: SpeechSynthesisVoice | null = null;
  muted = false;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.dest = ctx.createMediaStreamDestination();
    comp.connect(this.dest);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    // Pink-ish noise.
    let b0 = 0,
      b1 = 0,
      b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029591;
      b1 = 0.985 * b1 + w * 0.032534;
      b2 = 0.95 * b2 + w * 0.048056;
      d[i] = (b0 + b1 + b2 + w * 0.1) * 0.9;
    }
    this.startCrowd();
    const pickVoice = () => {
      const vs = speechSynthesis.getVoices();
      this.voice =
        vs.find((v) => /Daniel|Alex|Fred|Google UK English Male/i.test(v.name)) ??
        vs.find((v) => v.lang.startsWith('en')) ??
        null;
    };
    if ('speechSynthesis' in window) {
      pickVoice();
      speechSynthesis.onvoiceschanged = pickVoice;
    }
  }

  get recordStream(): MediaStream | null {
    return this.ctx ? this.dest.stream : null;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  private src(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    return s;
  }

  private startCrowd(): void {
    const ctx = this.ctx!;
    const s = this.src();
    this.crowdFilter = ctx.createBiquadFilter();
    this.crowdFilter.type = 'bandpass';
    this.crowdFilter.frequency.value = 900;
    this.crowdFilter.Q.value = 0.6;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.12;
    // Slow murmur modulation.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.35;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.03;
    lfo.connect(lfoGain).connect(this.crowdGain.gain);
    s.connect(this.crowdFilter).connect(this.crowdGain).connect(this.master);
    s.start();
    lfo.start();
  }

  /** Crowd intensity 0..1. */
  crowd(level: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.crowdGain.gain.setTargetAtTime(0.08 + level * 0.28, t, 0.4);
    this.crowdFilter.frequency.setTargetAtTime(700 + level * 900, t, 0.4);
  }

  cheer(strength = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = this.src();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1400;
    f.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35 * strength, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.4);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random());
    s.stop(t + 2.5);
  }

  /** Glove impact: a body thump + leather slap. */
  impact(type: PunchType, strength: number, blocked: boolean): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    const base = blocked ? 180 : type === 'jab' ? 120 : 90;
    o.frequency.setValueAtTime(base * 1.8, t);
    o.frequency.exponentialRampToValueAtTime(base * 0.5, t + 0.12);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.9 * strength, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + (blocked ? 0.1 : 0.22));
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.3);
    const n = this.src();
    const f = ctx.createBiquadFilter();
    f.type = blocked ? 'highpass' : 'lowpass';
    f.frequency.value = blocked ? 1800 : 2600;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.8 * strength, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + (blocked ? 0.06 : 0.09));
    n.connect(f).connect(ng).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 0.12);
  }

  whoosh(speed = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = this.src();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(1800 + speed * 400, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    n.connect(f).connect(g).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 0.2);
  }

  /** Boxing bell: inharmonic partials with long decay. */
  bell(times = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    for (let k = 0; k < times; k++) {
      const t = ctx.currentTime + k * 0.32;
      for (const [ratio, amp] of [
        [1, 0.5],
        [2.76, 0.3],
        [5.4, 0.18],
        [8.93, 0.1],
      ] as const) {
        const o = ctx.createOscillator();
        o.frequency.value = 820 * ratio;
        const g = ctx.createGain();
        g.gain.setValueAtTime(amp * 0.5, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6 / ratio + 0.3);
        o.connect(g).connect(this.master);
        o.start(t);
        o.stop(t + 2);
      }
    }
  }

  tick(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.frequency.value = 1200;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.08);
  }

  announce(text: string, urgent = false): void {
    if (this.muted || !('speechSynthesis' in window)) return;
    if (urgent) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.pitch = 0.7;
    u.rate = 1.05;
    u.volume = 1;
    speechSynthesis.speak(u);
  }
}

export const sound = new Sound();
