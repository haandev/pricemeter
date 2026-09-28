import type { MicroUsd } from "./money.js";
import { fail, type Failure, type LedgerOp, type Plan, type Ref, type ResultLine, type UsageRow } from "./plan.js";
import { assignRefIds, checkQuota, lineKey, type Dims, type PricedLine } from "./price.js";
import { holdUpperBound, missingPosition, rate, type Rate, type ValidRate } from "./rate.js";
import { poolQuantity } from "./util.js";

/** A meter feeding a pool line: its weight and its index in `Hold.lines`. */
export interface HoldFeeder {
  meter: string;
  weight: number;
  line: number;
}

/**
 * One reserved `(meter, dims)`. A hold has at most one line per `(meter, dims)`: repeated lines are
 * merged, so every line owns a single, non-overlapping range of tier positions starting at `usedSoFar`.
 */
export interface HoldLine {
  meter: string;
  dims: Dims;
  /** Units reserved. */
  quantity: number;
  /** Units captured so far. */
  captured: number;
  /** Money captured so far on this line. */
  amount: MicroUsd;
  /** The tariff at hold time; captures use it, `getRate` is not called again. */
  rate: ValidRate;
  usedSoFar?: number;
  carry?: number;
  upperBound: MicroUsd;
  /** Pool lines: the meters feeding this pool. Its quantity follows theirs. */
  feeders?: HoldFeeder[];
  /** Quota from `getRate`, checked on the reserved quantity at hold and extend time (not on capture). */
  limit?: number;
}

/**
 * A multi-line reservation. A value object: the application stores it (e.g. on the OTP record)
 * and passes it back; the library never reads the ledger. Each call returns the updated hold.
 */
export interface Hold {
  holdId: string;
  account: string;
  refType: string;
  refId: string;
  at: number;
  upperBound: MicroUsd;
  captured: MicroUsd;
  lines: HoldLine[];
  seq: { capture: number; extend: number };
  released: boolean;
}

export interface HoldSuccess {
  ok: true;
  charged: MicroUsd;
  holdId: string;
  upperBound: MicroUsd;
  lines: HoldLine[];
  hold: Hold;
}
export type HoldResult = HoldSuccess | Failure;

export interface CaptureSuccess {
  ok: true;
  charged: MicroUsd;
  holdId: string;
  lines: ResultLine[];
  hold: Hold;
}
export type CaptureResult = CaptureSuccess | Failure;

export interface HoldPlanned<R> {
  result: R;
  plan: Plan;
}

export type HoldLike = Hold | { hold: Hold };
export const unwrapHold = (h: HoldLike): Hold => ("holdId" in h && "lines" in h && "seq" in h ? (h as Hold) : (h as { hold: Hold }).hold);

/** What a hold line would cost if `x` of its units were captured, as one observation. */
function costOf(l: HoldLine, x: number, r: ValidRate = l.rate): number {
  if (x === 0) return 0;
  const input: Parameters<typeof rate>[0] = { rate: r, usedSoFar: l.usedSoFar ?? 0, quantity: x };
  if (l.carry !== undefined) input.carry = l.carry;
  const out = rate(input);
  return out.totalMicroUsd + (out.adjustmentMicroUsd ?? 0);
}

const boundOf = (l: Pick<HoldLine, "rate" | "quantity" | "usedSoFar">) => holdUpperBound(l.rate, l.quantity, l.usedSoFar ?? 0);
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const feederSum = (lines: readonly HoldLine[], l: HoldLine, of: "quantity" | "captured") =>
  sum((l.feeders ?? []).map((f) => poolQuantity(lines[f.line]![of], f.weight)));

/** A priced line on its way into a hold; `feeder.line` indexes the incoming array. */
export interface PricedHoldLine extends Omit<PricedLine, "feeder"> {
  feeder?: { meter: string; weight: number; line: number };
}

/**
 * Merges incoming priced lines into `existing` (cloned): same `(meter, dims)` adds quantity to the one line
 * (keeping its tariff and position), pool lines collect their feeders.
 */
