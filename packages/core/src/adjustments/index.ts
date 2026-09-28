/**
 * Period-end plan items. Each function returns a `Plan`; write it with `metering.commit(plan)`.
 * When to run them (cron, period close) is your application's decision.
 */
import type { MicroUsd } from "../money.js";
import type { Plan } from "../plan.js";
import { rate as rateFn, type ValidRate } from "../rate.js";

const assertInt = (name: string, n: number) => {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${name} must be an integer, got ${n}`);
};

/**
 * Charges the shortfall between a period's spend and its minimum commitment.
 * refId `minimum_commit:{account}:{period}` makes it safe to run twice.
 */
export function minimumCommit(i: {
  account: string;
  minimumMicroUsd: number;
  spentMicroUsd: number;
  period: string;
  at: number;
  refType?: string;
}): Plan {
  assertInt("minimumMicroUsd", i.minimumMicroUsd);
  assertInt("spentMicroUsd", i.spentMicroUsd);
  const shortfall = i.minimumMicroUsd - i.spentMicroUsd;
  if (shortfall <= 0) return { ledger: [], usage: [] };
  return {
    ledger: [
      { op: "charge", account: i.account, amount: shortfall as MicroUsd, refType: i.refType ?? "period", refId: `minimum_commit:${i.account}:${i.period}`, at: i.at },
    ],
    usage: [],
  };
}

/** A credit (negative charge), e.g. a coupon-like grant. */
export function flatCredit(i: { account: string; amountMicroUsd: number; refType: string; refId: string; at: number }): Plan {
  assertInt("amountMicroUsd", i.amountMicroUsd);
  if (i.amountMicroUsd <= 0) throw new RangeError("flatCredit amount must be positive");
  return {
    ledger: [{ op: "charge", account: i.account, amount: -i.amountMicroUsd as MicroUsd, refType: i.refType, refId: i.refId, at: i.at }],
    usage: [],
  };
}

/**
 * Volume true-up at period end: prices the whole period's `quantity` at the tier it ended in and charges
 * (or credits) the difference to what was already charged. Use with `adjustmentTiming: "none"`.
 */
export function volumeTrueUp(i: {
  account: string;
  meter: string;
  dims?: Record<string, unknown>;
  rate: ValidRate;
  quantity: number;
  chargedMicroUsd: number;
  refType: string;
  refId: string;
  at: number;
}): Plan {
  if (i.rate.model !== "volume") throw new TypeError("volumeTrueUp needs a volume rate");
  assertInt("chargedMicroUsd", i.chargedMicroUsd);
  // the period total is not one observation: per-observation clamps don't apply to it
  const { perObservation: _clamp, ...policy } = i.rate.policy ?? {};
  const r = rateFn({ rate: { ...i.rate, policy } as ValidRate, usedSoFar: 0, quantity: i.quantity });
  const diff = r.totalMicroUsd - i.chargedMicroUsd;
  if (diff === 0) return { ledger: [], usage: [] };
  const row: Plan["usage"][number] = {
    account: i.account,
    meter: i.meter,
    dims: i.dims ?? {},
    quantity: 0,
    amount: diff as MicroUsd,
    detail: { breakdown: r.breakdown, adjustment: true },
    refType: i.refType,
    refId: i.refId,
    at: i.at,
  };
  if (i.rate.id !== undefined) row.rateId = i.rate.id;
  return {
    ledger: [{ op: "charge", account: i.account, amount: diff as MicroUsd, refType: i.refType, refId: i.refId, at: i.at }],
    usage: [row],
  };
}
