import type { MicroUsd } from "./money.js";
import { fail, type Failure, type LedgerOp, type Plan, type Ref, type ResultLine, type UsageRow } from "./plan.js";
import { assignRefIds, lineKey, type Dims, type PricedLine } from "./price.js";
import { holdUpperBound, rate, requiresUsage, type Rate, type ValidRate } from "./rate.js";

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
  /** Pool lines: the feeder meter, its weight and its index in `lines`. */
  feeder?: { meter: string; weight: number; line: number };
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

export interface PricedHoldLine extends Omit<PricedLine, "feeder"> {
  feeder?: { meter: string; weight: number; line: number };
}

function toHoldLines(lines: readonly PricedHoldLine[], existing: readonly HoldLine[]): HoldLine[] | Failure {
  const offsets = new Map<string, number>();
  for (const l of existing) offsets.set(lineKey(l.meter, l.dims), (offsets.get(lineKey(l.meter, l.dims)) ?? 0) + l.quantity);
  const out: HoldLine[] = [];
  for (const l of lines) {
    if (l.usedSoFar === undefined && requiresUsage(l.rate, l.carry !== undefined)) return fail("usage_required", { meter: l.meter });
    const key = lineKey(l.meter, l.dims);
    const off = offsets.get(key) ?? 0;
    offsets.set(key, off + l.quantity);
    const h: HoldLine = {
      meter: l.meter,
      dims: (l.dims ?? {}) as Dims,
      quantity: l.quantity,
      captured: 0,
      amount: 0 as MicroUsd,
      rate: l.rate,
      upperBound: 0 as MicroUsd,
    };
    if (l.usedSoFar !== undefined) h.usedSoFar = l.usedSoFar + off;
    if (l.carry !== undefined) h.carry = l.carry;
    if (l.feeder) h.feeder = l.feeder;
    h.upperBound = boundOf(h);
    out.push(h);
  }
  return out;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

export function planHold(lines: readonly PricedHoldLine[], ref: Ref, account: string, at: number): HoldPlanned<HoldResult> {
  const hl = toHoldLines(lines, []);
  if (!Array.isArray(hl)) return { result: hl, plan: { ledger: [], usage: [] } };
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
 * Grows a hold. `grow` maps existing line indexes to extra units; `added` are new priced lines
 * (their `feeder.line` indexes are relative to `added` and get rebased).
 */
export function planExtend(
  hold: Hold,
  grow: ReadonlyMap<number, number>,
  added: readonly PricedHoldLine[],
  at: number,
): HoldPlanned<HoldResult> {
  if (hold.released) return { result: fail("hold_closed"), plan: { ledger: [], usage: [] } };
  const lines = hold.lines.map((l) => ({ ...l }));
  for (const [i, extra] of grow) {
    const l = lines[i]!;
    l.quantity += extra;
  }
  // pools follow their feeders
  for (const l of lines) {
    if (l.feeder) l.quantity = Math.max(l.quantity, Math.ceil(lines[l.feeder.line]!.quantity * l.feeder.weight));
  }
  for (const l of lines) l.upperBound = boundOf(l);
  const base = lines.length;
  const rebased = added.map((l) => (l.feeder ? { ...l, feeder: { ...l.feeder, line: l.feeder.line + base } } : l));
  const fresh = toHoldLines(rebased, lines);
  if (!Array.isArray(fresh)) return { result: fresh, plan: { ledger: [], usage: [] } };
  lines.push(...fresh);

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
  const matches: number[] = [];
  lines.forEach((l, i) => {
    if (l.meter !== c.meter) return;
    if (c.dims !== undefined && lineKey(l.meter, l.dims) !== lineKey(c.meter, c.dims)) return;
    if (c.dims === undefined && l.feeder) return; // pool lines follow their feeders
    matches.push(i);
  });
  if (matches.length === 0) {
    // explicit capture of a pool line
    const pool = lines.findIndex((l) => l.meter === c.meter);
    if (pool >= 0) return pool;
    throw new Error(`capture: meter "${c.meter}" is not part of hold`);
  }
  if (matches.length > 1) throw new Error(`capture: meter "${c.meter}" appears on several hold lines; pass dims`);
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

  for (const c of caps) {
    if (!Number.isSafeInteger(c.quantity) || c.quantity < 0) throw new RangeError(`capture quantity must be a non-negative integer`);
    const i = findLine(lines, c);
    lines[i]!.captured += c.quantity;
  }
  for (const l of lines) {
    if (l.feeder && l.captured === before[lines.indexOf(l)]) {
      l.captured = Math.max(l.captured, Math.min(l.quantity, Math.ceil(lines[l.feeder.line]!.captured * l.feeder.weight)));
    }
  }
  for (const l of lines) if (l.captured > l.quantity) return { result: fail("hold_exceeded", { meter: l.meter }), plan: none };

  const rateFor = (l: HoldLine): ValidRate => {
    if (!override) return l.rate;
    if ("model" in override) return override as ValidRate;
    return ((override as Record<string, Rate>)[l.meter] as ValidRate | undefined) ?? l.rate;
  };

  const changed: number[] = [];
  lines.forEach((l, i) => {
    if (l.captured !== before[i]) changed.push(i);
  });
  const n = hold.seq.capture + 1;
  const refIds = assignRefIds(
    changed.map((i) => {
      const l = lines[i]!;
      return l.feeder ? { meter: l.meter, feeder: { meter: l.feeder.meter } } : { meter: l.meter };
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
    if (l.feeder) {
      row.detail.feeder = l.feeder.meter;
      row.detail.weight = l.feeder.weight;
    }
    usage.push(row);
    if (amount !== 0) {
      ledger.push({ op: "capture", holdId: hold.holdId, account: hold.account, amount: amount as MicroUsd, refType: hold.refType, refId, at });
    }
    const line: ResultLine = { meter: l.meter, quantity: l.captured - prev, amount: amount as MicroUsd, tierIndex: detailRate.tierIndex, breakdown: detailRate.breakdown };
    if (l.feeder) line.feeder = l.feeder.meter;
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
