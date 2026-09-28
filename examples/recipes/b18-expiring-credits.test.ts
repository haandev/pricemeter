/**
 * B18 — Credits that expire.
 * Layer: out of scope — expiry belongs to the ledger adapter.
 *
 * Why: the library never reads a balance. Which grant a charge draws from (FIFO, soonest expiry
 * first) and what is left of a grant on its expiry date are ledger questions, answered
 * atomically where the balance lives. The library only produces charges and credits.
 * Nearest supported pattern: grant with `flatCredit`; at expiry the app (its ledger) works out the
 * unused remainder and commits an ordinary charge for it, with an idempotent refId.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, microUsd, type Plan } from "pricemeter";
import { flatCredit } from "pricemeter/adjustments";
import { memoryAdapters } from "pricemeter/testing";

describe("B18 expiring credits (out of scope)", () => {
  it("grant with flatCredit, expire the remainder from the ledger", async () => {
    const mem = memoryAdapters({ prepaid: true, rates: { api: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1_000 }] } } });
    const metering = buildMetering().refs(["req", "grant"]).meter("api").bind(mem);
    const ctx = { accountId: "acme" };

    // $5 promotional grant, valid through September.
    await metering.commit(flatCredit({ account: "acme", amountMicroUsd: 5_000_000, refType: "grant", refId: "promo-sep", at: Date.parse("2026-09-01T00:00:00Z") }));
    await metering.observe("api", {}, 3_000, { type: "req", id: "1" }, ctx); // 3,000 × 1,000 = $3
    expect(mem.store.available("acme")).toBe(2_000_000);

    // Expiry job (ledger-side knowledge: this account has no other credit, so all $2 left is from the grant).
    const unused = Math.min(5_000_000, mem.store.available("acme"));
    const expire: Plan = {
      ledger: [{ op: "charge", account: "acme", amount: microUsd(unused), refType: "grant", refId: "promo-sep:expire", at: Date.parse("2026-10-01T00:00:00Z") }],
      usage: [],
    };
    await metering.commit(expire);
    await metering.commit(expire); // idempotent
    expect(mem.store.available("acme")).toBe(0);

    // The prepaid gate now refuses usage.
    expect(await metering.observe("api", {}, 1, { type: "req", id: "2" }, ctx)).toMatchObject({ ok: false, reason: "insufficient_credit" });
  });
});
