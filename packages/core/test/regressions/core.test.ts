/** Regressions from the adversarial review (see design/decisions.md A101–A104). Titles describe the bug that was fixed. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMetering, defineRate, holdUpperBound, price, rate, requiresCarry, type Rate } from "pricemeter";
import { volumeTrueUp } from "pricemeter/adjustments";
import { cycleKey, cycleWindow } from "pricemeter/calendar";
import { integrate } from "pricemeter/gauge";
import { memoryAdapters } from "pricemeter/testing";

const ctx = { accountId: "acc" };
const ref = { type: "t", id: "1" };

describe("cumulative carry with repeated (meter, dims) lines", () => {
  it("second line reuses the first line's carry input", () => {
    // 1 micro per 2 units → 0.5 per unit
    const r = defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1, per: 2 }], policy: { rounding: "cumulative" } });
    const p = price(
      [
        { meter: "tok", quantity: 1, rate: r, carry: 0.5 },
        { meter: "tok", quantity: 1, rate: r, carry: 0.5 },
      ],
      ref,
      ctx,
      { at: 0 },
    );
    // exact running: 0.5 + 0.5 + 0.5 = 1.5 → floor 1 charged in total
    expect(p.result.ok && p.result.charged).toBe(1);
  });

  it("via catalog: getRate carry attached to both lines", async () => {
    const r: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1, per: 2 }], policy: { rounding: "cumulative" } };
    const m = buildMetering()
      .context(z.object({ accountId: z.string() }))
      .meter("tok")
      .getRate(async (_m, _d, _c, _a) => ({ rate: r, carry: 0.5 }))
      .commit(async () => {});
    const out = await m.plan.observe([{ meter: "tok", quantity: 1 }, { meter: "tok", quantity: 1 }], ref, ctx);
    expect(out.result.ok && out.result.charged).toBe(1);
  });
});

describe("carry resolution drift", () => {
  it("chained carry loses a micro-unit when the exact total is an integer", () => {
    const r = defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1, per: 3 }], policy: { rounding: "cumulative" } });
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 3; i++) {
      const o = rate({ rate: r, usedSoFar: i, quantity: 1, carry });
      total += o.totalMicroUsd;
      carry = o.carry;
    }
    // exact: 3 × 1/3 = 1
    expect(total).toBe(1);
  });
});

describe("volumeTrueUp and perObservation clamp", () => {
  it("true-up of per-observation-clamped charges credits almost everything", () => {
    const r = defineRate({
      model: "volume",
      tiers: [{ from: 0, unitPriceMicroUsd: 100 }, { from: 1000, unitPriceMicroUsd: 50 }],
      policy: { perObservation: { maxMicroUsd: 1000 } },
    });
    // 100 observations of 10 units, each charged at tier 0: 10×100 = 1000 (not clamped)
    let charged = 0;
    for (let i = 0; i < 100; i++) charged += rate({ rate: r, usedSoFar: i * 10, quantity: 10 }).totalMicroUsd;
    expect(charged).toBe(100_000); // units 0..999 all at tier 0, no observation clamped
    const plan = volumeTrueUp({ account: "a", meter: "m", rate: r, quantity: 1000, chargedMicroUsd: charged, refType: "p", refId: "x", at: 0 });
    // period ended in tier 0 (last unit 999): nothing to true up
    expect(plan.ledger).toEqual([]);
  });
});

describe("pool quantity precision", () => {
  it("poolQuantity with weight 1 keeps a 13-digit quantity", async () => {
    const mem = memoryAdapters({ rates: { pool: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }] }, f: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }] } } });
    const m = buildMetering().context(z.object({ accountId: z.string() })).meter("pool").meter("f", [], { feeds: { pool: 1 } }).getRate(mem.getRate).commit(mem.commit);
    const q = 1_234_567_890_123;
    const out = await m.plan.observe("f", {}, q, ref, ctx);
    expect(out.plan.usage.find((u) => u.meter === "pool")!.quantity).toBe(q);
  });
  it("integrate time_weighted keeps precision", () => {
    const n = integrate({ samples: [{ at: 0, value: 3 }], window: { from: 0, to: 1_000_000_000_001 }, mode: "time_weighted", unit: "ms" });
    expect(n).toBe(3_000_000_000_003);
  });
});

describe("calendar DST midnight gap", () => {
  it("cycle starting on a day whose midnight does not exist (America/Santiago 2026-09-06)", () => {
    const tz = "America/Santiago";
    const anchor = Date.UTC(2026, 0, 6, 15); // Jan 6 local
    const at = Date.UTC(2026, 8, 10, 15); // Sep 10 local
    const w = cycleWindow({ at, anchor, tz });
    expect(cycleKey({ at, anchor, tz })).toBe("2026-09-06");
    // start of day Sep 6 is 01:00 -03 = 04:00Z
    expect(w.from).toBe(Date.UTC(2026, 8, 6, 4));
  });
});

describe("hold upper bound property: any capture sequence stays within bound", () => {
  const tier = fc.record({ unitPriceMicroUsd: fc.integer({ min: 0, max: 1000 }), per: fc.integer({ min: 1, max: 7 }), flatMicroUsd: fc.integer({ min: 0, max: 50 }) });
  const rateArb = fc
    .record({
      model: fc.constantFrom("graduated", "volume", "package"),
      tiers: fc.array(tier, { minLength: 1, maxLength: 4 }),
      gaps: fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 4, maxLength: 4 }),
      packageSize: fc.integer({ min: 1, max: 6 }),
      rounding: fc.constantFrom("per_event_up", "cumulative"),
      onCrossing: fc.boolean(),
      min: fc.option(fc.integer({ min: 0, max: 300 })),
      max: fc.option(fc.integer({ min: 300, max: 3000 })),
    })
    .map((x) => {
      let from = 0;
      const tiers = x.tiers.map((t, i) => {
        const out = { ...t, from };
        from += x.gaps[i]!;
        return out;
      });
      const r: Rate = { model: x.model as Rate["model"], tiers, policy: { rounding: x.rounding as "cumulative" } };
      if (x.model === "package") r.packageSize = x.packageSize;
      if (x.model === "volume") r.policy!.adjustmentTiming = x.onCrossing ? "on_crossing" : "none";
      const po: { minMicroUsd?: number; maxMicroUsd?: number } = {};
      if (x.min !== null) po.minMicroUsd = x.min;
      if (x.max !== null) po.maxMicroUsd = x.max;
      r.policy!.perObservation = po;
      return defineRate(r);
    });

  it("sum of partial captures ≤ upperBound", async () => {
    await fc.assert(
      fc.asyncProperty(rateArb, fc.integer({ min: 0, max: 40 }), fc.integer({ min: 1, max: 30 }), fc.array(fc.integer({ min: 0, max: 10 }), { maxLength: 6 }), async (r, u, qty, parts) => {
        const m = buildMetering()
          .context(z.object({ accountId: z.string() }))
          .meter("x")
          .getRate(async (_m, _d, _c, _a) => ({ rate: r, usedSoFar: u, ...(requiresCarry(r) ? { carry: 0 } : {}) }))
          .commit(async () => {});
        const h = await m.plan.hold([{ meter: "x", quantity: qty }], ref, ctx);
        if (!h.result.ok) throw new Error(h.result.reason);
        let hold = h.result.hold;
        let left = qty;
        for (const p of parts) {
          const q = Math.min(p, left);
          left -= q;
          const c = await m.plan.capture(hold, [{ meter: "x", quantity: q }], ctx);
          if (!c.result.ok) throw new Error(`capture failed ${c.result.reason} ${JSON.stringify(r)} u=${u}`);
          hold = c.result.hold;
        }
        expect(hold.captured).toBeLessThanOrEqual(hold.upperBound);
      }),
      { numRuns: 2000 },
    );
  });
});
