/**
 * L2 — Lago "percentage" and "graduated_percentage".
 * Layer: core (like B22: quantity is the amount, `per: 1_000_000` is a fraction).
 *
 * How: percentage = one tier, `unitPriceMicroUsd / per` is the rate, `flatMicroUsd` the fixed fee
 * per transaction (usedSoFar 0, A97), `perObservation` its min/max. Graduated percentage = several
 * tiers over the month's running amount, each tier's `flatMicroUsd` charged when it is entered.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, usd, type Rate } from "pricemeter";
import { monthKey } from "pricemeter/calendar";
import { memoryAdapters } from "pricemeter/testing";

// 1% + $0.10 per transaction, at least $0.50
const percentage: Rate = {
  model: "graduated",
  tiers: [{ from: 0, unitPriceMicroUsd: 10_000, per: 1_000_000, flatMicroUsd: 100_000 }],
  policy: { perObservation: { minMicroUsd: 500_000 } },
};
// 2% of the first $1,000 a month, 1% above plus a $0.50 fee on entering that tier
const graduatedPercentage: Rate = {
  model: "graduated",
  tiers: [
    { from: 0, unitPriceMicroUsd: 20_000, per: 1_000_000 },
    { from: usd(1_000), unitPriceMicroUsd: 10_000, per: 1_000_000, flatMicroUsd: 500_000 },
  ],
};

describe("L2 Lago percentage / graduated_percentage", () => {
  const mem = memoryAdapters({
    rates: { "pay/percentage": () => ({ rate: percentage, usedSoFar: 0 }), "pay/graduated": graduatedPercentage },
    periodOf: (at) => monthKey({ at }),
  });
  const metering = buildMetering().refs(["payment"]).meter("pay/percentage").meter("pay/graduated").bind(mem);
  const ctx = { accountId: "acme" };

  it("percentage with fixed fee and minimum", async () => {
    // $200: 2,000,000 + 100,000
    expect(await metering.observe("pay/percentage", {}, usd(200), { type: "payment", id: "a" }, ctx)).toMatchObject({ charged: 2_100_000 });
    // $10: 100,000 + 100,000 = 200,000 → raised to the 500,000 minimum
    expect(await metering.observe("pay/percentage", {}, usd(10), { type: "payment", id: "b" }, ctx)).toMatchObject({ charged: 500_000 });
  });

  it("graduated percentage over the month's volume", async () => {
    // $800 at 2% = 16,000,000
    expect(await metering.observe("pay/graduated", {}, usd(800), { type: "payment", id: "c" }, ctx)).toMatchObject({ charged: 16_000_000 });
    // $400 more: $200 at 2% (4,000,000) + $200 at 1% (2,000,000) + tier fee 500,000
    expect(await metering.observe("pay/graduated", {}, usd(400), { type: "payment", id: "d" }, ctx)).toMatchObject({ charged: 6_500_000 });
  });
});
