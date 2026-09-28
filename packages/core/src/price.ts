import type { MicroUsd } from "./money.js";
import { fail, type Failure, type Plan, type Ref, type Result, type ResultLine, type UsageRow } from "./plan.js";
import { missingPosition, rate, type Rated, type ValidRate } from "./rate.js";

export type Dims = Record<string, unknown>;

/** A line with its tariff attached: what `price()` consumes. */
export interface PricedLine<M extends string = string, D = Dims> {
  meter: M;
  dims?: D;
  quantity: number;
  rate: ValidRate;
  /** Units of this meter already used in the tier period. Required for tiered, flat, volume and package rates. */
  usedSoFar?: number;
  /** `cumulative` rounding: remainder carried from the previous observation. */
  carry?: number;
  at?: number;
  /** Set on pool lines produced by `feeds`. */
  feeder?: { meter: string; weight: number };
  /**
   * Hard cap for this meter in the period `usedSoFar` counts. `price()` refuses with `quota_exceeded` when
   * `usedSoFar` + earlier units of the same meter in this call + `quantity` exceed it; the row carries it so
   * `commit` can enforce it atomically.
   */
  limit?: number;
}

export interface PriceContext {
  accountId: string;
}

export interface PriceOptions {
  /** Default timestamp for lines without `at`. Defaults to `Date.now()`. */
  at?: number;
}

export interface Priced {
  result: Result;
  plan: Plan;
  /** Per input line, in order. Empty when the result failed. */
  rated: Rated[];
}

/** Stable key for (meter, dims): lines sharing it share a running `usedSoFar` inside one call. */
export function lineKey(meter: string, dims: Dims | undefined): string {
  if (!dims) return meter;
  const keys = Object.keys(dims).sort();
  return keys.length ? `${meter}|${JSON.stringify(keys.map((k) => [k, dims[k]]))}` : meter;
}

/** `{refType}:{ref.id}:{meter}`; pool lines `…:{feeder}:{pool}`; repeats of the same meter get `#2`, `#3`… */
export function assignRefIds(lines: readonly { meter: string; feeder?: { meter: string } | undefined }[], ref: Ref): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const base = l.feeder ? `${ref.type}:${ref.id}:${l.feeder.meter}:${l.meter}` : `${ref.type}:${ref.id}:${l.meter}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

/**
 * The pure core: prices lines and produces the plan to write. No I/O, no validation of context.
 * Lines on the same meter and dims advance `usedSoFar` for each other, so one call is one consistent observation.
 */
export function price(lines: readonly PricedLine[], ref: Ref, ctx: PriceContext, opts: PriceOptions = {}): Priced {
  const at0 = opts.at ?? Date.now();
  const offsets = new Map<string, number>();
  const carries = new Map<string, number>();
  const rated: Rated[] = [];

  const none = { ledger: [], usage: [] };
  for (const l of lines) {
    if (missingPosition(l.rate, l.usedSoFar, l.carry) || (l.limit !== undefined && l.usedSoFar === undefined)) {
      return { result: fail("usage_required", { meter: l.meter }), plan: none, rated: [] };
    }
  }
  const quota = checkQuota(lines);
  if (quota) return { result: quota, plan: none, rated: [] };

  const refIds = assignRefIds(lines, ref);
  const plan: Plan = { ledger: [], usage: [] };
  const out: ResultLine[] = [];
  let charged = 0;

  lines.forEach((l, i) => {
    const key = lineKey(l.meter, l.dims);
    const offset = offsets.get(key) ?? 0;
    offsets.set(key, offset + l.quantity);
    const input: Parameters<typeof rate>[0] = { rate: l.rate, usedSoFar: (l.usedSoFar ?? 0) + offset, quantity: l.quantity };
    // a later line with the same key continues from the earlier line's remainder, not the original carry
    if (l.carry !== undefined) input.carry = carries.get(key) ?? l.carry;
    const r = rate(input);
    if (l.carry !== undefined) carries.set(key, r.carry);
    rated.push(r);

    const refId = refIds[i]!;
    const at = l.at ?? at0;
    const row: UsageRow = {
      account: ctx.accountId,
      meter: l.meter,
      dims: (l.dims ?? {}) as Dims,
      quantity: l.quantity,
      amount: r.totalMicroUsd,
      detail: { breakdown: r.breakdown },
      refType: ref.type,
      refId,
      at,
    };
    if (l.rate.id !== undefined) row.rateId = l.rate.id;
    if (l.limit !== undefined) row.limit = l.limit;
    if (l.feeder) {
      row.detail.feeder = l.feeder.meter;
      row.detail.weight = l.feeder.weight;
    }
    if (r.clamped) row.detail.clamped = r.clamped;
    if (l.rate.policy?.rounding === "cumulative") row.detail.carry = r.carry;
    plan.usage.push(row);
    if (r.totalMicroUsd !== 0) {
      plan.ledger.push({ op: "charge", account: ctx.accountId, amount: r.totalMicroUsd, refType: ref.type, refId, at });
    }
    charged += r.totalMicroUsd;

    const line: ResultLine = { meter: l.meter, quantity: l.quantity, amount: r.totalMicroUsd, tierIndex: r.tierIndex, breakdown: r.breakdown };
    if (l.feeder) line.feeder = l.feeder.meter;

    if (r.adjustmentMicroUsd) {
      const adjRef = `${refId}:adj`;
      const adjRow: UsageRow = {
        account: ctx.accountId,
        meter: l.meter,
        dims: row.dims,
        quantity: 0,
        amount: r.adjustmentMicroUsd,
        detail: { breakdown: [], adjustment: true },
        refType: ref.type,
        refId: adjRef,
        at,
      };
      if (row.rateId !== undefined) adjRow.rateId = row.rateId;
      plan.usage.push(adjRow);
      plan.ledger.push({ op: "charge", account: ctx.accountId, amount: r.adjustmentMicroUsd, refType: ref.type, refId: adjRef, at });
      charged += r.adjustmentMicroUsd;
      line.adjustment = r.adjustmentMicroUsd;
    }
    out.push(line);
  });

  return { result: { ok: true, charged: charged as MicroUsd, lines: out }, plan, rated };
}

/**
 * The early (non-atomic) quota check. Limits are per meter: lines of the same meter in one call add up,
 * whatever their dims. Returns the failure for the first line that would pass its limit.
 */
export function checkQuota(lines: readonly { meter: string; quantity: number; usedSoFar?: number; limit?: number }[]): Failure | null {
  const earlier = new Map<string, number>();
  for (const l of lines) {
    const before = earlier.get(l.meter) ?? 0;
    earlier.set(l.meter, before + l.quantity);
    if (l.limit === undefined) continue;
    const used = (l.usedSoFar ?? 0) + before;
    if (used + l.quantity > l.limit) {
      return fail("quota_exceeded", { meter: l.meter, cause: { meter: l.meter, limit: l.limit, used, requested: l.quantity } });
    }
  }
  return null;
}
