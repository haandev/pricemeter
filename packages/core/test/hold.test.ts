import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMetering, defineRate, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const flat = (p: number): Rate => ({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: p }] });
const ctx = { accountId: "acc" };

function setup(rates: Record<string, Rate> = {}, balance = 1_000_000) {
  const mem = memoryAdapters({
    prepaid: true,
    balances: { acc: balance },
    rates: {
      "msg/pool": { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }, { from: 1000, unitPriceMicroUsd: 1 }] },
      "otp/sms": flat(20_000),
      "otp/voice": flat(50_000),
      ...rates,
    },
  });
  const m = buildMetering()
    .context(z.object({ accountId: z.string() }))
    .refs(["otp_send"])
    .meter("msg/pool")
    .meter("otp/sms", { country: z.string() }, { feeds: { "msg/pool": 1 } })
    .meter("otp/voice", { country: z.string() })
    .getRate(mem.getRate)
    .commit(mem.commit);
  return { m, mem };
}

const ref = { type: "otp_send" as const, id: "otp_1" };

describe("hold / capture / release", () => {
  it("reserves the upper bound, captures actual, releases the rest", async () => {
    const { m, mem } = setup();
    const h = await m.hold(
      [
        { meter: "otp/sms", dims: { country: "TR" }, quantity: 3 },
        { meter: "otp/voice", dims: { country: "TR" }, quantity: 1 },
      ],
      ref,
      ctx,
      { at: 10 },
    );
    if (!h.ok) throw new Error(h.reason);
    expect(h.holdId).toBe("otp_send:otp_1");
    expect(h.upperBound).toBe(3 * 20_000 + 50_000 + 3); // pool: most expensive tier (1) × 3
    expect(h.lines.map((l) => [l.meter, l.quantity])).toEqual([
      ["otp/sms", 3],
      ["otp/voice", 1],
      ["msg/pool", 3],
    ]);
    expect(mem.store.account("acc")).toEqual({ balance: 1_000_000, reserved: h.upperBound });

    const c = await m.capture(h, [{ meter: "otp/sms", quantity: 2 }], ctx, { at: 20 });
    if (!c.ok) throw new Error(c.reason);
    expect(c.charged).toBe(40_000);
    expect(c.lines.map((l) => [l.meter, l.quantity, l.amount])).toEqual([
      ["otp/sms", 2, 40_000],
      ["msg/pool", 2, 0],
    ]);
    expect(mem.store.usage.map((u) => u.refId)).toEqual(["otp_send:otp_1:otp/sms:capture:1", "otp_send:otp_1:otp/sms:msg/pool:capture:1"]);
    expect(mem.store.usage[0]!.detail.holdId).toBe("otp_send:otp_1");

    const r = await m.release(c.hold, ctx, { at: 30 });
    expect(r.ok).toBe(true);
    expect(mem.store.account("acc")).toEqual({ balance: 1_000_000 - 40_000, reserved: 0 });
    // the value object is closed
    expect(await m.release(r.ok ? r.hold : c.hold, ctx)).toMatchObject({ ok: false, reason: "hold_closed" });
    expect(await m.capture(r.ok ? r.hold : c.hold, [{ meter: "otp/sms", quantity: 1 }], ctx)).toMatchObject({ ok: false, reason: "hold_closed" });
  });

  it("repeated capture of the same hold value is idempotent", async () => {
    const { m, mem } = setup();
    const h = await m.hold("otp/sms", { country: "TR" }, 2, ref, ctx);
    if (!h.ok) throw new Error();
    await m.capture(h, [{ meter: "otp/sms", quantity: 1 }], ctx);
    await m.capture(h, [{ meter: "otp/sms", quantity: 1 }], ctx); // retry with the same (stale) hold
    expect(mem.store.ledger.filter((l) => l.op === "capture")).toHaveLength(1);
  });

  it("partial captures telescope: the hold behaves like one observation", async () => {
    const r: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 150_000, per: 1_000_000 }], policy: { perObservation: { minMicroUsd: 1 } } };
    const { m } = setup({ "otp/voice": r });
    const h = await m.hold("otp/voice", { country: "TR" }, 10, ref, ctx);
    if (!h.ok) throw new Error();
    let hold = h.hold;
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const c = await m.capture(hold, [{ meter: "otp/voice", quantity: 1 }], ctx);
      if (!c.ok) throw new Error(c.reason);
      total += c.charged;
      hold = c.hold;
    }
    expect(total).toBe(2); // ceil(10 × 0.15), not 10 × ceil(0.15)
    expect(hold.captured).toBe(2);
  });

  it("capture beyond the held quantity is refused", async () => {
    const { m } = setup();
    const h = await m.hold("otp/sms", { country: "TR" }, 2, ref, ctx);
    if (!h.ok) throw new Error();
    expect(await m.capture(h, [{ meter: "otp/sms", quantity: 3 }], ctx)).toMatchObject({ ok: false, reason: "hold_exceeded", meter: "otp/sms" });
    await expect(m.capture(h, [{ meter: "otp/voice", quantity: 1 }], ctx)).rejects.toThrow(/not part of hold/);
  });

  it("extend grows lines, adds meters and reserves the difference", async () => {
    const { m, mem } = setup();
    const h = await m.hold("otp/sms", { country: "TR" }, 1, ref, ctx);
    if (!h.ok) throw new Error();
    const e = await m.extend(
      h,
      [
        { meter: "otp/sms", dims: { country: "TR" }, quantity: 1 },
        { meter: "otp/voice", dims: { country: "TR" }, quantity: 1 },
      ],
      ctx,
    );
    if (!e.ok) throw new Error(e.reason);
    expect(e.hold.lines.map((l) => [l.meter, l.quantity])).toEqual([
      ["otp/sms", 2],
      ["msg/pool", 2],
      ["otp/voice", 1],
    ]);
    expect(e.upperBound).toBe(2 * 20_000 + 2 + 50_000);
    const ext = mem.store.ledger.find((l) => l.op === "extend")!;
    expect(ext).toMatchObject({ amount: e.upperBound - h.upperBound, refId: "otp_send:otp_1:extend:1" });
    const c = await m.capture(e, [{ meter: "otp/sms", quantity: 2 }, { meter: "otp/voice", quantity: 1 }], ctx);
    expect(c).toMatchObject({ ok: true, charged: 90_000 });
  });

  it("the hold keeps its tariff when the price list changes (B20)", async () => {
    const { m, mem } = setup();
    const h = await m.hold("otp/sms", { country: "TR" }, 1, ref, ctx);
    if (!h.ok) throw new Error();
    mem.store.setRate("otp/sms", flat(99_000));
    const c = await m.capture(h, [{ meter: "otp/sms", quantity: 1 }], ctx);
    expect(c).toMatchObject({ ok: true, charged: 20_000 });
  });

  it("capture-time price on request", async () => {
    const { m } = setup();
    const h = await m.hold("otp/sms", { country: "TR" }, 2, ref, ctx);
    if (!h.ok) throw new Error();
    const c = await m.capture(h, [{ meter: "otp/sms", quantity: 1 }], ctx, { rate: { "otp/sms": flat(15_000) } });
    expect(c).toMatchObject({ ok: true, charged: 15_000 });
    const over = await m.capture(h, [{ meter: "otp/sms", quantity: 2 }], ctx, { rate: flat(10_000_000) });
    expect(over).toMatchObject({ ok: false, reason: "hold_exceeded" });
    expect(await m.capture(h, [{ meter: "otp/sms", quantity: 1 }], ctx, { rate: { model: "x" } as never })).toMatchObject({ reason: "invalid_rate" });
  });

  it("prepaid: a hold larger than the balance is refused", async () => {
    const { m } = setup({}, 10_000);
    expect(await m.hold("otp/sms", { country: "TR" }, 1, ref, ctx)).toMatchObject({ ok: false, reason: "insufficient_credit" });
  });

  it("the account must match the hold", async () => {
    const { m } = setup();
    const h = await m.hold("otp/sms", { country: "TR" }, 1, ref, ctx);
    if (!h.ok) throw new Error();
    const other = { accountId: "other" };
    expect(await m.capture(h, [{ meter: "otp/sms", quantity: 1 }], other)).toMatchObject({ reason: "invalid_context" });
    expect(await m.extend(h, [{ meter: "otp/sms", dims: { country: "TR" }, quantity: 1 }], other)).toMatchObject({ reason: "invalid_context" });
    expect(await m.release(h, other)).toMatchObject({ reason: "invalid_context" });
  });

  it("plan.* returns the plan without writing", async () => {
    const { m, mem } = setup();
    const p = await m.plan.hold([{ meter: "otp/sms", dims: { country: "TR" }, quantity: 1 }], ref, ctx, { at: 1 });
    expect(p.plan.ledger).toEqual([{ op: "hold", holdId: "otp_send:otp_1", account: "acc", amount: 20_001, refType: "otp_send", refId: "otp_send:otp_1:hold", at: 1 }]);
    expect(mem.store.ledger).toHaveLength(0);
    if (!p.result.ok) throw new Error();
    const c = await m.plan.capture(p.result.hold, [{ meter: "otp/sms", quantity: 1 }], ctx);
    expect(c.plan.ledger.map((l) => l.op)).toEqual(["capture"]);
    const e = await m.plan.extend(p.result.hold, [{ meter: "otp/sms", dims: { country: "TR" }, quantity: 1 }], ctx);
    expect(e.plan.ledger.map((l) => l.op)).toEqual(["extend"]);
    const r = await m.plan.release(p.result.hold, ctx);
    expect(r.plan.ledger).toMatchObject([{ op: "release", amount: 20_001 }]);
  });
});

