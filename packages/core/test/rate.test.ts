import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defineRate, holdUpperBound, rate, RateError, requiresUsage, tierAt, validateRate, type Rate } from "pricemeter";

const tiers = [
  { from: 0, unitPriceMicroUsd: 50_000 },
  { from: 10_000, unitPriceMicroUsd: 45_000 },
];

describe("rate(): the spec table (usedSoFar 9990, quantity 20)", () => {
  it("graduated splits across the boundary", () => {
    const r = rate({ rate: defineRate({ model: "graduated", tiers }), usedSoFar: 9990, quantity: 20 });
    expect(r.totalMicroUsd).toBe(950_000);
    expect(r.breakdown).toEqual([
      { from: 0, quantity: 10, unitPriceMicroUsd: 50_000, per: 1, flatMicroUsd: 0 },
      { from: 10_000, quantity: 10, unitPriceMicroUsd: 45_000, per: 1, flatMicroUsd: 0 },
    ]);
    expect(r.tierIndex).toBe(1);
    expect(r.adjustmentMicroUsd).toBeUndefined();
  });

  it("volume prices everything at the final tier", () => {
    const r = rate({ rate: defineRate({ model: "volume", tiers }), usedSoFar: 9990, quantity: 20 });
    expect(r.totalMicroUsd).toBe(900_000);
    expect(r.adjustmentMicroUsd).toBeUndefined();
  });

  it("volume on_crossing adds a negative correction for earlier units", () => {
    const r = rate({ rate: defineRate({ model: "volume", tiers, policy: { adjustmentTiming: "on_crossing" } }), usedSoFar: 9990, quantity: 20 });
    expect(r.totalMicroUsd).toBe(900_000);
    expect(r.adjustmentMicroUsd).toBe(-9990 * 5000);
  });

  it("volume on_crossing without a crossing has no correction", () => {
    const r = rate({ rate: defineRate({ model: "volume", tiers, policy: { adjustmentTiming: "on_crossing" } }), usedSoFar: 100, quantity: 20 });
    expect(r.adjustmentMicroUsd).toBeUndefined();
    expect(r.totalMicroUsd).toBe(20 * 50_000);
  });

  it("package buys only new blocks", () => {
    const r = rate({ rate: defineRate({ model: "package", packageSize: 1000, tiers }), usedSoFar: 9990, quantity: 20 });
    expect(r.breakdown).toEqual([{ from: 10_000, quantity: 1, unitPriceMicroUsd: 45_000, per: 1, flatMicroUsd: 0 }]);
    expect(r.totalMicroUsd).toBe(45_000);
    const inside = rate({ rate: defineRate({ model: "package", packageSize: 1000, tiers }), usedSoFar: 1, quantity: 998 });
    expect(inside.totalMicroUsd).toBe(0);
  });
});

