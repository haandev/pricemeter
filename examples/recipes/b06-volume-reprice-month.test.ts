/**
 * B6 — Volume pricing: crossing a threshold reprices the whole month.
 * Layer: core (`volume` + `adjustmentTiming: "on_crossing"`) or module (`volumeTrueUp` from /adjustments).
 *
 * How: either let the observation that crosses the tier emit a correction for the earlier units
 * right away (`on_crossing`, a separate `…:adj` row), or charge each observation at the tier it
 * lands in and settle the difference once at period end with `volumeTrueUp()`.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, defineRate, type Rate } from "pricemeter";
import { volumeTrueUp } from "pricemeter/adjustments";
import { memoryAdapters } from "pricemeter/testing";

// All units at $0.01 below 1,000 a month, all units at $0.008 from 1,000.
const tiers: Rate["tiers"] = [
  { from: 0, unitPriceMicroUsd: 10_000 },
  { from: 1_000, unitPriceMicroUsd: 8_000 },
];

function setup(rate: Rate) {
  const mem = memoryAdapters({ rates: { api: rate } });
  const metering = buildMetering().refs(["req", "period"]).meter("api").bind(mem);
  return { metering, mem };
}
const ctx = { accountId: "acme" };

describe("B6 volume: crossing a tier reprices earlier units", () => {
  it("on_crossing: the crossing observation carries the correction", async () => {
    const { metering, mem } = setup({ model: "volume", tiers, policy: { adjustmentTiming: "on_crossing" } });

    expect(await metering.observe("api", {}, 900, { type: "req", id: "1" }, ctx)).toMatchObject({ charged: 9_000_000 }); // 900 × 10,000

    // 200 × 8,000 = 1,600,000, plus 900 × (8,000 − 10,000) = −1,800,000 for the earlier units.
    expect(await metering.observe("api", {}, 200, { type: "req", id: "2" }, ctx)).toMatchObject({
      charged: -200_000,
      lines: [{ amount: 1_600_000, adjustment: -1_800_000 }],
    });
    expect(mem.store.usage.map((u) => u.refId)).toEqual(["req:1:api", "req:2:api", "req:2:api:adj"]);
    // Month total = 1,100 × 8,000
    expect(mem.store.account("acme").balance).toBe(-8_800_000);
  });

  it("none + volumeTrueUp: settle once at period end", async () => {
    const rate = defineRate({ id: "api-volume", model: "volume", tiers, policy: { adjustmentTiming: "none" } });
    const { metering, mem } = setup(rate);

    await metering.observe("api", {}, 900, { type: "req", id: "1" }, ctx); //  9,000,000
    await metering.observe("api", {}, 200, { type: "req", id: "2" }, ctx); //  1,600,000 (tier it landed in)
    const charged = -mem.store.account("acme").balance;
    expect(charged).toBe(10_600_000);

    // Period close: 1,100 × 8,000 = 8,800,000 → credit 1,800,000.
    const plan = volumeTrueUp({
      account: "acme",
      meter: "api",
      rate,
      quantity: mem.store.used("acme", "api"),
      chargedMicroUsd: charged,
      refType: "period",
      refId: "volume_true_up:api:2026-09",
      at: Date.parse("2026-10-01T00:00:00Z"),
    });
    expect(plan.ledger).toMatchObject([{ op: "charge", amount: -1_800_000 }]);
    expect(await metering.commit(plan)).toEqual({ ok: true });
    expect(await metering.commit(plan)).toEqual({ ok: true }); // safe to re-run: same refId is a no-op
    expect(mem.store.account("acme").balance).toBe(-8_800_000);
  });
});
