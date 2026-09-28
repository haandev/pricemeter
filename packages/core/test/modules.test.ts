import { describe, expect, it } from "vitest";
import { defineRate, type Rate } from "pricemeter";
import { flatCredit, minimumCommit, volumeTrueUp } from "pricemeter/adjustments";
import { cycleKey, cycleWindow, LIFETIME, monthKey, monthWindow } from "pricemeter/calendar";
import { integrate, window } from "pricemeter/gauge";
import { applyDiscount, layeredRates, resolveLayered, scaleTiers, validateVersion, withPolicy, type PriceVersion } from "pricemeter/rates";

const iso = (s: string) => Date.parse(s);

describe("/calendar", () => {
  it("month keys and windows in UTC and other zones", () => {
    expect(monthKey({ at: iso("2026-09-30T23:30:00Z") })).toBe("2026-09");
    expect(monthKey({ at: iso("2026-09-30T23:30:00Z"), tz: "Europe/Istanbul" })).toBe("2026-10");
    expect(monthWindow({ at: iso("2026-02-10T00:00:00Z") })).toEqual({ from: iso("2026-02-01T00:00:00Z"), to: iso("2026-03-01T00:00:00Z") });
    expect(monthWindow({ at: iso("2026-12-31T22:00:00Z"), tz: "Europe/Istanbul" })).toEqual({
      from: iso("2026-12-31T21:00:00Z"),
      to: iso("2027-01-31T21:00:00Z"),
    });
    // DST: New York month starting in EST, ending in EDT
    expect(monthWindow({ at: iso("2026-03-15T12:00:00Z"), tz: "America/New_York" })).toEqual({
      from: iso("2026-03-01T05:00:00Z"),
      to: iso("2026-04-01T04:00:00Z"),
    });
    expect(LIFETIME).toBe("*");
    expect(() => monthKey({ at: NaN })).toThrow(RangeError);
  });

  it("billing cycles follow the anchor day and clamp short months", () => {
    const anchor = iso("2026-01-31T10:00:00Z");
    expect(cycleKey({ at: iso("2026-02-15T00:00:00Z"), anchor })).toBe("2026-01-31");
    expect(cycleKey({ at: iso("2026-02-28T00:00:00Z"), anchor })).toBe("2026-02-28");
    expect(cycleWindow({ at: iso("2026-03-05T00:00:00Z"), anchor })).toEqual({ from: iso("2026-02-28T00:00:00Z"), to: iso("2026-03-31T00:00:00Z") });
    const mid = iso("2026-05-15T00:00:00Z");
    expect(cycleWindow({ at: iso("2026-09-14T23:59:59Z"), anchor: mid })).toEqual({ from: iso("2026-08-15T00:00:00Z"), to: iso("2026-09-15T00:00:00Z") });
    expect(cycleKey({ at: iso("2026-09-15T00:00:00Z"), anchor: mid })).toBe("2026-09-15");
    expect(cycleKey({ at: iso("2027-01-02T00:00:00Z"), anchor: iso("2026-12-20T00:00:00Z") })).toBe("2026-12-20");
    expect(cycleKey({ at: iso("2026-09-15T00:30:00Z"), anchor: mid, tz: "Europe/Istanbul" })).toBe("2026-09-15");
  });
});

describe("/gauge", () => {
  const w = window({ from: 0, to: 30_000 });
  const samples = [
    { at: -5000, value: 2 },
    { at: 10_000, value: 5 },
    { at: 20_000, value: 1 },
    { at: 40_000, value: 9 },
  ];
  it("last, max, time_weighted", () => {
    expect(integrate({ samples, window: w, mode: "last" })).toBe(1);
    expect(integrate({ samples, window: w, mode: "max" })).toBe(5);
    expect(integrate({ samples, window: w, mode: "time_weighted" })).toBe(2 * 10 + 5 * 10 + 1 * 10);
    expect(integrate({ samples, window: w, mode: "time_weighted", unit: "ms" })).toBe(80_000);
    expect(integrate({ samples: [], window: w, mode: "max" })).toBe(0);
    expect(integrate({ samples: [{ at: 0, value: 1.2 }], window: w, mode: "last" })).toBe(2);
    expect(integrate({ samples: [{ at: 0, value: 1 }], window: window({ from: 0, to: 3_600_000 }), mode: "time_weighted", unit: "h" })).toBe(1);
  });
  it("rejects bad input", () => {
    expect(() => window({ from: 5, to: 5 })).toThrow(RangeError);
    expect(() => integrate({ samples: [{ at: 0, value: -1 }], window: w, mode: "last" })).toThrow(RangeError);
  });
});

