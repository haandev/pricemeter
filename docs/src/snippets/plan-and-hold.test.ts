/** Code on the "price() and the plan" and "observe and hold" pages. Runs with `bun run test` in docs/. */
import { describe, expect, it } from "vitest";
import { buildMetering, defineRate, price, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const flat = (p: number, per = 1): Rate => ({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: p, per }] });

// #region catalog
const mem = memoryAdapters({
  prepaid: true,
  balances: { acme: 10_000_000 },
  rates: {
    "msg/free_pool": { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }, { from: 1_000, unitPriceMicroUsd: 2_000 }] },
    "otp/sms": flat(20_000),
    "otp/verify": flat(5_000),
    api: { model: "volume", tiers: [{ from: 0, unitPriceMicroUsd: 10_000 }, { from: 1_000, unitPriceMicroUsd: 8_000 }], policy: { adjustmentTiming: "on_crossing" } },
  },
});
const metering = buildMetering()
  .refs(["otp_send", "req"])
  .meter("msg/free_pool")
  .meter("otp/sms", ["country"], { feeds: { "msg/free_pool": 1 } })
  .meter("otp/verify")
  .meter("api")
  .bind(mem);
const ctx = { accountId: "acme" };
// #endregion

describe("plan page", () => {
  it("refIds", async () => {
    // #region refids
    const { plan } = await metering.plan.observe(
      [
        { meter: "otp/sms", dims: { country: "TR" }, quantity: 1 },
        { meter: "otp/sms", dims: { country: "TR" }, quantity: 1 }, // same meter again → #2
      ],
      { type: "otp_send", id: "m1" },
      ctx,
    );
    plan.usage.map((u) => [u.refId, u.amount]);
    // [ ["otp_send:m1:otp/sms", 20000],
    //   ["otp_send:m1:otp/sms#2", 20000],
    //   ["otp_send:m1:otp/sms:msg/free_pool", 0],      ← pool line: {refType}:{id}:{feeder}:{pool}
    //   ["otp_send:m1:otp/sms:msg/free_pool#2", 0] ]
    plan.ledger.map((l) => l.refId);
    // [ "otp_send:m1:otp/sms", "otp_send:m1:otp/sms#2" ]   ← zero amounts: usage only, no ledger row
    // #endregion
    expect(plan.usage.map((u) => [u.refId, u.amount])).toEqual([
      ["otp_send:m1:otp/sms", 20_000],
      ["otp_send:m1:otp/sms#2", 20_000],
      ["otp_send:m1:otp/sms:msg/free_pool", 0],
      ["otp_send:m1:otp/sms:msg/free_pool#2", 0],
    ]);
    expect(plan.ledger.map((l) => l.refId)).toEqual(["otp_send:m1:otp/sms", "otp_send:m1:otp/sms#2"]);
  });

  it("adj", async () => {
    await metering.observe("api", {}, 900, { type: "req", id: "r1" }, ctx);
    // #region adj
    // usedSoFar 900, volume on_crossing: 200 × 8,000 and −900 × 2,000 for the earlier units
    const { result, plan } = await metering.plan.observe("api", {}, 200, { type: "req", id: "r2" }, ctx);
    result; //            { ok: true, charged: -200000, lines: [{ amount: 1600000, adjustment: -1800000, … }] }
    plan.ledger; //       [{ op: "charge", amount: 1600000, refId: "req:r2:api" },
    //                     { op: "charge", amount: -1800000, refId: "req:r2:api:adj" }]
    // #endregion
    expect(result).toMatchObject({ ok: true, charged: -200_000, lines: [{ amount: 1_600_000, adjustment: -1_800_000 }] });
    expect(plan.ledger).toMatchObject([
      { op: "charge", amount: 1_600_000, refId: "req:r2:api" },
      { op: "charge", amount: -1_800_000, refId: "req:r2:api:adj" },
    ]);
  });

  it("pure price()", () => {
    // #region price
    const sms = defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 20_000 }, { from: 10_000, unitPriceMicroUsd: 15_000 }] });
    const { result, plan, rated } = price(
      [{ meter: "otp/sms", dims: { country: "TR" }, quantity: 20, rate: sms, usedSoFar: 9_990 }],
      { type: "otp_send", id: "m9" },
      { accountId: "acme" },
      { at: Date.parse("2026-09-28T12:00:00Z") },
    );
    result; //   { ok: true, charged: 350000, lines: [{ tierIndex: 1, breakdown: [{ from: 0, quantity: 10 }, { from: 10000, quantity: 10 }] }] }
    rated[0]; // { totalMicroUsd: 350000, carry: 0, holdUpperBound: 400000, … }
    // #endregion
    expect(result).toMatchObject({ ok: true, charged: 350_000, lines: [{ tierIndex: 1, breakdown: [{ from: 0, quantity: 10 }, { from: 10_000, quantity: 10 }] }] });
    expect(rated[0]).toMatchObject({ totalMicroUsd: 350_000, carry: 0, holdUpperBound: 400_000 });
    expect(plan.usage).toHaveLength(1);
    // no usedSoFar on a tiered rate
    expect(price([{ meter: "otp/sms", quantity: 1, rate: sms }], { type: "x", id: "1" }, { accountId: "a" }).result).toMatchObject({
      ok: false,
      reason: "usage_required",
    });
  });
});

