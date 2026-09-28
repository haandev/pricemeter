/** Regressions from the adversarial review (see design/decisions.md A101–A104). Titles describe the bug that was fixed. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMetering, defineRate, type Rate } from "pricemeter";

const ctx = { accountId: "acc" };
const ref = { type: "t", id: "1" };

const tier = fc.record({ unitPriceMicroUsd: fc.integer({ min: 0, max: 1000 }), per: fc.integer({ min: 1, max: 7 }), flatMicroUsd: fc.integer({ min: 0, max: 50 }) });
const rateArb = fc
  .record({
    model: fc.constantFrom("graduated", "volume", "package"),
    tiers: fc.array(tier, { minLength: 1, maxLength: 3 }),
    gaps: fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 3, maxLength: 3 }),
    packageSize: fc.integer({ min: 1, max: 4 }),
    rounding: fc.constantFrom("per_event_up", "cumulative"),
    onCrossing: fc.boolean(),
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
    if (x.model === "volume") r.policy!.adjustmentTiming = x.onCrossing ? "on_crossing" : "on_crossing";
    return defineRate(r);
  });

describe("hold + full capture vs observe for multi-line inputs", () => {
  it("property", async () => {
    await fc.assert(
      fc.asyncProperty(
        rateArb,
        rateArb,
        fc.integer({ min: 0, max: 20 }),
        fc.array(fc.record({ meter: fc.constantFrom("a", "b"), c: fc.constantFrom("X", "Y"), q: fc.integer({ min: 0, max: 12 }) }), { minLength: 1, maxLength: 4 }),
        async (ra, rp, u, raw) => {
          const make = () =>
            buildMetering()
              .context(z.object({ accountId: z.string() }))
              .meter("pool")
              .meter("a", { c: z.string() }, { feeds: { pool: 1 } })
              .meter("b", { c: z.string() }, { feeds: { pool: 2 } })
              .getRate(async (m, _d, _c, _a) => ({ rate: m === "pool" ? rp : ra, usedSoFar: u }))
              .commit(async () => {});
          const m = make();
          const seen = new Set<string>();
          raw = raw.filter((l) => (seen.has(l.meter + l.c) ? false : (seen.add(l.meter + l.c), true)));
          const lines = raw.map((l) => ({ meter: l.meter as "a" | "b", dims: { c: l.c }, quantity: l.q }));
          const obs = await m.plan.observe(lines, ref, ctx);
          if (!obs.result.ok) throw new Error(obs.result.reason);
          const h = await m.plan.hold(lines, ref, ctx);
          if (!h.result.ok) throw new Error(h.result.reason);
          const caps = h.result.hold.lines.filter((l) => !l.feeders).map((l) => ({ meter: l.meter as "a" | "b", dims: l.dims as { c: string }, quantity: l.quantity }));
          const c = await m.plan.capture(h.result.hold, caps, ctx);
          if (!c.result.ok) throw new Error(c.result.reason);
          // a hold rounds each (meter, dims) once (A101): equal under cumulative, never dearer under per_event_up
          if (rp.policy?.rounding === "cumulative" && ra.policy?.rounding === "cumulative") expect(c.result.charged).toBe(obs.result.charged);
          else expect(c.result.charged).toBeLessThanOrEqual(obs.result.charged);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("bind shares the catalog", () => {
  it("meter() on a bound copy mutates the original", () => {
    const base = buildMetering().context(z.object({ accountId: z.string() })).meter("a");
    const copy = base.bind({ getRate: async (_m, _d, _c, _a) => null, commit: async () => {} });
    (copy as any).meter("extra");
    expect(Object.keys(base.meters)).toEqual(["a"]);
  });
});
