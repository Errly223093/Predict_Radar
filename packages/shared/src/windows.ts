import { WINDOW_TO_MINUTES, WINDOWS, type WindowKey } from "./types.js";

export function clampProbability(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function toPp(probabilityDelta: number): number {
  return Math.round(probabilityDelta * 10000) / 100;
}

export function getWindowMinutes(window: WindowKey): number {
  return WINDOW_TO_MINUTES[window];
}

export function getWindowKeys(): readonly WindowKey[] {
  return WINDOWS;
}
