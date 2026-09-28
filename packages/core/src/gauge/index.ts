import { ceilClean } from "../util.js";

/**
 * Turns level samples (seats, GB, instances) into one observation quantity.
 * The samples live in your application; this is pure arithmetic over them.
 */

export interface Sample {
  /** Epoch ms from which `value` holds, until the next sample. */
  at: number;
  value: number;
}

export interface Window {
  /** Inclusive, epoch ms. */
  from: number;
  /** Exclusive, epoch ms. */
  to: number;
}

/** Builds a half-open window `[from, to)`; throws when it is empty or not finite. */
export function window(i: { from: number; to: number }): Window {
  if (!Number.isFinite(i.from) || !Number.isFinite(i.to) || i.to <= i.from) {
    throw new RangeError(`window needs from < to, got [${i.from}, ${i.to})`);
  }
  return { from: i.from, to: i.to };
}

export interface IntegrateInput {
  /** Level changes, in any order. The level before the first sample is 0. */
  samples: readonly Sample[];
  window: Window;
  /**
   * `last`: level at the end of the window. `max`: highest level during the window.
   * `time_weighted`: level × time (e.g. seat-seconds), for proration with `per`.
   */
  mode: "last" | "max" | "time_weighted";
  /** Time unit for `time_weighted`. Default `"s"`. */
  unit?: "ms" | "s" | "h";
}

const unitMs = { ms: 1, s: 1000, h: 3_600_000 } as const;

/**
 * Integrates a step function over a window and returns an integer quantity (rounded up), ready for
 * `observe(meter, dims, quantity, …)`. Samples before the window set the starting level.
 */
export function integrate(i: IntegrateInput): number {
  const w = window(i.window);
  const sorted = [...i.samples].sort((a, b) => a.at - b.at);
  for (const s of sorted) if (!Number.isFinite(s.value) || s.value < 0) throw new RangeError(`sample value must be ≥ 0, got ${s.value}`);

  let level = 0;
  let k = 0;
  while (k < sorted.length && sorted[k]!.at <= w.from) level = sorted[k++]!.value;

  let max = level;
  let area = 0;
  let t = w.from;
  for (; k < sorted.length && sorted[k]!.at < w.to; k++) {
    const s = sorted[k]!;
    area += level * (s.at - t);
    t = s.at;
    level = s.value;
    if (level > max) max = level;
  }
  area += level * (w.to - t);

  const out = i.mode === "last" ? level : i.mode === "max" ? max : area / unitMs[i.unit ?? "s"];
  return ceilClean(out);
}
