/**
 * B16 — The first 1,000 units of an account's lifetime are free.
 * Layer: recipe (`usedSoFar` from a lifetime counter; `tierPeriod: "lifetime"`, `LIFETIME` from /calendar).
 *
 * How: the tiers look like any free allowance. What makes it "lifetime" is which counter getRate
 * reads `usedSoFar` from: one that never resets. `tierPeriod` records that choice on the tariff.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { LIFETIME } from "pricemeter/calendar";
import { memoryAdapters } from "pricemeter/testing";

const trialUnits: Rate = {
  id: "lifetime-1000-free",
  model: "graduated",
  tiers: [{ from: 0, unitPriceMicroUsd: 0 }, { from: 1_000, unitPriceMicroUsd: 1_000 }],
  policy: { tierPeriod: "lifetime" },
};

describe("B16 lifetime first 1,000 free", () => {
  it("the allowance does not reset across months", async () => {
    // Every observation falls into the same period key, so the counter spans the account's lifetime.
    const mem = memoryAdapters({ rates: { renders: trialUnits }, periodOf: () => LIFETIME });
    const metering = buildMetering().refs(["job"]).meter("renders").bind(mem);
    const ctx = { accountId: "acme" };

    const jan = Date.parse("2026-01-15T00:00:00Z");
    const mar = Date.parse("2026-03-15T00:00:00Z");
    expect(await metering.observe("renders", {}, 600, { type: "job", id: "1" }, ctx, { at: jan })).toMatchObject({ charged: 0 });
    // usedSoFar 600 (from January): 400 free + 200 × 1,000 = 200,000
    expect(await metering.observe("renders", {}, 600, { type: "job", id: "2" }, ctx, { at: mar })).toMatchObject({ charged: 200_000 });
    expect(mem.store.used("acme", "renders", LIFETIME)).toBe(1_200);
  });
});
