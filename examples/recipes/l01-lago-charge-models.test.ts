/**
 * L1 — Lago's standard, graduated, volume and package charge models.
 * Layer: core (the three `Rate` models).
 *
 * How: Lago "standard" is a one-tier `graduated` rate; "graduated", "volume" and "package" map
 * one-to-one. The same 1,500 units priced four ways, in one multi-line observation.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const tiers: Rate["tiers"] = [
  { from: 0, unitPriceMicroUsd: 1_000 },
  { from: 1_000, unitPriceMicroUsd: 500 },
];
const rates: Record<string, Rate> = {
  standard: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1_000 }] },
  graduated: { model: "graduated", tiers },
  volume: { model: "volume", tiers },
  package: { model: "package", packageSize: 100, tiers: [{ from: 0, unitPriceMicroUsd: 50_000 }] },
};

describe("L1 Lago standard / graduated / volume / package", () => {
  it("prices 1,500 units in each model", async () => {
    const mem = memoryAdapters({ rates });
    const metering = buildMetering().refs(["period"]).meter("standard").meter("graduated").meter("volume").meter("package").bind(mem);

    const r = await metering.observe(
      [
        { meter: "standard", quantity: 1_500 },
        { meter: "graduated", quantity: 1_500 },
        { meter: "volume", quantity: 1_500 },
        { meter: "package", quantity: 1_500 },
      ],
      { type: "period", id: "2026-09" },
      { accountId: "acme" },
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.lines.map((l) => [l.meter, l.amount])).toEqual([
      ["standard", 1_500_000], //  1,500 × 1,000
      ["graduated", 1_250_000], // 1,000 × 1,000 + 500 × 500
      ["volume", 750_000], //      1,500 × 500 (all units at the tier reached)
      ["package", 750_000], //     ceil(1,500 / 100) = 15 blocks × 50,000
    ]);
    expect(r.charged).toBe(4_250_000);
  });
});
