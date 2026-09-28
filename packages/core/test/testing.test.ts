import { describe, expect, it } from "vitest";
import { defineRate, microUsd, price, usd, type Plan } from "pricemeter";
import { commitContract, expectPlan, memoryAdapters } from "pricemeter/testing";

describe("/testing", () => {
  it("memoryAdapters satisfies the commit contract (prepaid)", async () => {
    const res = await commitContract({
      make: () => {
        const m = memoryAdapters({ prepaid: true });
        return {
          commit: m.commit,
          seed: (a, n) => m.store.credit(a, n),
          snapshot: (a) => ({ usage: m.store.usage.length, ledger: m.store.ledger.length, available: m.store.available(a) }),
        };
      },
    });
    expect(res.checks.filter((c) => !c.ok)).toEqual([]);
    expect(res.checks).toHaveLength(7);
  });

  it("commitContract reports broken adapters", async () => {
    const res = await commitContract({
      make: () => {
        const rows: Plan[] = [];
        return {
          commit: async (p) => void rows.push(p), // not idempotent, no balance
          seed: () => {},
          snapshot: () => ({ usage: rows.length, ledger: rows.length, available: 0 }),
        };
      },
    });
    expect(res.ok).toBe(false);
    expect(res.checks.find((c) => c.name.startsWith("repeated"))).toMatchObject({ ok: false });
    const post = await commitContract({ prepaid: false, make: () => ({ commit: async () => {}, seed: () => {}, snapshot: () => ({ usage: 0, ledger: 0, available: 0 }) }) });
    expect(post.checks).toHaveLength(5);
    expect(post.checks.every((c) => !c.ok)).toBe(true);
  });

  it("memory store: counters per period, rate functions, setRate", async () => {
    const m = memoryAdapters({
      periodOf: (at) => (at < 100 ? "p1" : "p2"),
      rates: { a: (dims) => (dims.x === 1 ? { rate: defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1 }] }), usedSoFar: 99 } : null) },
    });
    expect(await m.getRate("a", { x: 1 }, { accountId: "acc" }, 0)).toMatchObject({ usedSoFar: 99 });
    expect(await m.getRate("a", { x: 2 }, { accountId: "acc" }, 0)).toBeNull();
    expect(await m.getRate("b", {}, { accountId: "acc" }, 0)).toBeNull();
    await m.commit({
      ledger: [],
      usage: [
        { account: "acc", meter: "a", dims: {}, quantity: 3, amount: microUsd(0), detail: { breakdown: [] }, refType: "t", refId: "1", at: 5 },
        { account: "acc", meter: "a", dims: {}, quantity: 4, amount: microUsd(0), detail: { breakdown: [] }, refType: "t", refId: "2", at: 150 },
      ],
    });
    expect(m.store.used("acc", "a", "p1")).toBe(3);
    expect(m.store.used("acc", "a", 150)).toBe(4);
    expect(m.store.used("acc", "a")).toBe(4); // period of now → p2
    expect(m.store.commits).toBe(1);
  });

  it("expectPlan matches partially and explains mismatches", () => {
    const p = price(
      [{ meter: "m", dims: { a: 1 }, quantity: 2, rate: defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 5 }] }) }],
      { type: "t", id: "1" },
      { accountId: "acc" },
      { at: 7 },
    ).plan;
    expectPlan(p, { ledger: [{ amount: 10 as never }], usage: [{ dims: { a: 1 }, detail: { breakdown: [{ quantity: 2 }] } }] });
    expect(() => expectPlan(p, { ledger: [] })).toThrow(/expected 0 rows, got 1/);
    expect(() => expectPlan(p, { ledger: [{ amount: 11 as never }] })).toThrow(/plan.ledger\[0\].amount: expected 11, got 10/);
    expect(() => expectPlan(p, { usage: [{ dims: { a: { b: 1 } } as never }] })).toThrow(/expected an object/);
    expect(() => expectPlan(p, { usage: [{ detail: { breakdown: [] } }] })).toThrow(/expected 0 items/);
  });
});

describe("money", () => {
  it("usd and microUsd", () => {
    expect(usd(0.05)).toBe(50_000);
    expect(usd(1.15)).toBe(1_150_000);
    expect(() => microUsd(1.5)).toThrow(RangeError);
    expect(() => microUsd(2 ** 60)).toThrow(RangeError);
  });
});

describe("price() edge cases", () => {
  const r = defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 100, per: 3 }], policy: { rounding: "cumulative" } });
  it("cumulative single tier works with a carry instead of usedSoFar", () => {
    const p = price([{ meter: "m", quantity: 1, rate: r, carry: 0.9 }], { type: "t", id: "1" }, { accountId: "a" });
    expect(p.result).toMatchObject({ ok: true, charged: 34 });
    expect(p.plan.usage[0]!.detail.carry).toBeCloseTo(0.2333, 3);
    expect(price([{ meter: "m", quantity: 1, rate: r }], { type: "t", id: "1" }, { accountId: "a" }).result).toMatchObject({ reason: "usage_required" });
  });
  it("volume adjustment rows carry the rate id", () => {
    const v = defineRate({ model: "volume", id: "v1", tiers: [{ from: 0, unitPriceMicroUsd: 10 }, { from: 5, unitPriceMicroUsd: 1 }], policy: { adjustmentTiming: "on_crossing" } });
    const p = price([{ meter: "m", quantity: 2, rate: v, usedSoFar: 4 }], { type: "t", id: "1" }, { accountId: "a" }, { at: 1 });
    expect(p.plan.usage.map((u) => [u.refId, u.amount, u.rateId])).toEqual([
      ["t:1:m", 2, "v1"],
      ["t:1:m:adj", -36, "v1"],
    ]);
    expect(p.result).toMatchObject({ charged: -34, lines: [{ adjustment: -36 }] });
    expect(() => price([{ meter: "m", quantity: 2 ** 60, rate: v, usedSoFar: 0 }], { type: "t", id: "1" }, { accountId: "a" })).toThrow(RangeError);
  });
});
