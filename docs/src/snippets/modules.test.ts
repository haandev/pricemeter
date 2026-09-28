/** Code on the module pages. Each "without" region computes the same thing by hand. Runs with `bun run test` in docs/. */
import { describe, expect, it } from "vitest";
import { buildMetering, defineRate, type Plan, type Rate, type RateAnswer } from "pricemeter";
import { expectPlan, memoryAdapters } from "pricemeter/testing";
import { applyDiscount, layeredRates, scaleTiers, withPolicy, type PriceVersion } from "pricemeter/rates";
import { integrate, window } from "pricemeter/gauge";
import { flatCredit, minimumCommit, volumeTrueUp } from "pricemeter/adjustments";
import { cycleKey, cycleWindow, LIFETIME, monthKey, monthWindow } from "pricemeter/calendar";

const flat = (p: number): Rate => ({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: p }] });

const ctx = { accountId: "acc_1", plan: "pro" };
const at = Date.parse("2026-09-15T10:00:00Z");

describe("/rates", () => {
  it("layeredRates", async () => {
    // #region rates
    // import { layeredRates, type PriceVersion } from "pricemeter/rates";
    const rows: PriceVersion[] = [
      { id: "sms-list", meter: "sms", scope: "list", dims: { country: "*" }, effectiveFrom: 0, rate: flat(50_000) },
      { id: "sms-list-tr", meter: "sms", scope: "list", dims: { country: "TR" }, effectiveFrom: 0, rate: flat(20_000) },
      { id: "sms-pro-tr", meter: "sms", scope: "plan:pro", dims: { country: "TR" }, effectiveFrom: Date.parse("2026-09-01"), rate: flat(18_000) },
      { id: "sms-acc1", meter: "sms", scope: "account:acc_1", dims: { country: "DE" }, effectiveFrom: 0, rate: flat(30_000) },
      { id: "sms-acc1-tr-off", meter: "sms", scope: "account:acc_1", dims: { country: "TR" }, effectiveFrom: 0, removed: true },
    ];

    const getRate = layeredRates<{ accountId: string; plan: string }>({
      loadRows: (meter) => rows.filter((r) => r.meter === meter), // your DB query
      scopes: (ctx) => [`account:${ctx.accountId}`, `plan:${ctx.plan}`, "list"], // most specific first
      cacheMs: 60_000,
    });

    await getRate("sms", { country: "DE" }, ctx, at); // { rate: sms-acc1 (30000) }       account row
    await getRate("sms", { country: "TR" }, ctx, at); // { rate: sms-pro-tr (18000) }     account row removed → plan
    await getRate("sms", { country: "US" }, ctx, at); // { rate: sms-list (50000) }       wildcard in list
    // #endregion
    expect((await getRate("sms", { country: "DE" }, ctx, at))?.rate.id).toBe("sms-acc1");
    expect((await getRate("sms", { country: "TR" }, ctx, at))?.rate.id).toBe("sms-pro-tr");
    expect((await getRate("sms", { country: "US" }, ctx, at))?.rate.id).toBe("sms-list");
    expect((await getRate("sms", { country: "TR" }, ctx, Date.parse("2026-08-01")))?.rate.id).toBe("sms-list-tr");

    // #region rates-without
    // Without /rates: a getRate over your own table, in whatever order your product needs.
    const byHand = async (meter: string, dims: { country: string }, c: typeof ctx, t: number): Promise<RateAnswer | null> => {
      for (const scope of [`account:${c.accountId}`, `plan:${c.plan}`, "list"]) {
        const candidates = rows
          .filter((r) => r.meter === meter && r.scope === scope && r.effectiveFrom <= t)
          .filter((r) => r.dims?.country === dims.country || r.dims?.country === "*")
          .sort((a, b) => Number(b.dims?.country !== "*") - Number(a.dims?.country !== "*") || b.effectiveFrom - a.effectiveFrom);
        const best = candidates[0];
        if (best && !best.removed) return { rate: { ...best.rate!, id: best.id } };
      }
      return null;
    };
    // #endregion
    for (const country of ["DE", "TR", "US"]) {
      expect((await byHand("sms", { country }, ctx, at))?.rate).toEqual((await getRate("sms", { country }, ctx, at))?.rate);
    }
  });

  it("helpers", () => {
    // #region rates-helpers
    const list: Rate = { id: "api", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1_000 }, { from: 10_000, unitPriceMicroUsd: 800 }] };
    applyDiscount({ rate: list, percent: 15 }); // prices × 0.85, id "api-15pct"
    scaleTiers({ rate: list, factor: 0.5 }); //   the cheaper tier starts at 5,000
    withPolicy({ rate: list, policy: { rounding: "cumulative" } });
    // #endregion
    expect(applyDiscount({ rate: list, percent: 15 })).toMatchObject({ id: "api-15pct", tiers: [{ unitPriceMicroUsd: 850 }, { unitPriceMicroUsd: 680 }] });
    expect(scaleTiers({ rate: list, factor: 0.5 }).tiers[1]!.from).toBe(5_000);
  });
});

