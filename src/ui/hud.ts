/** Fight HUD: health/stamina bars, knockdown pips, round clock, combo meter, callouts and hit feed. */
import { fmtClock, h } from './dom';

interface Side {
  name: HTMLDivElement;
  fill: HTMLDivElement;
  ghost: HTMLDivElement;
  stam: HTMLDivElement;
  kd: HTMLDivElement;
  combo: HTMLDivElement;
  comboN: HTMLDivElement;
}

export class FightHud {
  el: HTMLDivElement;
  private sides: [Side, Side];
  private time: HTMLDivElement;
  private round: HTMLDivElement;
  private callout: HTMLDivElement;
  private feed: HTMLDivElement;
  private defense: HTMLDivElement;
  private comboTimers: [number, number] = [0, 0];

  constructor(root: HTMLElement, names: [string, string], opts: { showSecondCombo?: boolean } = {}) {
    const mk = (i: 0 | 1): [HTMLDivElement, Side] => {
      const fill = h('div', { class: 'fill', style: 'width:100%' });
      const ghost = h('div', { class: 'ghost', style: 'width:100%' });
      const stamFill = h('div', { class: 'fill', style: 'width:100%' });
      const kd = h('div', { class: 'kd' }, h('i'), h('i'), h('i'));
      const name = h('div', { class: 'name' }, names[i]);
      const comboN = h('div', { class: 'n' }, '0');
      const combo = h(
        'div',
        { class: `combo ${i === 1 ? 'right' : ''}` },
        comboN,
        h('div', { class: 'l' }, 'HIT COMBO'),
      );
      const bar = h(
        'div',
        { class: `bar ${i === 1 ? 'right' : ''} ${i === 0 ? 'blue' : ''}` },
        name,
        h('div', { class: 'meter' }, ghost, fill),
        h('div', { class: 'meter stam' }, stamFill),
        kd,
      );
      return [bar, { name, fill, ghost, stam: stamFill, kd, combo, comboN }];
    };
    const [b0, s0] = mk(0);
    const [b1, s1] = mk(1);
    this.sides = [s0, s1];
    this.time = h('div', { class: 'time' }, '1:30');
    this.round = h('div', { class: 'round' }, 'ROUND 1');
    this.callout = h('div', { class: 'callout' });
    this.feed = h('div', { class: 'feed' });
    this.defense = h('div', { class: 'defense' });
    this.el = h(
      'div',
      { class: 'hud' },
      h('div', { class: 'top' }, b0, h('div', { class: 'clock' }, this.round, this.time), b1),
      this.callout,
      s0.combo,
      opts.showSecondCombo ? s1.combo : null,
      this.feed,
      this.defense,
    );
    root.append(this.el);
  }

  setNames(names: [string, string]): void {
    this.sides[0].name.textContent = names[0];
    this.sides[1].name.textContent = names[1];
  }

  update(state: {
    health: [number, number];
    stamina: [number, number];
    knockdowns: [number, number];
    clockMs: number;
    round: number;
    rounds: number;
    label?: string;
  }): void {
    for (const i of [0, 1] as const) {
      const s = this.sides[i];
      s.fill.style.width = `${Math.max(0, state.health[i])}%`;
      s.ghost.style.width = `${Math.max(0, state.health[i])}%`;
      s.stam.style.width = `${Math.max(0, state.stamina[i])}%`;
      [...s.kd.children].forEach((c, k) => c.classList.toggle('on', k < state.knockdowns[i]));
    }
    this.time.textContent = fmtClock(state.clockMs);
    this.round.textContent = state.label ?? `ROUND ${state.round}/${state.rounds}`;
  }

  combo(i: 0 | 1, n: number): void {
    const s = this.sides[i];
    clearTimeout(this.comboTimers[i]);
    if (n < 2) {
      s.combo.classList.remove('on');
      return;
    }
    s.comboN.textContent = String(n);
    s.combo.classList.add('on');
    this.comboTimers[i] = window.setTimeout(() => s.combo.classList.remove('on'), 1300);
  }

  call(text: string, gold = false): void {
    const c = this.callout;
    c.textContent = text;
    c.className = `callout ${gold ? 'gold' : ''}`;
    void c.offsetWidth;
    c.classList.add('show');
  }

  chip(text: string, kind: 'landed' | 'blocked' | 'evaded' | 'info' = 'info'): void {
    const el = h('div', { class: `chip ${kind}` }, text);
    this.feed.append(el);
    while (this.feed.children.length > 4) this.feed.firstChild?.remove();
    setTimeout(() => el.remove(), 1700);
  }

  setDefense(text: string): void {
    this.defense.textContent = text;
    this.defense.classList.toggle('on', !!text);
  }

  /** Pulses the defense badge when an incoming punch is absorbed by the guard. */
  blocked(): void {
    const d = this.defense;
    d.classList.remove('absorb');
    void d.offsetWidth;
    d.classList.add('absorb');
  }

  destroy(): void {
    this.el.remove();
  }
}