describe("rate(): policies", () => {
  const perMillion = (rounding: "per_event_up" | "cumulative") =>
    defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 150_000, per: 1_000_000 }], policy: { rounding } });

  it("per_event_up rounds each observation up", () => {
    let total = 0;
    for (let u = 0; u < 10; u++) total += rate({ rate: perMillion("per_event_up"), usedSoFar: u, quantity: 1 }).totalMicroUsd;
    expect(total).toBe(10);
  });

  it("cumulative never drifts: ten 1-token events cost floor(1.5)", () => {
    let total = 0;
    for (let u = 0; u < 10; u++) total += rate({ rate: perMillion("cumulative"), usedSoFar: u, quantity: 1 }).totalMicroUsd;
    expect(total).toBe(1);
  });

  it("cumulative with an explicit carry", () => {
    const r1 = rate({ rate: perMillion("cumulative"), usedSoFar: 0, quantity: 5, carry: 0 });
    expect(r1.totalMicroUsd).toBe(0);
    expect(r1.carry).toBeCloseTo(0.75);
    const r2 = rate({ rate: perMillion("cumulative"), usedSoFar: 0, quantity: 5, carry: r1.carry });
    expect(r2.totalMicroUsd).toBe(1);
    expect(r2.carry).toBeCloseTo(0.5);
  });

  it("flat fee is charged once, on entering the tier", () => {
    const r = defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0, flatMicroUsd: 50_000_000 }] });
    expect(rate({ rate: r, usedSoFar: 0, quantity: 1 }).totalMicroUsd).toBe(50_000_000);
    expect(rate({ rate: r, usedSoFar: 1, quantity: 5 }).totalMicroUsd).toBe(0);
    const t = defineRate({
      model: "graduated",
      tiers: [
        { from: 0, unitPriceMicroUsd: 10 },
        { from: 100, unitPriceMicroUsd: 5, flatMicroUsd: 1000 },
      ],
    });
    const x = rate({ rate: t, usedSoFar: 95, quantity: 10 });
    expect(x.totalMicroUsd).toBe(5 * 10 + 5 * 5 + 1000);
    expect(x.breakdown[1]!.flatMicroUsd).toBe(1000);
  });

  it("percentage + fixed fee + cap (B22)", () => {
    // 2.9% + $0.30, max $5; quantity is the transaction amount in micro-units
    const r = defineRate({
      model: "graduated",
      tiers: [{ from: 0, unitPriceMicroUsd: 29_000, per: 1_000_000, flatMicroUsd: 300_000 }],
      policy: { perObservation: { maxMicroUsd: 5_000_000 } },
    });
    const small = rate({ rate: r, usedSoFar: 0, quantity: 10_000_000 }); // $10
    expect(small.totalMicroUsd).toBe(290_000 + 300_000);
    const big = rate({ rate: r, usedSoFar: 0, quantity: 1_000_000_000 }); // $1000
    expect(big.totalMicroUsd).toBe(5_000_000);
    expect(big.clamped).toBe("max");
  });

  it("minimum per observation", () => {
    const r = defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1 }], policy: { perObservation: { minMicroUsd: 100 } } });
    const x = rate({ rate: r, usedSoFar: 0, quantity: 3 });
    expect(x.totalMicroUsd).toBe(100);
    expect(x.clamped).toBe("min");
    expect(rate({ rate: r, usedSoFar: 0, quantity: 0 }).totalMicroUsd).toBe(0);
  });

  it("proration with per (seat-seconds over a month)", () => {
    const month = 30 * 86_400;
    const r = defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 10_000_000, per: month }] });
    // 3 seats for half a month
    expect(rate({ rate: r, usedSoFar: 0, quantity: 3 * month / 2 }).totalMicroUsd).toBe(15_000_000);
  });

  it("free first 500 (B3)", () => {
    const r = defineRate({
      model: "graduated",
      tiers: [
        { from: 0, unitPriceMicroUsd: 0 },
        { from: 500, unitPriceMicroUsd: 1000 },
      ],
    });
    expect(rate({ rate: r, usedSoFar: 490, quantity: 20 }).totalMicroUsd).toBe(10 * 1000);
  });

  it("rejects bad quantities", () => {
    const r = defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1 }] });
    expect(() => rate({ rate: r, usedSoFar: -1, quantity: 1 })).toThrow(RangeError);
    expect(() => rate({ rate: r, usedSoFar: 0, quantity: 1.5 })).toThrow(RangeError);
  });
});

describe("validateRate", () => {
  const codes = (x: unknown) => {
    const v = validateRate(x);
    return v.ok ? [] : v.errors.map((e) => e.code);
  };
  it("accepts and freezes a valid rate", () => {
    const v = validateRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1 }], extra: 1 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(Object.isFrozen(v.rate)).toBe(true);
      expect(Object.isFrozen(v.rate.tiers[0])).toBe(true);
      expect("extra" in v.rate).toBe(false);
    }
  });
  it("reports every problem with a path", () => {
    expect(codes(null)).toEqual(["invalid_shape"]);
    expect(codes({ model: "x", tiers: [] })).toEqual(["invalid_model", "empty_tiers"]);
    expect(codes({ model: "graduated", tiers: [{ from: 1, unitPriceMicroUsd: 1 }] })).toEqual(["first_tier_from"]);
    expect(
      codes({
        model: "graduated",
        tiers: [
          { from: 0, unitPriceMicroUsd: 1 },
          { from: 0, unitPriceMicroUsd: 1 },
        ],
      }),
    ).toEqual(["tiers_not_increasing"]);
    expect(codes({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: -1, per: 0, flatMicroUsd: 1.5 }] })).toEqual([
      "invalid_price",
      "invalid_per",
      "invalid_flat",
    ]);
    expect(codes({ model: "package", tiers: [{ from: 0, unitPriceMicroUsd: 1 }] })).toEqual(["invalid_package_size"]);
    expect(codes({ model: "graduated", packageSize: 10, tiers: [{ from: 0, unitPriceMicroUsd: 1 }] })).toEqual(["package_size_not_allowed"]);
    expect(codes({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1 }], policy: { adjustmentTiming: "on_crossing" } })).toEqual([
      "adjustment_timing_not_allowed",
    ]);
    expect(
      codes({ model: "volume", tiers: [{ from: 0, unitPriceMicroUsd: 1 }], policy: { perObservation: { minMicroUsd: 10, maxMicroUsd: 5 } } }),
    ).toEqual(["min_gt_max"]);
    expect(codes({ model: "volume", tiers: [{ from: 0, unitPriceMicroUsd: 1 }], policy: { rounding: "nearest" } })).toEqual(["invalid_policy"]);
    const v = validateRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: "1" }] });
    expect(!v.ok && v.errors[0]!.path).toEqual(["tiers", 0, "unitPriceMicroUsd"]);
  });
  it("defineRate throws RateError", () => {
    expect(() => defineRate({ model: "graduated", tiers: [] })).toThrow(RateError);
  });
});