describe("/adjustments", () => {
  it("minimumCommit charges the shortfall once", () => {
    expect(minimumCommit({ account: "a", minimumMicroUsd: 100, spentMicroUsd: 30, period: "2026-09", at: 1 })).toEqual({
      ledger: [{ op: "charge", account: "a", amount: 70, refType: "period", refId: "minimum_commit:2026-09", at: 1 }],
      usage: [],
    });
    expect(minimumCommit({ account: "a", minimumMicroUsd: 100, spentMicroUsd: 130, period: "p", at: 1 })).toEqual({ ledger: [], usage: [] });
    expect(() => minimumCommit({ account: "a", minimumMicroUsd: 1.5, spentMicroUsd: 0, period: "p", at: 1 })).toThrow(RangeError);
  });
  it("flatCredit is a negative charge", () => {
    expect(flatCredit({ account: "a", amountMicroUsd: 5, refType: "coupon", refId: "c1", at: 2 }).ledger[0]).toMatchObject({ amount: -5 });
    expect(() => flatCredit({ account: "a", amountMicroUsd: 0, refType: "c", refId: "c", at: 0 })).toThrow(RangeError);
  });
  it("volumeTrueUp settles the period at its final tier", () => {
    const r = defineRate({
      model: "volume",
      id: "vol",
      tiers: [
        { from: 0, unitPriceMicroUsd: 10 },
        { from: 100, unitPriceMicroUsd: 8 },
      ],
    });
    // 150 units were charged along the way: 99 at 10 + 51 at 8 (observations priced at their own final tier)
    const p = volumeTrueUp({ account: "a", meter: "m", rate: r, quantity: 150, chargedMicroUsd: 99 * 10 + 51 * 8, refType: "period", refId: "trueup:m:p", at: 3 });
    expect(p.ledger[0]).toMatchObject({ amount: 150 * 8 - (990 + 408) });
    expect(p.usage[0]).toMatchObject({ quantity: 0, rateId: "vol", detail: { adjustment: true } });
    expect(volumeTrueUp({ account: "a", meter: "m", rate: r, quantity: 150, chargedMicroUsd: 1200, refType: "p", refId: "x", at: 0 })).toEqual({ ledger: [], usage: [] });
    expect(() => volumeTrueUp({ account: "a", meter: "m", rate: defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1 }] }), quantity: 1, chargedMicroUsd: 0, refType: "p", refId: "x", at: 0 })).toThrow(TypeError);
  });
});