function mergeLines(existing: readonly HoldLine[], incoming: readonly PricedHoldLine[]): HoldLine[] | Failure {
  const out = existing.map((l) => ({ ...l, ...(l.feeders ? { feeders: l.feeders.map((f) => ({ ...f })) } : {}) }));
  const index = new Map(out.map((l, i) => [lineKey(l.meter, l.dims), i]));
  const at: number[] = [];
  for (const l of incoming) {
    const key = lineKey(l.meter, l.dims);
    let i = index.get(key);
    if (i === undefined) {
      if (missingPosition(l.rate, l.usedSoFar, l.carry)) return fail("usage_required", { meter: l.meter });
      const h: HoldLine = { meter: l.meter, dims: (l.dims ?? {}) as Dims, quantity: 0, captured: 0, amount: 0 as MicroUsd, rate: l.rate, upperBound: 0 as MicroUsd };
      if (l.usedSoFar !== undefined) h.usedSoFar = l.usedSoFar;
      if (l.carry !== undefined) h.carry = l.carry;
      if (l.limit !== undefined) h.limit = l.limit;
      i = out.push(h) - 1;
      index.set(key, i);
    }
    const h = out[i]!;
    h.quantity += l.quantity;
    if (l.feeder) (h.feeders ??= []).push({ meter: l.feeder.meter, weight: l.feeder.weight, line: at[l.feeder.line]! });
    at.push(i);
  }
  return out;
}

/** Pools follow their feeders; bounds are recomputed. */
function settle(lines: HoldLine[]): void {
  for (const l of lines) if (l.feeders) l.quantity = Math.max(l.quantity, feederSum(lines, l, "quantity"));
  for (const l of lines) l.upperBound = boundOf(l);
}

export function planHold(lines: readonly PricedHoldLine[], ref: Ref, account: string, at: number): HoldPlanned<HoldResult> {
  const hl = mergeLines([], lines);
  if (!Array.isArray(hl)) return { result: hl, plan: { ledger: [], usage: [] } };
  settle(hl);
  const quota = checkQuota(hl);
  if (quota) return { result: quota, plan: { ledger: [], usage: [] } };
  const holdId = `${ref.type}:${ref.id}`;
  const upperBound = sum(hl.map((l) => l.upperBound)) as MicroUsd;
  const hold: Hold = {
    holdId,
    account,
    refType: ref.type,
    refId: ref.id,
    at,
    upperBound,
    captured: 0 as MicroUsd,
    lines: hl,
    seq: { capture: 0, extend: 0 },
    released: false,
  };
  const plan: Plan = {
    ledger: [{ op: "hold", holdId, account, amount: upperBound, refType: ref.type, refId: `${holdId}:hold`, at }],
    usage: [],
  };
  return { result: { ok: true, charged: 0 as MicroUsd, holdId, upperBound, lines: hl, hold }, plan };
}

/**
 * Grows a hold with more lines. Lines whose `(meter, dims)` is already held keep their tariff and position
 * and only grow; new ones come priced (their `feeder.line` indexes `added`).
 */
export function planExtend(hold: Hold, added: readonly PricedHoldLine[], at: number): HoldPlanned<HoldResult> {
  if (hold.released) return { result: fail("hold_closed"), plan: { ledger: [], usage: [] } };
  const lines = mergeLines(hold.lines, added);
  if (!Array.isArray(lines)) return { result: lines, plan: { ledger: [], usage: [] } };
  settle(lines);
  const quota = checkQuota(lines);
  if (quota) return { result: quota, plan: { ledger: [], usage: [] } };
  const upperBound = sum(lines.map((l) => l.upperBound)) as MicroUsd;
  const delta = upperBound - hold.upperBound;
  const n = hold.seq.extend + 1;
  const next: Hold = { ...hold, lines, upperBound, seq: { ...hold.seq, extend: n } };
  const plan: Plan = { ledger: [], usage: [] };
  if (delta !== 0) {
    plan.ledger.push({
      op: "extend",
      holdId: hold.holdId,
      account: hold.account,
      amount: delta as MicroUsd,
      refType: hold.refType,
      refId: `${hold.holdId}:extend:${n}`,
      at,
    });
  }
  return { result: { ok: true, charged: 0 as MicroUsd, holdId: hold.holdId, upperBound, lines, hold: next }, plan };
}

export interface CaptureLine {
  meter: string;
  dims?: Dims;
  quantity: number;
}

function findLine(lines: readonly HoldLine[], c: CaptureLine): number {
  if (c.dims !== undefined) {
    const key = lineKey(c.meter, c.dims);
    const i = lines.findIndex((l) => lineKey(l.meter, l.dims) === key);
    if (i < 0) throw new Error(`capture: ${c.meter} ${JSON.stringify(c.dims)} is not part of hold`);
    return i;
  }
  const matches = lines.flatMap((l, i) => (l.meter === c.meter ? [i] : []));
  if (matches.length === 0) throw new Error(`capture: meter "${c.meter}" is not part of hold`);
  if (matches.length > 1) throw new Error(`capture: meter "${c.meter}" is held with several dims; pass dims`);
  return matches[0]!;
}

