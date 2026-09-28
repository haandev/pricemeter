import type { MicroUsd } from "./money.js";
import { add, ceil, cmp, floor, frac, fromCarry, mulInt, q, sub, toCarry, toNumber, ZERO, type Q } from "./rational.js";

export type RateModel = "graduated" | "volume" | "package";

export interface Tier {
  /** First unit position (0-based) this tier applies to. The first tier starts at 0. */
  from: number;
  /** Price per `per` units (per block for `package`). */
  unitPriceMicroUsd: number;
  /** Price denominator; `per: 1_000_000` prices per million. Default 1. */
  per?: number;
  /** Added once, the first time usage enters this tier. */
  flatMicroUsd?: number;
}

export interface RatePolicy {
  /** `per_event_up` rounds each observation up; `cumulative` rounds the running total so the period sum never drifts. */
  rounding?: "per_event_up" | "cumulative";
  /** Volume only: `on_crossing` emits a (usually negative) adjustment for earlier units when a tier is crossed. */
  adjustmentTiming?: "on_crossing" | "none";
  /** Clamp for a single observation's charge (adjustments are not clamped). */
  perObservation?: { minMicroUsd?: number; maxMicroUsd?: number };
  /** Which period key `usedSoFar` belongs to. A hint for `getRate`; the library does not read it. */
  tierPeriod?: string;
}

export interface Rate {
  model: RateModel;
  tiers: Tier[];
  /** Package only: units per block. */
  packageSize?: number;
  policy?: RatePolicy;
  /** Written to usage rows so each row can be traced to the tariff that priced it. */
  id?: string;
}

declare const validRateBrand: unique symbol;
/** A `Rate` that passed `validateRate`. Frozen. */
export type ValidRate = Readonly<Rate> & { readonly [validRateBrand]: true };

export type RateIssueCode =
  | "invalid_shape"
  | "invalid_model"
  | "empty_tiers"
  | "first_tier_from"
  | "invalid_from"
  | "tiers_not_increasing"
  | "invalid_price"
  | "invalid_per"
  | "invalid_flat"
  | "invalid_package_size"
  | "package_size_not_allowed"
  | "adjustment_timing_not_allowed"
  | "invalid_policy"
  | "min_gt_max";

export interface RateIssue {
  code: RateIssueCode;
  path: (string | number)[];
  message: string;
}

export type RateValidation = { ok: true; rate: ValidRate } | { ok: false; errors: RateIssue[] };

const isNonNegInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

/**
 * Checks a raw tariff object and returns a frozen, branded copy.
 * `getRate` may return raw objects (the library validates them); callers of `price()` must pass a `ValidRate`.
 */