describe("hold page", () => {
  it("hold → extend → capture → release", async () => {
    // #region hold
    // Reserve: up to 3 SMS segments + 1 verification. The hold is a value; store it (e.g. on the OTP record).
    const h = await metering.hold(
      [
        { meter: "otp/sms", dims: { country: "TR" }, quantity: 3 },
        { meter: "otp/verify", quantity: 1 },
      ],
      { type: "otp_send", id: "otp_1" },
      ctx,
    );
    if (!h.ok) throw new Error(h.reason);
    h.upperBound; // 65000 + pool line's worst case (3 × 2000) = 71000
    h.hold.holdId; // "otp_send:otp_1"  → ledger: { op: "hold", amount: 71000, refId: "otp_send:otp_1:hold" }

    // Resend: grow the same hold. Existing lines keep their tariff; getRate is asked only for new lines.
    const e = await metering.extend(h.hold, [{ meter: "otp/sms", dims: { country: "TR" }, quantity: 1 }], ctx);
    if (!e.ok) throw new Error(e.reason);
    // ledger: { op: "extend", amount: 22000, refId: "otp_send:otp_1:extend:1" }

    // Verified: capture what was sent (pool line follows its feeder), then release the rest.
    const c = await metering.capture(
      e.hold,
      [
        { meter: "otp/sms", quantity: 2 },
        { meter: "otp/verify", quantity: 1 },
      ],
      ctx,
    );
    if (!c.ok) throw new Error(c.reason);
    c.charged; // 45000 → refIds "otp_send:otp_1:otp/sms:capture:1", "otp_send:otp_1:otp/verify:capture:1", …

    const r = await metering.release(c.hold, ctx);
    // ledger: { op: "release", amount: 93000 − 45000 = 48000, refId: "otp_send:otp_1:release" }
    // #endregion
    expect(h.upperBound).toBe(71_000);
    expect(e.upperBound).toBe(93_000);
    expect(c.charged).toBe(45_000);
    expect(r.ok).toBe(true);
    expect(mem.store.ledger.filter((l) => l.op !== "charge").map((l) => [l.op, l.refId, l.amount])).toEqual([
      ["hold", "otp_send:otp_1:hold", 71_000],
      ["extend", "otp_send:otp_1:extend:1", 22_000],
      ["capture", "otp_send:otp_1:otp/sms:capture:1", 40_000],
      ["capture", "otp_send:otp_1:otp/verify:capture:1", 5_000],
      ["release", "otp_send:otp_1:release", 48_000],
    ]);
    // #region closed
    if (!r.ok) throw new Error(r.reason);
    await metering.capture(r.hold, [{ meter: "otp/sms", quantity: 1 }], ctx); // { ok: false, reason: "hold_closed" }
    await metering.capture(c.hold, [{ meter: "otp/sms", quantity: 3 }], ctx); // { ok: false, reason: "hold_exceeded", meter: "otp/sms" } (2 + 3 > 4)
    // #endregion
    expect(await metering.capture(r.hold, [{ meter: "otp/sms", quantity: 1 }], ctx)).toMatchObject({ ok: false, reason: "hold_closed" });
    expect(await metering.capture(c.hold, [{ meter: "otp/sms", quantity: 3 }], ctx)).toMatchObject({ ok: false, reason: "hold_exceeded", meter: "otp/sms" });
  });

  it("telescoping captures", async () => {
    // #region telescoping
    // 1/3 micro-USD per unit. Three captures of 1 unit each cost what one observation of 3 costs.
    const m = buildMetering().refs(["job"]).meter("gpu/ms").bind(memoryAdapters({ rates: { "gpu/ms": flat(1, 3) } }));
    const h = await m.hold("gpu/ms", {}, 3, { type: "job", id: "j1" }, { accountId: "acme" });
    if (!h.ok) throw new Error(h.reason);
    let hold = h.hold;
    const charged: number[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await m.capture(hold, [{ meter: "gpu/ms", quantity: 1 }], { accountId: "acme" });
      if (!c.ok) throw new Error(c.reason);
      charged.push(c.charged);
      hold = c.hold;
    }
    charged; // [1, 0, 0] — R(u, c+q) − R(u, c), not [1, 1, 1]
    // #endregion
    expect(charged).toEqual([1, 0, 0]);
  });

  it("capture-time rate", async () => {
    // #region capturerate
    const h = await metering.hold("otp/verify", {}, 1, { type: "otp_send", id: "otp_2" }, ctx);
    if (!h.ok) throw new Error(h.reason);
    // Default: the tariff stored in the hold (5000). Pass { rate } to price at capture time instead.
    const c = await metering.capture(h.hold, [{ meter: "otp/verify", quantity: 1 }], ctx, { rate: flat(4_000) });
    // c.charged → 4000 (must still fit the hold's upper bound, else hold_exceeded)
    // #endregion
    expect(c).toMatchObject({ ok: true, charged: 4_000 });
  });
});