export function planCapture(
  hold: Hold,
  caps: readonly CaptureLine[],
  at: number,
  override?: Rate | Record<string, Rate>,
): HoldPlanned<CaptureResult> {
  const none = { ledger: [], usage: [] };
  if (hold.released) return { result: fail("hold_closed"), plan: none };
  const lines = hold.lines.map((l) => ({ ...l }));
  const before = hold.lines.map((l) => l.captured);
  const explicit = new Set<number>();

  for (const c of caps) {
    if (!Number.isSafeInteger(c.quantity) || c.quantity < 0) throw new RangeError(`capture quantity must be a non-negative integer`);
    const i = findLine(lines, c);
    lines[i]!.captured += c.quantity;
    explicit.add(i);
  }
  lines.forEach((l, i) => {
    if (l.feeders && !explicit.has(i)) l.captured = Math.max(l.captured, Math.min(l.quantity, feederSum(lines, l, "captured")));
  });
  for (const l of lines) if (l.captured > l.quantity) return { result: fail("hold_exceeded", { meter: l.meter }), plan: none };

  const rateFor = (l: HoldLine): ValidRate => {
    if (!override) return l.rate;
    if ("model" in override) return override as ValidRate;
    return ((override as Record<string, Rate>)[l.meter] as ValidRate | undefined) ?? l.rate;
  };

  const changed = lines.flatMap((l, i) => (l.captured !== before[i] ? [i] : []));
  for (const i of changed) {
    const l = lines[i]!;
    const r = rateFor(l);
    if (r !== l.rate && missingPosition(r, l.usedSoFar, l.carry)) {
      return { result: fail("usage_required", { meter: l.meter }), plan: none };
    }
  }
  const n = hold.seq.capture + 1;
  const refIds = assignRefIds(
    changed.map((i) => {
      const l = lines[i]!;
      return l.feeders?.length ? { meter: l.meter, feeder: { meter: l.feeders[0]!.meter } } : { meter: l.meter };
    }),
    { type: hold.refType, id: hold.refId },
  );

  const ledger: LedgerOp[] = [];
  const usage: UsageRow[] = [];
  const out: ResultLine[] = [];
  let charged = 0;
  changed.forEach((i, k) => {
    const l = lines[i]!;
    const prev = before[i]!;
    const r = rateFor(l);
    const amount = costOf(l, l.captured, r) - costOf(l, prev, r);
    l.amount = (l.amount + amount) as MicroUsd;
    charged += amount;
    const refId = `${refIds[k]}:capture:${n}`;
    const detailRate = rate({ rate: r, usedSoFar: (l.usedSoFar ?? 0) + prev, quantity: l.captured - prev });
    const row: UsageRow = {
      account: hold.account,
      meter: l.meter,
      dims: l.dims,
      quantity: l.captured - prev,
      amount: amount as MicroUsd,
      detail: { breakdown: detailRate.breakdown, holdId: hold.holdId },
      refType: hold.refType,
      refId,
      at,
    };
    if (r.id !== undefined) row.rateId = r.id;
    if (l.feeders?.length) {
      row.detail.feeder = l.feeders.map((f) => f.meter).join(",");
      if (l.feeders.length === 1) row.detail.weight = l.feeders[0]!.weight;
    }
    usage.push(row);
    if (amount !== 0) {
      ledger.push({ op: "capture", holdId: hold.holdId, account: hold.account, amount: amount as MicroUsd, refType: hold.refType, refId, at });
    }
    const line: ResultLine = { meter: l.meter, quantity: l.captured - prev, amount: amount as MicroUsd, tierIndex: detailRate.tierIndex, breakdown: detailRate.breakdown };
    if (l.feeders?.length) line.feeder = l.feeders[0]!.meter;
    out.push(line);
  });

  const captured = (hold.captured + charged) as MicroUsd;
  if (captured > hold.upperBound) return { result: fail("hold_exceeded"), plan: none };
  const next: Hold = { ...hold, lines, captured, seq: { ...hold.seq, capture: n } };
  return {
    result: { ok: true, charged: charged as MicroUsd, holdId: hold.holdId, lines: out, hold: next },
    plan: { ledger, usage },
  };
}

export function planRelease(hold: Hold, at: number): HoldPlanned<CaptureResult> {
  if (hold.released) return { result: fail("hold_closed"), plan: { ledger: [], usage: [] } };
  const remaining = hold.upperBound - hold.captured;
  const plan: Plan = { ledger: [], usage: [] };
  if (remaining !== 0) {
    plan.ledger.push({
      op: "release",
      holdId: hold.holdId,
      account: hold.account,
      amount: remaining as MicroUsd,
      refType: hold.refType,
      refId: `${hold.holdId}:release`,
      at,
    });
  }
  const next: Hold = { ...hold, released: true };
  return { result: { ok: true, charged: 0 as MicroUsd, holdId: hold.holdId, lines: [], hold: next }, plan };
}
