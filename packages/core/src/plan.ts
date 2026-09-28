import type { MicroUsd } from "./money.js";
import type { BreakdownRow } from "./rate.js";

/** Identifies what caused a write. `(type, id)` plus the line's meter makes the idempotency key. */
export interface Ref<T extends string = string> {
  type: T;
  id: string;
}

interface LedgerBase {
  account: string;
  amount: MicroUsd;
  refType: string;
  refId: string;
  at: number;
}

/** Moves money. Positive amounts debit the account; negative ones (volume adjustments, credits) credit it. */
export interface ChargeOp extends LedgerBase {
  op: "charge";
}
/** Reserves `amount` for a hold (the hold's upper bound). */
export interface HoldOp extends LedgerBase {
  op: "hold";
  holdId: string;
}
/** Increases a hold's reservation by `amount`. */
export interface ExtendOp extends LedgerBase {
  op: "extend";
  holdId: string;
}
/** Charges `amount` against a hold's reservation. */
export interface CaptureOp extends LedgerBase {
  op: "capture";
  holdId: string;
}
/** Returns the uncaptured remainder (`amount`) of a hold's reservation. */
export interface ReleaseOp extends LedgerBase {
  op: "release";
  holdId: string;
}

export type LedgerOp = ChargeOp | HoldOp | ExtendOp | CaptureOp | ReleaseOp;

export interface UsageDetail {
  breakdown: BreakdownRow[];
  /** Pool rows: the meter whose observation fed this pool. */
  feeder?: string;
  /** Pool rows: units of pool per unit of feeder. */
  weight?: number;
  clamped?: "min" | "max";
  holdId?: string;
  /** Volume `on_crossing` correction row. */
  adjustment?: true;
  /** `cumulative` rounding: sub-micro remainder after this row. */
  carry?: number;
}

export interface UsageRow {
  account: string;
  meter: string;
  dims: Record<string, unknown>;
  quantity: number;
  amount: MicroUsd;
  rateId?: string;
  detail: UsageDetail;
  refType: string;
  refId: string;
  at: number;
}

/**
 * Everything the library wants written, and the only thing it produces.
 * `commit` must apply it all or nothing, and treat a repeated `(refType, refId)` as a no-op.
 */
export interface Plan {
  ledger: LedgerOp[];
  usage: UsageRow[];
}

export interface ResultLine {
  meter: string;
  quantity: number;
  amount: MicroUsd;
  tierIndex: number;
  breakdown: BreakdownRow[];
  adjustment?: MicroUsd;
  feeder?: string;
}

export type FailureReason =
  | "no_price"
  | "usage_required"
  | "insufficient_credit"
  | "invalid_context"
  | "invalid_dims"
  | "invalid_rate"
  | "invalid_ref"
  | "hold_exceeded"
  | "hold_closed"
  | "commit_failed";

export interface Failure {
  ok: false;
  reason: FailureReason;
  meter?: string;
  cause?: unknown;
}

export interface Success {
  ok: true;
  /** Net money moved by this call (charges, captures and adjustments; not reservations). */
  charged: MicroUsd;
  lines: ResultLine[];
  holdId?: string;
}

export type Result = Success | Failure;

export const fail = (reason: FailureReason, extra: { meter?: string; cause?: unknown } = {}): Failure => {
  const f: Failure = { ok: false, reason };
  if (extra.meter !== undefined) f.meter = extra.meter;
  if (extra.cause !== undefined) f.cause = extra.cause;
  return f;
};

export const emptyPlan = (): Plan => ({ ledger: [], usage: [] });
