/**
 * `ceil` that ignores float noise: `50 × 1.1` is 55, not 56. Only values within a relative 1e-9 of an
 * integer are snapped, so large exact values (1_234_567_890_123) stay exact.
 */
export function ceilClean(x: number): number {
  const r = Math.round(x);
  return Math.abs(x - r) <= 1e-9 * Math.max(1, Math.abs(x)) ? r : Math.ceil(x);
}

/** Pool units for `q` feeder units at weight `w`. */
export const poolQuantity = (q: number, w: number): number => ceilClean(q * w);

/** Canonical JSON: sorted keys, `undefined` dropped, so equal dims compare equal as strings. */
export function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}