describe("/gauge", () => {
  it("integrate", () => {
    // #region gauge
    // import { integrate, window } from "pricemeter/gauge";
    const sept = window({ from: Date.parse("2026-09-01T00:00:00Z"), to: Date.parse("2026-10-01T00:00:00Z") });
    const seats = [
      { at: Date.parse("2026-08-20T00:00:00Z"), value: 2 }, // before the window: the starting level
      { at: Date.parse("2026-09-16T00:00:00Z"), value: 3 }, // one seat added mid-month
    ];
    integrate({ samples: seats, window: sept, mode: "last" }); //                      3
    integrate({ samples: seats, window: sept, mode: "max" }); //                       3
    integrate({ samples: seats, window: sept, mode: "time_weighted", unit: "s" }); //  6_480_000 seat-seconds
    // 2 seats × 30 days + 1 seat × 15 days = 75 seat-days = 6,480,000 seat-seconds
    // #endregion
    expect(integrate({ samples: seats, window: sept, mode: "last" })).toBe(3);
    expect(integrate({ samples: seats, window: sept, mode: "time_weighted", unit: "s" })).toBe(6_480_000);

    // #region gauge-without
    // Without /gauge: walk the step function yourself.
    let level = 0;
    let t = sept.from;
    let area = 0;
    for (const s of [...seats].sort((a, b) => a.at - b.at)) {
      if (s.at <= sept.from) level = s.value;
      else if (s.at < sept.to) {
        area += level * (s.at - t);
        [t, level] = [s.at, s.value];
      }
    }
    area += level * (sept.to - t);
    Math.ceil(area / 1000); // 6_480_000 — then remember float noise, unsorted input and negative values
    // #endregion
    expect(Math.ceil(area / 1000)).toBe(6_480_000);
  });
});

describe("/adjustments", () => {
  it("minimumCommit, flatCredit, volumeTrueUp", async () => {
    const mem = memoryAdapters({ rates: { api: flat(1_000) } });
    const metering = buildMetering().refs(["req", "period", "coupon"]).meter("api").bind(mem);
    await metering.observe("api", {}, 30_000, { type: "req", id: "r1" }, { accountId: "acme" }); // $30 spent
    // #region adjustments
    // import { flatCredit, minimumCommit, volumeTrueUp } from "pricemeter/adjustments";
    // Period close: $100 minimum commitment, $30 spent → charge the $70 shortfall.
    const plan = minimumCommit({
      account: "acme",
      minimumMicroUsd: 100_000_000,
      spentMicroUsd: 30_000_000, // e.g. sqliteAdapter.spent({ account, from, to })
      period: "2026-09",
      at: Date.parse("2026-10-01T00:00:00Z"),
    });
    // plan.ledger → [{ op: "charge", amount: 70000000, refType: "period", refId: "minimum_commit:acme:2026-09" }]
    await metering.commit(plan); // { ok: true } — and again on a retried cron: still one row

    flatCredit({ account: "acme", amountMicroUsd: 10_000_000, refType: "coupon", refId: "WELCOME10:acme", at });
    // → one charge of −10000000
    // #endregion
    expect(plan.ledger).toMatchObject([{ op: "charge", amount: 70_000_000, refType: "period", refId: "minimum_commit:acme:2026-09" }]);
    expect(await metering.commit(plan)).toEqual({ ok: true });
    expect(mem.store.ledger.filter((l) => l.refId.startsWith("minimum_commit"))).toHaveLength(1);
    expect(flatCredit({ account: "acme", amountMicroUsd: 10_000_000, refType: "coupon", refId: "WELCOME10:acme", at }).ledger[0]!.amount).toBe(-10_000_000);

    // #region adjustments-without
    // Without /adjustments: it is just a Plan. What matters is the stable refId.
    const shortfall = 100_000_000 - 30_000_000;
    const byHand: Plan = {
      ledger: shortfall > 0 ? [{ op: "charge", account: "acme", amount: shortfall as never, refType: "period", refId: "minimum_commit:acme:2026-09", at }] : [],
      usage: [],
    };
    await metering.commit(byHand);
    // #endregion
    expect(mem.store.ledger.filter((l) => l.refId.startsWith("minimum_commit"))).toHaveLength(1);
  });

  it("volumeTrueUp", () => {
    // #region trueup
    const rate = defineRate({ model: "volume", tiers: [{ from: 0, unitPriceMicroUsd: 10_000 }, { from: 1_000, unitPriceMicroUsd: 8_000 }] });
    // 900 then 200 units were charged at the tier each landed in: 9,000,000 + 1,600,000
    volumeTrueUp({ account: "acme", meter: "api", rate, quantity: 1_100, chargedMicroUsd: 10_600_000, refType: "period", refId: "true_up:api:2026-09", at });
    // → ledger [{ op: "charge", amount: -1800000 }], usage [{ quantity: 0, amount: -1800000, detail: { adjustment: true, … } }]
    // #endregion
    expect(volumeTrueUp({ account: "acme", meter: "api", rate, quantity: 1_100, chargedMicroUsd: 10_600_000, refType: "period", refId: "true_up:api:2026-09", at }).ledger).toMatchObject([
      { amount: -1_800_000 },
    ]);
  });
});