export function validateRate(input: unknown): RateValidation {
  const errors: RateIssue[] = [];
  const err = (code: RateIssueCode, path: (string | number)[], message: string) => errors.push({ code, path, message });

  if (typeof input !== "object" || input === null) {
    err("invalid_shape", [], "rate must be an object");
    return { ok: false, errors };
  }
  const r = input as Record<string, unknown>;
  const model = r.model;
  if (model !== "graduated" && model !== "volume" && model !== "package") {
    err("invalid_model", ["model"], `model must be "graduated", "volume" or "package", got ${JSON.stringify(model)}`);
  }
  if (!Array.isArray(r.tiers) || r.tiers.length === 0) {
    err("empty_tiers", ["tiers"], "tiers must be a non-empty array");
  } else {
    let prev = -1;
    r.tiers.forEach((t: unknown, i: number) => {
      if (typeof t !== "object" || t === null) return err("invalid_shape", ["tiers", i], "tier must be an object");
      const tier = t as Record<string, unknown>;
      if (!isNonNegInt(tier.from)) err("invalid_from", ["tiers", i, "from"], "from must be a non-negative integer");
      else {
        if (i === 0 && tier.from !== 0) err("first_tier_from", ["tiers", 0, "from"], "the first tier must start at 0");
        if (i > 0 && tier.from <= prev) err("tiers_not_increasing", ["tiers", i, "from"], "tier `from` values must be strictly increasing");
        prev = tier.from;
      }
      if (!isNonNegInt(tier.unitPriceMicroUsd))
        err("invalid_price", ["tiers", i, "unitPriceMicroUsd"], "unitPriceMicroUsd must be a non-negative integer");
      if (tier.per !== undefined && !(isNonNegInt(tier.per) && tier.per >= 1))
        err("invalid_per", ["tiers", i, "per"], "per must be an integer ≥ 1");
      if (tier.flatMicroUsd !== undefined && !isNonNegInt(tier.flatMicroUsd))
        err("invalid_flat", ["tiers", i, "flatMicroUsd"], "flatMicroUsd must be a non-negative integer");
    });
  }
  if (model === "package") {
    if (!(isNonNegInt(r.packageSize) && r.packageSize >= 1))
      err("invalid_package_size", ["packageSize"], "package rates need packageSize ≥ 1");
  } else if (r.packageSize !== undefined) {
    err("package_size_not_allowed", ["packageSize"], "packageSize is only allowed on package rates");
  }
  if (r.id !== undefined && typeof r.id !== "string") err("invalid_shape", ["id"], "id must be a string");
  if (r.policy !== undefined) {
    if (typeof r.policy !== "object" || r.policy === null) err("invalid_policy", ["policy"], "policy must be an object");
    else {
      const p = r.policy as Record<string, unknown>;
      if (p.rounding !== undefined && p.rounding !== "per_event_up" && p.rounding !== "cumulative")
        err("invalid_policy", ["policy", "rounding"], 'rounding must be "per_event_up" or "cumulative"');
      if (p.adjustmentTiming !== undefined) {
        if (p.adjustmentTiming !== "on_crossing" && p.adjustmentTiming !== "none")
          err("invalid_policy", ["policy", "adjustmentTiming"], 'adjustmentTiming must be "on_crossing" or "none"');
        else if (model !== "volume")
          err("adjustment_timing_not_allowed", ["policy", "adjustmentTiming"], "adjustmentTiming is only allowed on volume rates");
      }
      if (p.tierPeriod !== undefined && typeof p.tierPeriod !== "string")
        err("invalid_policy", ["policy", "tierPeriod"], "tierPeriod must be a string");
      if (p.perObservation !== undefined) {
        const po = p.perObservation as Record<string, unknown> | null;
        if (typeof po !== "object" || po === null) err("invalid_policy", ["policy", "perObservation"], "perObservation must be an object");
        else {
          if (po.minMicroUsd !== undefined && !isNonNegInt(po.minMicroUsd))
            err("invalid_policy", ["policy", "perObservation", "minMicroUsd"], "minMicroUsd must be a non-negative integer");
          if (po.maxMicroUsd !== undefined && !isNonNegInt(po.maxMicroUsd))
            err("invalid_policy", ["policy", "perObservation", "maxMicroUsd"], "maxMicroUsd must be a non-negative integer");
          if (isNonNegInt(po.minMicroUsd) && isNonNegInt(po.maxMicroUsd) && po.minMicroUsd > po.maxMicroUsd)
            err("min_gt_max", ["policy", "perObservation"], "minMicroUsd must be ≤ maxMicroUsd");
        }
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, rate: freezeRate(r as unknown as Rate) };
}

function freezeRate(r: Rate): ValidRate {
  const copy: Rate = {
    model: r.model,
    tiers: r.tiers.map((t) => {
      const tier: Tier = { from: t.from, unitPriceMicroUsd: t.unitPriceMicroUsd };
      if (t.per !== undefined) tier.per = t.per;
      if (t.flatMicroUsd !== undefined) tier.flatMicroUsd = t.flatMicroUsd;
      return Object.freeze(tier);
    }),
  };
  if (r.packageSize !== undefined) copy.packageSize = r.packageSize;
  if (r.id !== undefined) copy.id = r.id;
  if (r.policy !== undefined) {
    const p: RatePolicy = { ...r.policy };
    if (p.perObservation) p.perObservation = Object.freeze({ ...p.perObservation });
    copy.policy = Object.freeze(p);
  }
  Object.freeze(copy.tiers);
  return Object.freeze(copy) as ValidRate;
}

export class RateError extends Error {
  override name = "RateError";
  constructor(readonly errors: RateIssue[]) {
    super(`invalid rate: ${errors.map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`).join("; ")}`);
  }
}

/** `validateRate` that throws `RateError`. Convenient for literals in code and tests. */
export function defineRate(input: Rate): ValidRate {
  const v = validateRate(input);
  if (!v.ok) throw new RateError(v.errors);
  return v.rate;
}

/** A free rate: counted, written, priced at 0. Used for `ifMissing: "free"`. */
export const FREE_RATE: ValidRate = defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }] });

// ---------------------------------------------------------------------------

export interface BreakdownRow {
  /** Tier start. */
  from: number;
  /** Units in this slice (blocks for `package`). */
  quantity: number;
  unitPriceMicroUsd: number;
  per: number;
  /** Flat fee charged in this slice (tier entered in this observation). */
  flatMicroUsd: number;
}

export interface Rated {
  /** This observation's charge, after rounding and clamping. Excludes `adjustmentMicroUsd`. */
  totalMicroUsd: MicroUsd;
  breakdown: BreakdownRow[];
  /** Tier of the last unit observed (of `usedSoFar` when quantity is 0). */
  tierIndex: number;
  /** Sub-micro remainder in [0, 1) after this observation (`cumulative` only, otherwise 0). */
  carry: number;
  /** Worst-case charge for `quantity` units at this tariff; what a hold reserves. */
  holdUpperBound: MicroUsd;
  /** Volume `on_crossing`: correction for units observed earlier, usually negative. */
  adjustmentMicroUsd?: MicroUsd;
  /** Set when `perObservation` changed the charge. */
  clamped?: "min" | "max";
}

export interface RateInput {
  rate: ValidRate;
  usedSoFar: number;
  quantity: number;
  /** `cumulative` only: remainder from the previous observation. When omitted it is derived from `usedSoFar`. */
  carry?: number;
}

const CARRY_EPS = q(1, 1_000_000_000);
const unitPrice = (t: Tier): Q => q(t.unitPriceMicroUsd, t.per ?? 1);

export function tierAt(tiers: readonly Tier[], pos: number): number {
  let lo = 0;
  let hi = tiers.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tiers[mid]!.from <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Sum of flat fees of tiers whose start lies in [lo, hi). */
function flatsIn(tiers: readonly Tier[], lo: number, hi: number): bigint {
  let s = 0n;
  for (const t of tiers) if (t.flatMicroUsd && t.from >= lo && t.from < hi) s += BigInt(t.flatMicroUsd);
  return s;
}

interface Exact {
  charge: Q;
  flats: bigint;
  adj: Q | null;
  breakdown: BreakdownRow[];
  tierIndex: number;
}

function exact(rate: ValidRate, u: number, x: number): Exact {
  const tiers = rate.tiers;
  const end = u + x;
  const breakdown: BreakdownRow[] = [];
  if (x === 0) return { charge: ZERO, flats: 0n, adj: null, breakdown, tierIndex: tierAt(tiers, Math.max(u - 1, 0)) };

  if (rate.model === "graduated") {
    let charge = ZERO;
    let flats = 0n;
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i]!;
      const lo = t.from;
      const hi = i + 1 < tiers.length ? tiers[i + 1]!.from : Infinity;
      const a = Math.max(u, lo);
      const b = Math.min(end, hi);
      if (b <= a) continue;
      const flat = t.flatMicroUsd && lo >= u && lo < end ? t.flatMicroUsd : 0;
      charge = add(charge, mulInt(unitPrice(t), b - a));
      flats += BigInt(flat);
      breakdown.push({ from: lo, quantity: b - a, unitPriceMicroUsd: t.unitPriceMicroUsd, per: t.per ?? 1, flatMicroUsd: flat });
    }
    return { charge, flats, adj: null, breakdown, tierIndex: tierAt(tiers, end - 1) };
  }

  if (rate.model === "volume") {
    const f = tierAt(tiers, end - 1);
    const t = tiers[f]!;
    const flats = flatsIn(tiers, u, end);
    const charge = mulInt(unitPrice(t), x);
    breakdown.push({ from: t.from, quantity: x, unitPriceMicroUsd: t.unitPriceMicroUsd, per: t.per ?? 1, flatMicroUsd: Number(flats) });
    let adj: Q | null = null;
    if (rate.policy?.adjustmentTiming === "on_crossing" && u > 0) {
      const p = tierAt(tiers, u - 1);
      if (p !== f) adj = mulInt(sub(unitPrice(t), unitPrice(tiers[p]!)), u);
    }
    return { charge, flats, adj, breakdown, tierIndex: f };
  }

  // package: blocks k cover units [k*s, (k+1)*s); a block is bought when its first unit is used.
  const s = rate.packageSize!;
  const b0 = Math.ceil(u / s);
  const b1 = Math.ceil(end / s);
  let charge = ZERO;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i]!;
    const lo = Math.ceil(t.from / s);
    const hi = i + 1 < tiers.length ? Math.ceil(tiers[i + 1]!.from / s) : Infinity;
    const a = Math.max(b0, lo);
    const b = Math.min(b1, hi);
    if (b <= a) continue;
    charge = add(charge, mulInt(unitPrice(t), b - a));
    breakdown.push({ from: t.from, quantity: b - a, unitPriceMicroUsd: t.unitPriceMicroUsd, per: t.per ?? 1, flatMicroUsd: 0 });
  }
  const flats = flatsIn(tiers, u, end);
  if (flats > 0n) {
    // attribute flats to the tier rows they belong to
    for (const t of tiers) {
      if (!t.flatMicroUsd || t.from < u || t.from >= end) continue;
      const row = breakdown.find((r) => r.from === t.from);
      if (row) row.flatMicroUsd += t.flatMicroUsd;
      else breakdown.push({ from: t.from, quantity: 0, unitPriceMicroUsd: t.unitPriceMicroUsd, per: t.per ?? 1, flatMicroUsd: t.flatMicroUsd });
    }
  }
  const lastBlockStart = (b1 - 1) * s;
  return { charge, flats, adj: null, breakdown, tierIndex: tierAt(tiers, Math.max(lastBlockStart, 0)) };
}

/** Running exact total of the first `n` units, where the model defines one. */
function runningTotal(rate: ValidRate, n: number): Q | null {
  if (rate.model === "volume" && rate.policy?.adjustmentTiming !== "on_crossing") return null;
  const e = exact(rate, 0, n);
  return add(e.charge, q(e.flats));
}

function assertQty(name: string, v: number) {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer, got ${v}`);
}

/**
 * Prices `quantity` units observed after `usedSoFar` units of the same period.
 * Pure: splits the observation across tiers, applies flat fees, rounding, clamping and volume adjustment.
 */
export function rate(i: RateInput): Rated {
  const { rate: r, usedSoFar: u, quantity: x } = i;
  assertQty("usedSoFar", u);
  assertQty("quantity", x);
  const e = exact(r, u, x);
  const rounding = r.policy?.rounding ?? "per_event_up";

  let charge: bigint;
  let adj = 0n;
  let carry = 0;
  if (rounding === "per_event_up") {
    charge = ceil(e.charge) + e.flats;
    if (e.adj) adj = ceil(e.adj);
  } else {
    const delta = add(add(e.charge, q(e.flats)), e.adj ?? ZERO);
    const before = i.carry === undefined ? runningTotal(r, u) : null;
    let total: bigint;
    if (before) {
      const after = runningTotal(r, u + x)!;
      total = floor(after) - floor(before);
      carry = toCarry(frac(after));
    } else {
      let s = add(i.carry === undefined ? ZERO : fromCarry(i.carry), delta);
      // a float carry holds 1e-12 resolution: snap sums within 1e-9 of the next integer (⅓ + ⅓ + ⅓ is 1)
      if (cmp(sub(q(floor(s) + 1n), s), CARRY_EPS) <= 0) s = q(floor(s) + 1n);
      total = floor(s);
      carry = toCarry(frac(s));
    }
    if (e.adj) adj = floor(e.adj);
    charge = total - adj;
  }

  let clamped: Rated["clamped"];
  const po = r.policy?.perObservation;
  if (po && x > 0) {
    if (po.minMicroUsd !== undefined && charge < BigInt(po.minMicroUsd)) {
      charge = BigInt(po.minMicroUsd);
      clamped = "min";
    }
    if (po.maxMicroUsd !== undefined && charge > BigInt(po.maxMicroUsd)) {
      charge = BigInt(po.maxMicroUsd);
      clamped = "max";
    }
  }

  const out: Rated = {
    totalMicroUsd: toNumber(charge) as MicroUsd,
    breakdown: e.breakdown,
    tierIndex: e.tierIndex,
    carry,
    holdUpperBound: holdUpperBound(r, x, u),
  };
  if (adj !== 0n) out.adjustmentMicroUsd = toNumber(adj) as MicroUsd;
  if (clamped) out.clamped = clamped;
  return out;
}

/**
 * Worst case for `quantity` units regardless of where in the tiers they land:
 * every unit (or block) at the most expensive tier, every flat fee, and — for volume `on_crossing` —
 * the largest possible correction for the `usedSoFar` earlier units. Capped by `perObservation.maxMicroUsd`.
 */
export function holdUpperBound(r: ValidRate, quantity: number, usedSoFar = 0): MicroUsd {
  if (quantity === 0) return 0 as MicroUsd;
  let pmax = unitPrice(r.tiers[0]!);
  let pmin = pmax;
  let flats = 0n;
  for (const t of r.tiers) {
    const p = unitPrice(t);
    if (cmp(p, pmax) > 0) pmax = p;
    if (cmp(p, pmin) < 0) pmin = p;
    flats += BigInt(t.flatMicroUsd ?? 0);
  }
  const units = r.model === "package" ? Math.ceil(quantity / r.packageSize!) : quantity;
  let charge = ceil(mulInt(pmax, units)) + flats;
  const po = r.policy?.perObservation;
  if (po?.maxMicroUsd !== undefined && charge > BigInt(po.maxMicroUsd)) charge = BigInt(po.maxMicroUsd);
  if (po?.minMicroUsd !== undefined && charge < BigInt(po.minMicroUsd)) charge = BigInt(po.minMicroUsd);
  if (r.model === "volume" && r.policy?.adjustmentTiming === "on_crossing" && usedSoFar > 0) {
    const worst = ceil(mulInt(sub(pmax, pmin), usedSoFar));
    if (worst > 0n) charge += worst;
  }
  return toNumber(charge) as MicroUsd;
}

/**
 * Whether pricing this rate needs `usedSoFar`: anything whose price depends on position in the period
 * (several tiers, flat fees, volume, package, cumulative rounding without a carry).
 */
export function requiresUsage(r: Rate, hasCarry = false): boolean {
  if (r.model !== "graduated" || r.tiers.length > 1) return true;
  if (r.tiers.some((t) => (t.flatMicroUsd ?? 0) > 0)) return true;
  if (r.policy?.rounding === "cumulative" && !hasCarry) return true;
  return false;
}

/**
 * `cumulative` rounding on a `volume` rate without `on_crossing` has no running total to derive the
 * remainder from, so it needs `carry` from the caller; without it every sub-micro amount would be lost.
 */
export function requiresCarry(r: Rate): boolean {
  return r.model === "volume" && r.policy?.adjustmentTiming !== "on_crossing" && r.policy?.rounding === "cumulative";
}

/** `usage_required` check shared by `price()` and holds: position (and, where needed, carry) must be known. */
export function missingPosition(r: Rate, usedSoFar: number | undefined, carry: number | undefined): boolean {
  return (usedSoFar === undefined && requiresUsage(r, carry !== undefined)) || (carry === undefined && requiresCarry(r));
}
