/** Shared services handed to every game mode. */
import type { Sound } from '../audio/sound';
import type { MatchSummary } from '../core/scoring';
import type { DebugHud } from '../ui/debug';
import type { Clip, HighlightRecorder } from '../ui/recorder';
import type { InputHub } from './input';
import type { FrameInfo, World } from './world';

export interface Mode {
  readonly id: string;
  start(): Promise<void>;
  update(f: FrameInfo): void;
  stop(): void;
}

export interface ResultInfo {
  title: string;
  subtitle: string;
  stats: Array<[string, string]>;
  summary?: MatchSummary;
  ticket?: string | null;
  clip?: Clip | null;
  again: () => void;
}

export interface GameContext {
  world: World;
  input: InputHub;
  sound: Sound;
  debug: DebugHud;
  recorder: HighlightRecorder;
  /** Overlay root for HUD elements. */
  hudRoot: HTMLElement;
  showResults(r: ResultInfo): void;
  toMenu(): void;
  toast(text: string): void;
}
