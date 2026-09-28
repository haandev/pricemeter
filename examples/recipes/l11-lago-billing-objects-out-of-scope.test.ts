/**
 * L11 — Lago plans, subscriptions, trials, wallets, coupons and invoices.
 * Layer: out of scope.
 *
 * Why: these are billing-system objects with their own lifecycles; pricemeter only prices usage
 * and hands back a plan to write. Each one touches the library at a single point:
 * plan/subscription → the context getRate sees; trial → getRate returns a free tariff;
 * wallet → the ledger behind `commit` (prepaid gate); coupon → `flatCredit`; invoice → a query over usage rows.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, FREE_RATE, type Rate } from "pricemeter";
import { flatCredit } from "pricemeter/adjustments";
import { memoryAdapters } from "pricemeter/testing";

type Ctx = { accountId: string; plan: "starter" | "pro"; trialEndsAt: number };
const PLAN_RATES: Record<Ctx["plan"], Rate> = {
  starter: { id: "starter", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 2_000 }] },
  pro: { id: "pro", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1_000 }] },
};

describe("L11 Lago billing objects (out of scope)", () => {
  it("each object maps to one touch point", async () => {
    const mem = memoryAdapters({
      prepaid: true, // wallet: the ledger enforces the balance
      balances: { acme: 1_000_000 },
      rates: { api: (_dims, ctx: Ctx, at) => (at < ctx.trialEndsAt ? FREE_RATE : PLAN_RATES[ctx.plan]) }, // plan + trial
    });
    const metering = buildMetering().context<Ctx>().refs(["req", "coupon"]).meter("api").bind(mem);
    const ctx: Ctx = { accountId: "acme", plan: "pro", trialEndsAt: Date.parse("2026-09-15T00:00:00Z") };

    // Trial: counted, priced 0.
    expect(await metering.observe("api", {}, 100, { type: "req", id: "1" }, ctx, { at: Date.parse("2026-09-10T00:00:00Z") })).toMatchObject({ charged: 0 });
    // After trial: pro plan price, 100 × 1,000.
    expect(await metering.observe("api", {}, 100, { type: "req", id: "2" }, ctx, { at: Date.parse("2026-09-20T00:00:00Z") })).toMatchObject({ charged: 100_000 });
    // Coupon: a credit plan.
    await metering.commit(flatCredit({ account: "acme", amountMicroUsd: 50_000, refType: "coupon", refId: "SAVE5:acme", at: Date.parse("2026-09-21T00:00:00Z") }));
    expect(mem.store.available("acme")).toBe(950_000); // 1,000,000 − 100,000 + 50,000

    // Invoice: the app's query over usage rows.
    const invoiceLines = mem.store.usage.map((u) => ({ rate: u.rateId, quantity: u.quantity, amount: u.amount }));
    expect(invoiceLines).toEqual([
      { rate: undefined, quantity: 100, amount: 0 }, // FREE_RATE has no id
      { rate: "pro", quantity: 100, amount: 100_000 },
    ]);
  });
});
