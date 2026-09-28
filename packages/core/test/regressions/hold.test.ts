/** Regressions from the adversarial review (see design/decisions.md A101–A104). Titles describe the bug that was fixed. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const flat = (p: number): Rate => ({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: p }] });
const ctx = { accountId: "acc" };
const ref = { type: "t" as const, id: "1" };

describe("findLine dims fallback", () => {
  it("capture with non-matching dims must not silently capture another line", async () => {
    const mem = memoryAdapters({ rates: { sms: flat(100) } });
    const m = buildMetering()
      .context(z.object({ accountId: z.string() }))
      .meter("sms", { country: z.string() })
      .getRate(mem.getRate)
      .commit(mem.commit);
    const h = await m.hold("sms", { country: "US" }, 5, ref, ctx);
    if (!h.ok) throw new Error(h.reason);
    let threw = false;
    let res: unknown;
    try {
      res = await m.capture(h, [{ meter: "sms", dims: { country: "TR" }, quantity: 3 }], ctx);
    } catch {
      threw = true;
    }
    // expected: error ("not part of hold"); observed: US line captured
    expect({ threw, res }).toMatchObject({ threw: true });
  });
});

describe("pool float noise in capture/extend (A90)", () => {
  const setup = () => {
    const mem = memoryAdapters({ rates: { pool: flat(1), feeder: flat(0) } });
    const m = buildMetering()
      .context(z.object({ accountId: z.string() }))
      .meter("pool")
      .meter("feeder", [], { feeds: { pool: 1.1 } })
      .meter("other")
      .getRate(mem.getRate)
      .commit(mem.commit);
    return { m, mem };
  };
  it("partial capture of feeder 50 (w=1.1) captures 55 pool units, not 56", async () => {
    const { m } = setup();
    const h = await m.hold("feeder", {}, 100, ref, ctx);
    if (!h.ok) throw new Error(h.reason);
    expect(h.lines.map((l) => [l.meter, l.quantity])).toEqual([["feeder", 100], ["pool", 110]]);
    const c = await m.capture(h, [{ meter: "feeder", quantity: 50 }], ctx);
    if (!c.ok) throw new Error(c.reason);
    expect(c.lines.find((l) => l.meter === "pool")!.quantity).toBe(55);
  });
  it("extend does not inflate pool quantity from float noise", async () => {
    const { m } = setup();
    const h = await m.hold("feeder", {}, 50, ref, ctx);
    if (!h.ok) throw new Error(h.reason);
    expect(h.lines[1]!.quantity).toBe(55);
    const e = await m.extend(h, [{ meter: "feeder", quantity: 0 }], ctx);
    if (!e.ok) throw new Error(e.reason);
    expect(e.lines[1]!.quantity).toBe(55);
    expect(e.upperBound).toBe(h.upperBound);
  });
});

describe("extend shifts positions of same-key lines", () => {
  it("growing a feeder whose pool line precedes another same-pool line double-counts positions", async () => {
    // pool: first 10 units free, then 100 each + 1000 flat when entering tier 2
    const poolRate: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }, { from: 10, unitPriceMicroUsd: 100, flatMicroUsd: 1000 }] };
    const mem = memoryAdapters({ rates: { pool: poolRate, a: flat(0), b: flat(0) } });
    const m = buildMetering()
      .context(z.object({ accountId: z.string() }))
      .meter("pool")
      .meter("a", [], { feeds: { pool: 1 } })
      .meter("b", [], { feeds: { pool: 1 } })
      .getRate(mem.getRate)
      .commit(mem.commit);
    const h = await m.hold([{ meter: "a", quantity: 5 }, { meter: "b", quantity: 5 }], ref, ctx);
    if (!h.ok) throw new Error(h.reason);
    const e = await m.extend(h, [{ meter: "a", quantity: 5 }], ctx);
    if (!e.ok) throw new Error(e.reason);
    const c = await m.capture(e, [{ meter: "a", quantity: 10 }, { meter: "b", quantity: 5 }], ctx);
    if (!c.ok) throw new Error(c.reason);
    // 15 pool units from position 0: 10 free + 5×100 + 1000 flat = 1500
    const direct = await m.plan.observe([{ meter: "a", quantity: 10 }, { meter: "b", quantity: 5 }], { type: "t", id: "2" }, ctx);
    expect(direct.result.ok && direct.result.charged).toBe(1500);
    expect(c.charged).toBe(1500);
  });
});

describe("hold retry with changed inputs", () => {
  it("retrying hold after the tariff changed leaves reserved drifting after release", async () => {
    const mem = memoryAdapters({ rates: { sms: flat(10) }, balances: { acc: 10_000 } });
    const m = buildMetering()
      .context(z.object({ accountId: z.string() }))
      .meter("sms")
      .getRate(mem.getRate)
      .commit(mem.commit);
    await m.hold("sms", {}, 10, ref, ctx); // reserve 100 (response "lost")
    mem.store.setRate("sms", flat(20));
    const h2 = await m.hold("sms", {}, 10, ref, ctx); // retry: no-op write, returns upperBound 200
    if (!h2.ok) throw new Error(h2.reason);
    await m.release(h2, ctx);
    expect(mem.store.account("acc")).toEqual({ balance: 10_000, reserved: 0 });
  });
});

describe("capture override on a line without usedSoFar", () => {
  it("tiered override prices from position 0 silently", async () => {
    const m = buildMetering()
      .context(z.object({ accountId: z.string() }))
      .meter("sms")
      .getRate(async (_m, _d, _c, _a) => ({ rate: flat(10) })) // single tier: no usedSoFar needed
      .commit(async () => {});
    const h = await m.hold("sms", {}, 10, ref, ctx);
    if (!h.ok) throw new Error(h.reason);
    const tiered: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }, { from: 1000, unitPriceMicroUsd: 10 }] };
    const c = await m.capture(h, [{ meter: "sms", quantity: 10 }], ctx, { rate: tiered });
    // expected: usage_required (A58/A82 "no silent 0"); observed: ok, charged 0 (priced as if first units of period)
    expect(c).toMatchObject({ ok: false, reason: "usage_required" });
  });
});

describe("hold with repeated (meter, dims) lines", () => {
  it("cannot be captured even when dims are given", async () => {
    const mem = memoryAdapters({ rates: { sms: flat(100) } });
    const m = buildMetering()
      .context(z.object({ accountId: z.string() }))
      .meter("sms", { country: z.string() })
      .getRate(mem.getRate)
      .commit(mem.commit);
    const h = await m.hold([{ meter: "sms", dims: { country: "TR" }, quantity: 2 }, { meter: "sms", dims: { country: "TR" }, quantity: 3 }], ref, ctx);
    if (!h.ok) throw new Error(h.reason);
    const c = await m.capture(h, [{ meter: "sms", dims: { country: "TR" }, quantity: 5 }], ctx);
    expect(c).toMatchObject({ ok: true, charged: 500 });
  });
});