describe("helpers", () => {
  it("tierAt", () => {
    const t = [{ from: 0 }, { from: 10 }, { from: 100 }] as never;
    expect([0, 9, 10, 99, 100, 1e9].map((p) => tierAt(t, p))).toEqual([0, 0, 1, 1, 2, 2]);
  });
  it("requiresUsage", () => {
    const single: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1 }] };
    expect(requiresUsage(single)).toBe(false);
    expect(requiresUsage({ ...single, policy: { rounding: "cumulative" } })).toBe(true);
    expect(requiresUsage({ ...single, policy: { rounding: "cumulative" } }, true)).toBe(false);
    expect(requiresUsage({ ...single, model: "volume" })).toBe(true);
    expect(requiresUsage({ model: "graduated", tiers })).toBe(true);
  });
  it("holdUpperBound uses the most expensive tier and every flat", () => {
    const r = defineRate({
      model: "graduated",
      tiers: [
        { from: 0, unitPriceMicroUsd: 0 },
        { from: 500, unitPriceMicroUsd: 1000, flatMicroUsd: 7 },
      ],
    });
    expect(holdUpperBound(r, 3)).toBe(3007);
    expect(holdUpperBound(r, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Property tests

const tierArb = fc
  .array(fc.record({ gap: fc.integer({ min: 1, max: 500 }), price: fc.integer({ min: 0, max: 100_000 }), per: fc.constantFrom(1, 3, 1000, 1_000_000), flat: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 5000 })) }), {
    minLength: 1,
    maxLength: 5,
  })
  .map((xs) => {
    let from = 0;
    return xs.map((x, i) => {
      if (i > 0) from += x.gap;
      return { from, unitPriceMicroUsd: x.price, per: x.per, flatMicroUsd: x.flat };
    });
  });

const rateArb = fc.oneof(
  tierArb.map((t) => ({ model: "graduated" as const, tiers: t })),
  tierArb.map((t) => ({ model: "volume" as const, tiers: t, policy: { adjustmentTiming: "on_crossing" as const } })),
  fc.tuple(tierArb, fc.integer({ min: 1, max: 50 })).map(([t, s]) => ({ model: "package" as const, tiers: t, packageSize: s })),
);

describe("properties", () => {
  it("graduated slices add up to the quantity", () => {
    fc.assert(
      fc.property(tierArb, fc.nat(2000), fc.nat(2000), (t, u, q) => {
        const r = rate({ rate: defineRate({ model: "graduated", tiers: t }), usedSoFar: u, quantity: q });
        expect(r.breakdown.reduce((a, b) => a + b.quantity, 0)).toBe(q);
      }),
    );
  });

  it("cumulative rounding never drifts, however the period is split", () => {
    fc.assert(
      fc.property(rateArb, fc.array(fc.nat(300), { minLength: 1, maxLength: 20 }), (raw, chunks) => {
        const r = defineRate({ ...raw, policy: { ...(raw as Rate).policy, rounding: "cumulative" } } as Rate);
        const total = chunks.reduce((a, b) => a + b, 0);
        let u = 0;
        let paid = 0;
        for (const c of chunks) {
          const x = rate({ rate: r, usedSoFar: u, quantity: c });
          paid += x.totalMicroUsd + (x.adjustmentMicroUsd ?? 0);
          u += c;
        }
        const once = rate({ rate: r, usedSoFar: 0, quantity: total });
        expect(paid).toBe(once.totalMicroUsd + (once.adjustmentMicroUsd ?? 0));
      }),
    );
  });

  it("package buys ceil((u+q)/s) − ceil(u/s) blocks", () => {
    fc.assert(
      fc.property(tierArb, fc.integer({ min: 1, max: 100 }), fc.nat(5000), fc.nat(5000), (t, s, u, q) => {
        const r = rate({ rate: defineRate({ model: "package", packageSize: s, tiers: t }), usedSoFar: u, quantity: q });
        const blocks = r.breakdown.reduce((a, b) => a + b.quantity, 0);
        expect(blocks).toBe(Math.ceil((u + q) / s) - Math.ceil(u / s));
      }),
    );
  });

  it("the hold upper bound covers the charge at any position", () => {
    fc.assert(
      fc.property(rateArb, fc.nat(3000), fc.nat(3000), (raw, u, q) => {
        const r = defineRate(raw as Rate);
        const x = rate({ rate: r, usedSoFar: u, quantity: q });
        expect(x.holdUpperBound).toBeGreaterThanOrEqual(x.totalMicroUsd + (x.adjustmentMicroUsd ?? 0));
      }),
    );
  });
});
