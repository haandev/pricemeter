/**
 * L4 — Lago "custom" charge model (arbitrary code computes the fee).
 * Layer: out of scope.
 *
 * Why: every amount pricemeter writes must be reproducible from a tariff and a breakdown in the
 * usage row; a function cannot be logged or explained, so a `Rate` is data only.
 * Nearest supported pattern: run your code in getRate and have it *produce a tariff* (tiers, flat
 * fees, clamps). The code decides the shape; the library prices it and logs a breakdown.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, validateRate, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

describe("L4 Lago custom (out of scope)", () => {
  it("a tariff cannot be code", () => {
    const custom = { model: "custom", compute: (q: number) => q * 42 };
    const v = validateRate(custom);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors[0]?.code).toBe("invalid_model");
  });

  it("instead, code builds a tariff and the row explains the amount", async () => {
    // "Custom" logic: loyal customers get a cheaper second tier that starts earlier.
    const buildRate = (loyaltyYears: number): Rate => ({
      id: `loyalty-${loyaltyYears}`,
      model: "graduated",
      tiers: [
        { from: 0, unitPriceMicroUsd: 1_000 },
        { from: Math.max(100, 1_000 - loyaltyYears * 300), unitPriceMicroUsd: 600 },
      ],
    });
    const mem = memoryAdapters({ rates: { api: (_dims, ctx) => buildRate(ctx.loyaltyYears) } });
    const metering = buildMetering().context<{ accountId: string; loyaltyYears: number }>().refs(["req"]).meter("api").bind(mem);

    // 2 years → tier 2 from 400: 400 × 1,000 + 600 × 600 = 760,000
    expect(await metering.observe("api", {}, 1_000, { type: "req", id: "1" }, { accountId: "acme", loyaltyYears: 2 })).toMatchObject({ charged: 760_000 });

    const row = mem.store.usage[0]!;
    expect(row.rateId).toBe("loyalty-2");
    const explained = row.detail.breakdown.reduce((s, b) => s + (b.quantity * b.unitPriceMicroUsd) / b.per + b.flatMicroUsd, 0);
    expect(explained).toBe(row.amount);
  });
});