describe("/calendar", () => {
  it("keys and windows", () => {
    // #region calendar
    // import { LIFETIME, cycleKey, cycleWindow, monthKey, monthWindow } from "pricemeter/calendar";
    const t = Date.parse("2026-09-30T22:30:00Z"); // already October 1st in Istanbul (UTC+3)

    monthKey({ at: t }); //                            "2026-09"
    monthKey({ at: t, tz: "Europe/Istanbul" }); //     "2026-10"
    monthWindow({ at: t, tz: "Europe/Istanbul" }); //  { from: 2026-09-30T21:00Z, to: 2026-10-31T21:00Z }

    // A subscription started on Jan 31st renews on the last day of shorter months.
    const anchor = Date.parse("2026-01-31T00:00:00Z");
    cycleKey({ at: Date.parse("2026-03-10T00:00:00Z"), anchor }); //    "2026-02-28"
    cycleWindow({ at: Date.parse("2026-03-10T00:00:00Z"), anchor }); // { from: 2026-02-28, to: 2026-03-31 }

    LIFETIME; // "*" — the period key for counters that never reset
    // #endregion
    expect(monthKey({ at: t })).toBe("2026-09");
    expect(monthKey({ at: t, tz: "Europe/Istanbul" })).toBe("2026-10");
    expect(monthWindow({ at: t, tz: "Europe/Istanbul" })).toEqual({ from: Date.parse("2026-09-30T21:00:00Z"), to: Date.parse("2026-10-31T21:00:00Z") });
    expect(cycleKey({ at: Date.parse("2026-03-10T00:00:00Z"), anchor })).toBe("2026-02-28");
    expect(cycleWindow({ at: Date.parse("2026-03-10T00:00:00Z"), anchor })).toEqual({ from: Date.parse("2026-02-28T00:00:00Z"), to: Date.parse("2026-03-31T00:00:00Z") });
    expect(LIFETIME).toBe("*");
  });

  it("in getRate", async () => {
    // #region calendar-getrate
    const mem = memoryAdapters({ rates: { sms: flat(0) }, periodOf: (at) => monthKey({ at, tz: "Europe/Istanbul" }) });
    const metering = buildMetering()
      .context<{ accountId: string; tz: string }>()
      .refs(["send"])
      .meter("sms")
      .getRate(async (meter, _dims, ctx, at) => ({
        rate: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }, { from: 500, unitPriceMicroUsd: 20_000 }], policy: { tierPeriod: "month" } },
        usedSoFar: mem.store.used(ctx.accountId, meter, monthKey({ at, tz: ctx.tz })), // this local month's counter
      }))
      .commit(mem.commit);
    // #endregion
    const r = await metering.observe("sms", {}, 501, { type: "send", id: "1" }, { accountId: "a", tz: "Europe/Istanbul" }, { at });
    expect(r).toMatchObject({ ok: true, charged: 20_000 });
  });
});

describe("/testing", () => {
  it("memoryAdapters + expectPlan", async () => {
    // #region testing
    // import { expectPlan, memoryAdapters } from "pricemeter/testing";
    const mem = memoryAdapters({
      rates: { "otp/sms": (dims) => (dims.country === "TR" ? flat(20_000) : null) }, // a Rate, or a function of (dims, ctx, at)
      prepaid: true,
      balances: { acme: 1_000_000 },
      periodOf: (at) => monthKey({ at }), // usedSoFar per (account, meter, month)
    });
    const metering = buildMetering().refs(["otp_send"]).meter("otp/sms", ["country"]).bind(mem);

    const { plan } = await metering.plan.observe("otp/sms", { country: "TR" }, 2, { type: "otp_send", id: "m1" }, { accountId: "acme" }, { at });
    expectPlan(plan, {
      ledger: [{ op: "charge", amount: 40_000 }], //        only the fields you give are compared…
      usage: [{ meter: "otp/sms", dims: { country: "TR" } }], // …but the row count must match
    });

    mem.store.available("acme"); // 1_000_000 — plan.* never commits
    mem.store.used("acme", "otp/sms", at); // 0
    // #endregion
    expect(mem.store.available("acme")).toBe(1_000_000);
    await metering.observe("otp/sms", { country: "TR" }, 2, { type: "otp_send", id: "m1" }, { accountId: "acme" }, { at });
    expect(mem.store.used("acme", "otp/sms", at)).toBe(2);
    expect(mem.store.commits).toBe(1);
    expect(() => expectPlan(plan, { ledger: [] })).toThrow(/expected 0 rows, got 1/);
  });
});