describe("/rates", () => {
  const rate = (p: number): Rate => ({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: p }] });
  const rows: PriceVersion[] = [
    { id: "list-any", meter: "sms", scope: "list", effectiveFrom: 0, rate: rate(50) },
    { id: "list-tr", meter: "sms", scope: "list", dims: { country: "TR" }, effectiveFrom: 0, rate: rate(30) },
    { id: "list-tr-2", meter: "sms", scope: "list", dims: { country: "TR" }, effectiveFrom: 1000, rate: rate(25) },
    { id: "plan-pro", meter: "sms", scope: "plan:pro", dims: { country: "*" }, effectiveFrom: 0, rate: rate(20) },
    { id: "acc-a1", meter: "sms", scope: "account:a1", dims: { country: "TR" }, effectiveFrom: 0, rate: rate(10) },
    { id: "acc-a1-off", meter: "sms", scope: "account:a1", dims: { country: "TR" }, effectiveFrom: 5000, removed: true },
    { id: "other-meter", meter: "voice", scope: "account:a1", effectiveFrom: 0, rate: rate(1) },
  ];
  const resolve = (scopes: string[], dims: Record<string, unknown>, at: number) => resolveLayered({ rows, scopes, dims, at, meter: "sms" });

  it("scopes, specificity, versions and removals", () => {
    expect(resolve(["list"], { country: "DE" }, 0)?.id).toBe("list-any");
    expect(resolve(["list"], { country: "TR" }, 999)?.id).toBe("list-tr");
    expect(resolve(["list"], { country: "TR" }, 1000)?.id).toBe("list-tr-2");
    expect(resolve(["plan:pro", "list"], { country: "TR" }, 0)?.id).toBe("plan-pro");
    expect(resolve(["account:a1", "plan:pro", "list"], { country: "TR" }, 0)?.id).toBe("acc-a1");
    // account override removed → back to plan
    expect(resolve(["account:a1", "plan:pro", "list"], { country: "TR" }, 6000)?.id).toBe("plan-pro");
    expect(resolve(["account:a1"], { country: "TR" }, 6000)).toBeNull();
    // a rate's own id is kept
    expect(resolveLayered({ rows: [{ id: "v", meter: "sms", scope: "list", effectiveFrom: 0, rate: { ...rate(1), id: "own" } }], scopes: ["list"], dims: {}, at: 0 })?.id).toBe("own");
  });

  it("layeredRates: getRate with cache and usedSoFar", async () => {
    let loads = 0;
    let clock = 0;
    const getRate = layeredRates<{ accountId: string; plan: string }>({
      loadRows: async (meter) => {
        loads++;
        return rows.filter((r) => r.meter === meter);
      },
      scopes: (ctx) => [`account:${ctx.accountId}`, `plan:${ctx.plan}`, "list"],
      cacheMs: 1000,
      now: () => clock,
      usedSoFar: (_m, _d, _c, _at, r) => (r.tiers.length > 1 ? 7 : undefined),
    });
    const ctx = { accountId: "a1", plan: "pro" };
    expect(await getRate("sms", { country: "TR" }, ctx, 0)).toEqual({ rate: { ...rate(10), id: "acc-a1" } });
    await getRate("sms", { country: "DE" }, ctx, 0);
    expect(loads).toBe(1);
    clock = 2000;
    await getRate("sms", { country: "DE" }, ctx, 0);
    expect(loads).toBe(2);
    expect(await getRate("fax", {}, ctx, 0)).toBeNull();

    const tiered = layeredRates({
      loadRows: () => [{ id: "t", meter: "x", scope: "list", effectiveFrom: 0, rate: { model: "volume", tiers: [{ from: 0, unitPriceMicroUsd: 1 }] } }],
      scopes: () => ["list"],
      usedSoFar: () => 42,
    });
    expect(await tiered("x", undefined, { accountId: "a" }, 0)).toMatchObject({ usedSoFar: 42 });
  });

  it("validateVersion", () => {
    expect(validateVersion(rows[0]).ok).toBe(true);
    expect(validateVersion(rows[5]).ok).toBe(true);
    const bad = validateVersion({ id: "", meter: "m", scope: "list", effectiveFrom: "x", dims: { a: {} }, removed: "no", rate: { model: "graduated", tiers: [] } });
    expect(bad.ok ? [] : bad.errors.map((e) => e.path.join("."))).toEqual(["id", "effectiveFrom", "dims.a", "removed", "rate.tiers"]);
    expect(validateVersion(null).ok).toBe(false);
    expect(validateVersion({ id: "a", meter: "m", scope: "s", effectiveFrom: 0, dims: 5 }).ok).toBe(false);
  });

  it("transformers", () => {
    const base: Rate = { model: "graduated", id: "b", tiers: [{ from: 0, unitPriceMicroUsd: 1000, flatMicroUsd: 333 }, { from: 100, unitPriceMicroUsd: 999 }] };
    expect(applyDiscount({ rate: base, percent: 15 })).toEqual({
      model: "graduated",
      id: "b-15pct",
      tiers: [{ from: 0, unitPriceMicroUsd: 850, flatMicroUsd: 283 }, { from: 100, unitPriceMicroUsd: 849 }],
    });
    expect(() => applyDiscount({ rate: base, percent: 120 })).toThrow(RangeError);
    expect(applyDiscount({ rate: { ...base, id: undefined } as never, percent: 0 }).id).toBeUndefined();
    expect(scaleTiers({ rate: base, factor: 10 }).tiers.map((t) => t.from)).toEqual([0, 1000]);
    expect(() => scaleTiers({ rate: base, factor: 0 })).toThrow(RangeError);
    expect(withPolicy({ rate: { ...base, policy: { rounding: "cumulative" } }, policy: { perObservation: { maxMicroUsd: 5 } } }).policy).toEqual({
      rounding: "cumulative",
      perObservation: { maxMicroUsd: 5 },
    });
  });
});
