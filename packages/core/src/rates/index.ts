/**
 * An optional layered price table: scopes (account > plan > list), wildcard dimensions,
 * `effectiveFrom` versions and removals. Produces a ready `getRate`. Use it, or write your own.
 */
import type { RateAnswer } from "../catalog.js";
import { validateRate, type Rate, type RateIssue, type RatePolicy } from "../rate.js";

/** One row of the price table. */
export interface PriceVersion {
  id: string;
  meter: string;
  /** e.g. `"list"`, `"plan:pro"`, `"account:acc_1"`. Meaning comes from your `scopes()` order. */
  scope: string;
  /** Matching dimensions. A missing key or `"*"` matches anything. */
  dims?: Record<string, string | number | boolean>;
  /** Epoch ms from which this version applies. */
  effectiveFrom: number;
  /** Ends this scope's price for matching dims: resolution falls through to the next scope. */
  removed?: boolean;
  /** Required unless `removed`. */
  rate?: Rate;
}

export type VersionIssue = RateIssue | { code: "invalid_version"; path: (string | number)[]; message: string };

/** Checks a price row, including its rate. */
export function validateVersion(v: unknown): { ok: true; version: PriceVersion } | { ok: false; errors: VersionIssue[] } {
  const errors: VersionIssue[] = [];
  const err = (path: (string | number)[], message: string) => errors.push({ code: "invalid_version", path, message });
  if (typeof v !== "object" || v === null) return { ok: false, errors: [{ code: "invalid_version", path: [], message: "version must be an object" }] };
  const x = v as Record<string, unknown>;
  for (const k of ["id", "meter", "scope"] as const) if (typeof x[k] !== "string" || !x[k]) err([k], `${k} must be a non-empty string`);
  if (typeof x.effectiveFrom !== "number" || !Number.isFinite(x.effectiveFrom)) err(["effectiveFrom"], "effectiveFrom must be epoch ms");
  if (x.dims !== undefined) {
    if (typeof x.dims !== "object" || x.dims === null) err(["dims"], "dims must be an object");
    else
      for (const [k, d] of Object.entries(x.dims))
        if (!["string", "number", "boolean"].includes(typeof d)) err(["dims", k], "dimension values must be string, number or boolean");
  }
  if (x.removed !== undefined && typeof x.removed !== "boolean") err(["removed"], "removed must be a boolean");
  if (x.removed !== true) {
    const r = validateRate(x.rate);
    if (!r.ok) errors.push(...r.errors.map((e) => ({ ...e, path: ["rate", ...e.path] })));
  }
  return errors.length ? { ok: false, errors } : { ok: true, version: v as PriceVersion };
}

function matches(v: PriceVersion, dims: Record<string, unknown>): number {
  let specific = 0;
  for (const [k, want] of Object.entries(v.dims ?? {})) {
    if (want === "*") continue;
    if (dims[k] !== want) return -1;
    specific++;
  }
  return specific;
}

/**
 * Picks the tariff for `dims` at `at`. Scopes are tried in order; inside a scope the most specific
 * matching row wins, then the latest `effectiveFrom`. A winning `removed` row falls through to the next scope.
 */
export function resolveLayered(i: { rows: readonly PriceVersion[]; scopes: readonly string[]; dims: Record<string, unknown>; at: number; meter?: string }): Rate | null {
  for (const scope of i.scopes) {
    let best: PriceVersion | undefined;
    let bestSpec = -1;
    for (const v of i.rows) {
      if (v.scope !== scope || v.effectiveFrom > i.at) continue;
      if (i.meter !== undefined && v.meter !== i.meter) continue;
      const s = matches(v, i.dims);
      if (s < 0) continue;
      if (s > bestSpec || (s === bestSpec && v.effectiveFrom >= best!.effectiveFrom)) {
        best = v;
        bestSpec = s;
      }
    }
    if (!best || best.removed) continue;
    return best.rate!.id === undefined ? { ...best.rate!, id: best.id } : best.rate!;
  }
  return null;
}

type Awaitable<T> = T | Promise<T>;

export interface LayeredRatesOptions<C extends { accountId: string }> {
  /** Rows for a meter (all scopes the context can see). */
  loadRows: (meter: string, ctx: C) => Awaitable<readonly PriceVersion[]>;
  /** Scope order for this context, most specific first: `["account:a1", "plan:pro", "list"]`. */
  scopes: (ctx: C) => readonly string[];
  /** Cache loaded rows per (meter, scopes) for this long. Default 0 (no cache). */
  cacheMs?: number;
  /** Supplies `usedSoFar` for the resolved rate (e.g. from your counters). */
  usedSoFar?: (meter: string, dims: Record<string, unknown>, ctx: C, at: number, rate: Rate) => Awaitable<number | undefined>;
  /** Clock for the cache. Default `Date.now`. */
  now?: () => number;
}

/** A ready `getRate` over a layered price table. */
export function layeredRates<C extends { accountId: string }>(o: LayeredRatesOptions<C>) {
  const cache = new Map<string, { until: number; rows: Promise<readonly PriceVersion[]> }>();
  const now = o.now ?? Date.now;
  return async (meter: string, dims: any, ctx: C, at: number): Promise<RateAnswer | null> => {
    const scopes = o.scopes(ctx);
    const key = `${meter}\u0000${scopes.join("\u0000")}`;
    let hit = o.cacheMs ? cache.get(key) : undefined;
    if (!hit || hit.until <= now()) {
      hit = { until: now() + (o.cacheMs ?? 0), rows: Promise.resolve(o.loadRows(meter, ctx)) };
      if (o.cacheMs) cache.set(key, hit);
    }
    const rate = resolveLayered({ rows: await hit.rows, scopes, dims: dims ?? {}, at, meter });
    if (!rate) return null;
    const answer: RateAnswer = { rate };
    if (o.usedSoFar) {
      const u = await o.usedSoFar(meter, dims ?? {}, ctx, at, rate);
      if (u !== undefined) answer.usedSoFar = u;
    }
    return answer;
  };
}

const scale = (n: number, f: number) => Math.round(n * f);

/** Takes `percent` off every unit price and flat fee (rounded to the nearest micro-unit). */
export function applyDiscount(i: { rate: Rate; percent: number }): Rate {
  if (!(i.percent >= 0 && i.percent <= 100)) throw new RangeError(`percent must be in [0, 100], got ${i.percent}`);
  const f = 1 - i.percent / 100;
  const out: Rate = {
    ...i.rate,
    tiers: i.rate.tiers.map((t) => {
      const tier = { ...t, unitPriceMicroUsd: scale(t.unitPriceMicroUsd, f) };
      if (t.flatMicroUsd !== undefined) tier.flatMicroUsd = scale(t.flatMicroUsd, f);
      return tier;
    }),
  };
  if (i.rate.id !== undefined) out.id = `${i.rate.id}-${i.percent}pct`;
  return out;
}

/** Multiplies tier thresholds (`from`) by `factor`: an enterprise account reaches cheaper tiers later or sooner. */
export function scaleTiers(i: { rate: Rate; factor: number }): Rate {
  if (!(i.factor > 0)) throw new RangeError(`factor must be > 0, got ${i.factor}`);
  return { ...i.rate, tiers: i.rate.tiers.map((t) => ({ ...t, from: Math.round(t.from * i.factor) })) };
}

/** Overrides policy fields (rounding, clamps…) on a rate. */
export function withPolicy(i: { rate: Rate; policy: RatePolicy }): Rate {
  return { ...i.rate, policy: { ...i.rate.policy, ...i.policy } };
}
