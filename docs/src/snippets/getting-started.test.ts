/**
 * The code on the "Getting started" page. The page shows the `#region` blocks of this file;
 * `bun run test` in docs/ runs it, so the page cannot show code that does not work.
 */
import { describe, expect, it } from "vitest";
// #region setup
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";
import { z } from "zod";

// $0.02 per SMS; from the 10,000th message on, $0.015. Amounts are integer micro-units.
const sms: Rate = {
  id: "sms-2026",
  model: "graduated",
  tiers: [
    { from: 0, unitPriceMicroUsd: 20_000 },
    { from: 10_000, unitPriceMicroUsd: 15_000 },
  ],
};

// getRate + commit kept in memory: prepaid, "acme" starts with $10.
const mem = memoryAdapters({ rates: { "otp/sms": sms }, prepaid: true, balances: { acme: 10_000_000 } });

const metering = buildMetering()
  .context(z.object({ accountId: z.string() }))
  .refs(["otp_send"])
  .meter("otp/sms", { country: z.string().length(2) })
  .bind(mem); // same as .getRate(mem.getRate).commit(mem.commit)

const ctx = { accountId: "acme" };
// #endregion

describe("getting started", () => {
  it("observes, charges and writes once", async () => {
    // #region observe
    const r = await metering.observe("otp/sms", { country: "TR" }, 2, { type: "otp_send", id: "msg_1" }, ctx);
    // → { ok: true, charged: 40000, lines: [{ meter: "otp/sms", quantity: 2, amount: 40000, tierIndex: 0, … }] }

    mem.store.available("acme"); // 9_960_000
    mem.store.usage.length; //      1 usage row  (refId "otp_send:msg_1:otp/sms")
    mem.store.ledger.length; //     1 ledger row (a "charge" of 40000)
    // #endregion
    expect(r).toMatchObject({ ok: true, charged: 40_000, lines: [{ meter: "otp/sms", quantity: 2, amount: 40_000, tierIndex: 0 }] });
    expect(mem.store.available("acme")).toBe(9_960_000);
    expect(mem.store.usage.map((u) => u.refId)).toEqual(["otp_send:msg_1:otp/sms"]);
    expect(mem.store.ledger).toMatchObject([{ op: "charge", amount: 40_000 }]);

    // #region retry
    // A retry with the same ref computes the same plan; commit sees (refType, refId) again and writes nothing.
    await metering.observe("otp/sms", { country: "TR" }, 2, { type: "otp_send", id: "msg_1" }, ctx);
    mem.store.available("acme"); // still 9_960_000
    // #endregion
    expect(mem.store.available("acme")).toBe(9_960_000);
    expect(mem.store.usage).toHaveLength(1);
  });

  it("returns reasons instead of throwing", async () => {
    // #region failures
    await metering.observe("otp/sms", { country: "TUR" }, 1, { type: "otp_send", id: "msg_2" }, ctx);
    // → { ok: false, reason: "invalid_dims", meter: "otp/sms", cause: [...] }   (zod: length 2)

    await metering.observe("otp/sms", { country: "TR" }, 1_000, { type: "otp_send", id: "msg_3" }, ctx);
    // → { ok: false, reason: "insufficient_credit", … }   ($20 > $9.96; nothing written)

    mem.store.setRate("otp/sms", undefined); // the price table no longer has this meter
    await metering.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "msg_4" }, ctx);
    // → { ok: false, reason: "no_price", meter: "otp/sms" }
    // #endregion
    expect(await metering.observe("otp/sms", { country: "TUR" }, 1, { type: "otp_send", id: "msg_2" }, ctx)).toMatchObject({
      ok: false,
      reason: "invalid_dims",
      meter: "otp/sms",
    });
    expect(await metering.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "msg_4" }, ctx)).toMatchObject({ ok: false, reason: "no_price" });
    mem.store.setRate("otp/sms", sms);
    expect(await metering.observe("otp/sms", { country: "TR" }, 1_000, { type: "otp_send", id: "msg_3" }, ctx)).toMatchObject({
      ok: false,
      reason: "insufficient_credit",
    });
    expect(mem.store.usage).toHaveLength(1);
  });

  it("shows the plan without writing it", async () => {
    // #region plan
    const { result, plan } = await metering.plan.observe("otp/sms", { country: "TR" }, 3, { type: "otp_send", id: "msg_5" }, ctx);
    // result.charged → 60000
    // plan.ledger    → [{ op: "charge", account: "acme", amount: 60000, refType: "otp_send", refId: "otp_send:msg_5:otp/sms", at }]
    // plan.usage     → [{ account: "acme", meter: "otp/sms", dims: { country: "TR" }, quantity: 3, amount: 60000, rateId: "sms-2026", … }]
    // #endregion
    expect(result).toMatchObject({ ok: true, charged: 60_000 });
    expect(plan.ledger).toMatchObject([{ op: "charge", account: "acme", amount: 60_000, refType: "otp_send", refId: "otp_send:msg_5:otp/sms" }]);
    expect(plan.usage).toMatchObject([{ account: "acme", meter: "otp/sms", dims: { country: "TR" }, quantity: 3, amount: 60_000, rateId: "sms-2026" }]);
    expect(mem.store.usage.some((u) => u.refId === "otp_send:msg_5:otp/sms")).toBe(false);
  });
});
