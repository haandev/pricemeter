/**
 * Calendar helpers for period keys and windows: feed them into `ctx.periods` and `integrate()`'s `window`.
 * The core never reads a calendar; this module is where it lives (A72).
 */

/** Key for "no period": lifetime counters (`tierPeriod: "lifetime"`). */
export const LIFETIME = "*";

export interface Window {
  /** Inclusive, epoch ms. */
  from: number;
  /** Exclusive, epoch ms. */
  to: number;
}

interface Parts {
  y: number;
  m: number; // 1-12
  d: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Offset of `tz` from UTC at instant `ms`, in ms (UTC+3 → +10_800_000). */
function offset(ms: number, tz: string): number {
  if (tz === "UTC") return 0;
  const p: Record<string, number> = {};
  for (const x of formatter(tz).formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function localDate(ms: number, tz: string): Parts {
  const t = new Date(ms + offset(ms, tz));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * UTC instant of the start of local day `y-m-d` in `tz`: local midnight, or — where DST skips midnight
 * (e.g. America/Santiago) — the first instant that is on that day.
 */
function midnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  const a = guess - offset(guess, tz);
  const b = guess - offset(a, tz);
  const onDay = (t: number) => {
    const p = localDate(t, tz);
    return p.y === y && p.m === m && p.d === d;
  };
  const candidates = [a, b].filter(onDay).sort((x, z) => x - z);
  return candidates[0] ?? Math.max(a, b);
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");
const addMonths = (y: number, m: number, k: number): [number, number] => {
  const i = y * 12 + (m - 1) + k;
  return [Math.floor(i / 12), (i % 12) + 1];
};

function assertAt(at: number) {
  if (!Number.isFinite(at)) throw new RangeError(`at must be epoch milliseconds, got ${at}`);
}

/** Calendar month of `at` in `tz` (default UTC): `"2026-09"`. */
export function monthKey(i: { at: number; tz?: string }): string {
  assertAt(i.at);
  const p = localDate(i.at, i.tz ?? "UTC");
  return `${p.y}-${pad(p.m)}`;
}

/** The calendar month containing `at`, as a half-open window. */
export function monthWindow(i: { at: number; tz?: string }): Window {
  assertAt(i.at);
  const tz = i.tz ?? "UTC";
  const p = localDate(i.at, tz);
  const [ny, nm] = addMonths(p.y, p.m, 1);
  return { from: midnight(p.y, p.m, 1, tz), to: midnight(ny, nm, 1, tz) };
}

/**
 * Monthly billing cycle anchored on `anchor`'s day of month (a cycle started on the 31st renews on the
 * last day of shorter months). Returns the cycle containing `at`.
 */
export function cycleWindow(i: { at: number; anchor: number; tz?: string }): Window {
  assertAt(i.at);
  assertAt(i.anchor);
  const tz = i.tz ?? "UTC";
  const day = localDate(i.anchor, tz).d;
  const startOf = (y: number, m: number) => midnight(y, m, Math.min(day, daysIn(y, m)), tz);
  const p = localDate(i.at, tz);
  let [y, m] = [p.y, p.m];
  if (i.at < startOf(y, m)) [y, m] = addMonths(y, m, -1);
  const [ny, nm] = addMonths(y, m, 1);
  return { from: startOf(y, m), to: startOf(ny, nm) };
}

/** Key of the billing cycle containing `at`: its local start date, `"2026-09-15"`. */
export function cycleKey(i: { at: number; anchor: number; tz?: string }): string {
  const w = cycleWindow(i);
  const p = localDate(w.from, i.tz ?? "UTC");
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
