/**
 * B27 — A coupon-like credit ($10 welcome credit).
 * Layer: module (`flatCredit` from /adjustments).
 *
 * How: `flatCredit` returns a plan with one negative charge. Write it with `metering.commit(plan)`;
 * the refId (e.g. coupon code + account) makes redeeming twice a no-op.
 */
import { describe, expect, it } from "vitest";
import { buildMetering } from "pricemeter";
import { flatCredit } from "pricemeter/adjustments";
import { memoryAdapters } from "pricemeter/testing";

describe("B27 coupon-like credit", () => {
  it("credits once, usage draws it down", async () => {
    const mem = memoryAdapters({ prepaid: true, rates: { api: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 2_000 }] } } });
    const metering = buildMetering().refs(["req", "coupon"]).meter("api").bind(mem);
    const ctx = { accountId: "acme" };

    const coupon = flatCredit({ account: "acme", amountMicroUsd: 10_000_000, refType: "coupon", refId: "WELCOME10:acme", at: Date.parse("2026-09-01T00:00:00Z") });
    expect(coupon.ledger).toMatchObject([{ op: "charge", amount: -10_000_000 }]);
    await metering.commit(coupon);
    await metering.commit(coupon); // redeemed twice → once
    expect(mem.store.available("acme")).toBe(10_000_000);

    // 1,500 × 2,000 = 3,000,000 paid from the credit.
    expect(await metering.observe("api", {}, 1_500, { type: "req", id: "1" }, ctx)).toMatchObject({ ok: true, charged: 3_000_000 });
    expect(mem.store.available("acme")).toBe(7_000_000);
  });
});