describe("property: hold upper bound ≥ capture total", () => {
  const tiers = fc
    .array(fc.record({ gap: fc.integer({ min: 1, max: 50 }), price: fc.integer({ min: 0, max: 5000 }), flat: fc.integer({ min: 0, max: 100 }) }), { minLength: 1, maxLength: 4 })
    .map((xs) => {
      let from = 0;
      return xs.map((x, i) => ({ from: i ? (from += x.gap) : 0, unitPriceMicroUsd: x.price, flatMicroUsd: x.flat }));
    });
  const rateArb = fc.oneof(
    tiers.map((t) => ({ model: "graduated" as const, tiers: t })),
    tiers.map((t) => ({ model: "volume" as const, tiers: t, policy: { adjustmentTiming: "on_crossing" as const } })),
    fc.tuple(tiers, fc.integer({ min: 1, max: 20 })).map(([t, s]) => ({ model: "package" as const, tiers: t, packageSize: s })),
  );

  it("holds for any tariff, position and capture split", async () => {
    await fc.assert(
      fc.asyncProperty(rateArb, fc.nat(200), fc.array(fc.integer({ min: 0, max: 30 }), { minLength: 1, maxLength: 6 }), async (raw, used, caps) => {
        const r = defineRate(raw as Rate);
        const mem = memoryAdapters({ rates: { x: { rate: r, usedSoFar: used } as never } });
        const m = buildMetering().meter("x").bind({ getRate: async () => ({ rate: r, usedSoFar: used }), commit: mem.commit });
        const qty = caps.reduce((a, b) => a + b, 0);
        const h = await m.hold("x", {}, qty, { type: "t", id: "1" }, ctx);
        if (!h.ok) throw new Error(h.reason);
        let hold = h.hold;
        for (const q of caps) {
          const c = await m.capture(hold, [{ meter: "x", quantity: q }], ctx);
          if (!c.ok) throw new Error(`${c.reason} at ${JSON.stringify({ raw, used, caps })}`);
          hold = c.hold;
        }
        expect(hold.captured).toBeLessThanOrEqual(h.upperBound);
      }),
      { numRuns: 200 },
    );
  });
});
