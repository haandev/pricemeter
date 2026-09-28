import { type } from "arktype";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMetering, defineRate, InsufficientCredit, typed, type Plan, type Rate } from "pricemeter";
import { expectPlan, memoryAdapters } from "pricemeter/testing";

const flat = (p: number): Rate => ({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: p }] });

function catalog() {
  return buildMetering()
    .context(z.object({ accountId: z.string(), plan: z.enum(["free", "pro"]) }))
    .refs(z.enum(["otp_send", "otp_verify", "window", "period"]))
    .meter("msg/free_pool")
    .meter("otp/sms", { country: z.string().length(2) }, { feeds: { "msg/free_pool": 1 } })
    .meter("otp/whatsapp", { country: z.string().length(2) }, { feeds: { "msg/free_pool": 1 } })
    .meter("llm/credits")
    .meter("llm/output", { model: z.string() }, { feeds: { "llm/credits": (d, ctx) => (d.model === "opus" ? 5 : ctx.plan === "pro" ? 2 : 3) } })
    .meter("cc/conversation", { tier: z.enum(["short", "medium", "long"]) });
}

const ctx = { accountId: "acc_1", plan: "free" as const };

function setup(rates: Record<string, Rate | ((d: any) => Rate | null)> = {}, opts: { prepaid?: boolean; balances?: Record<string, number> } = {}) {
  const mem = memoryAdapters({
    rates: {
      "msg/free_pool": { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }, { from: 3, unitPriceMicroUsd: 1000 }] },
      "otp/sms": (d: { country: string }) => flat(d.country === "TR" ? 20_000 : 50_000),
      "otp/whatsapp": flat(10_000),
      "llm/credits": flat(100),
      "llm/output": flat(0),
      ...rates,
    },
    ...opts,
  });
  const m = catalog().getRate(mem.getRate).commit(mem.commit);
  return { m, mem };
}

describe("catalog", () => {
  it("exposes a flat, serializable meters view", () => {
    const m = catalog();
    expect(m.meters).toEqual({
      "msg/free_pool": { dims: [], feeds: [] },
      "otp/sms": { dims: ["country"], feeds: ["msg/free_pool"] },
      "otp/whatsapp": { dims: ["country"], feeds: ["msg/free_pool"] },
      "llm/credits": { dims: [], feeds: [] },
      "llm/output": { dims: ["model"], feeds: ["llm/credits"] },
      "cc/conversation": { dims: ["tier"], feeds: [] },
    });
    expect(JSON.parse(JSON.stringify(m.meters))).toEqual(m.meters);
  });

  it("rejects bad catalogs at definition time", () => {
    const b = buildMetering().meter("pool").meter("feeder", [], { feeds: { pool: 1 } });
    expect(() => b.meter("pool")).toThrow(/already defined/);
    // @ts-expect-error undefined pool
    expect(() => buildMetering().meter("x", [], { feeds: { nope: 1 } })).toThrow(/not defined yet/);
    // @ts-expect-error feeder cannot be a pool
    expect(() => b.meter("y", [], { feeds: { feeder: 1 } })).toThrow(/cannot be a pool/);
    // @ts-expect-error pools have no dims
    expect(() => buildMetering().meter("p", ["a"]).meter("y", [], { feeds: { p: 1 } })).toThrow(/without dims/);
    expect(() => buildMetering().meter("p").meter("y", [], { feeds: { p: -1 } })).toThrow(/non-negative/);
    expect(() => buildMetering().meter("x", 42 as never)).toThrow(TypeError);
    expect(() => buildMetering().meter("x", { a: 1 } as never)).toThrow(/Standard Schema/);
  });

  it("the same object is returned and mutated along the chain", () => {
    const a = buildMetering();
    const b = a.meter("x");
    expect(b).toBe(a);
  });

  it("observe before binding is a programming error", async () => {
    const m = catalog() as any;
    await expect(m.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "1" }, ctx)).rejects.toThrow(/getRate is not bound/);
    const g = catalog().getRate(async () => null) as any;
    await expect(g.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "1" }, ctx)).rejects.toThrow(/commit is not bound/);
    // plan.* needs only getRate
    const r = await g.plan.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "1" }, ctx);
    expect(r.result).toEqual({ ok: false, reason: "no_price", meter: "otp/sms" });
  });
});

describe("observe", () => {
  it("prices, expands the pool and commits one atomic plan", async () => {
    const { m, mem } = setup();
    const r = await m.observe("otp/sms", { country: "TR" }, 2, { type: "otp_send", id: "m1" }, ctx, { at: 1000 });
    expect(r).toMatchObject({ ok: true, charged: 40_000 });
    expectPlan({ ledger: mem.store.ledger, usage: mem.store.usage }, {
      ledger: [{ op: "charge", account: "acc_1", amount: 40_000 as never, refType: "otp_send", refId: "otp_send:m1:otp/sms", at: 1000 }],
      usage: [
        { meter: "otp/sms", dims: { country: "TR" }, quantity: 2, amount: 40_000 as never, refId: "otp_send:m1:otp/sms" },
        { meter: "msg/free_pool", dims: {}, quantity: 2, amount: 0 as never, refId: "otp_send:m1:otp/sms:msg/free_pool", detail: { feeder: "otp/sms", weight: 1 } },
      ],
    });
    // the pool is priced by its own usedSoFar: 2 used, next 2 cross into the paid tier (from 3)
    const r2 = await m.observe("otp/whatsapp", { country: "DE" }, 2, { type: "otp_send", id: "m2" }, ctx);
    expect(r2.ok && r2.lines.map((l) => [l.meter, l.amount])).toEqual([
      ["otp/whatsapp", 20_000],
      ["msg/free_pool", 1000],
    ]);
  });

  it("is idempotent: a retry with the same ref writes nothing new", async () => {
    const { m, mem } = setup();
    const ref = { type: "otp_send" as const, id: "m1" };
    await m.observe("otp/sms", { country: "TR" }, 1, ref, ctx, { at: 1 });
    await m.observe("otp/sms", { country: "TR" }, 1, ref, ctx, { at: 1 });
    expect(mem.store.usage).toHaveLength(2);
    expect(mem.store.ledger).toHaveLength(1);
  });

  it("weight functions see dims and ctx; pool quantity is ceil(q × w)", async () => {
    const { m, mem } = setup();
    await m.observe("llm/output", { model: "opus" }, 3, { type: "window", id: "w1" }, ctx);
    await m.observe("llm/output", { model: "haiku" }, 3, { type: "window", id: "w2" }, { ...ctx, plan: "pro" });
    const pool = mem.store.usage.filter((u) => u.meter === "llm/credits");
    expect(pool.map((u) => [u.quantity, u.detail.weight, u.amount])).toEqual([
      [15, 5, 1500],
      [6, 2, 600],
    ]);
  });

  it("feeds: false skips expansion; an explicit pool line is not duplicated", async () => {
    const { m } = setup();
    const a = await m.plan.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "1" }, ctx, { feeds: false });
    expect(a.plan.usage.map((u) => u.meter)).toEqual(["otp/sms"]);
    const b = await m.plan.observe(
      [
        { meter: "otp/sms", dims: { country: "TR" }, quantity: 1 },
        { meter: "msg/free_pool", quantity: 7 },
      ],
      { type: "otp_send", id: "1" },
      ctx,
    );
    expect(b.plan.usage.map((u) => [u.meter, u.quantity])).toEqual([
      ["otp/sms", 1],
      ["msg/free_pool", 7],
    ]);
  });

  it("multi-line observe: same meter lines advance usedSoFar for each other and get distinct refIds", async () => {
    const tiered: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 10 }, { from: 5, unitPriceMicroUsd: 1 }] };
    const { m } = setup({ "cc/conversation": tiered });
    const p = await m.plan.observe(
      [
        { meter: "cc/conversation", dims: { tier: "short" }, quantity: 4 },
        { meter: "cc/conversation", dims: { tier: "short" }, quantity: 4 },
      ],
      { type: "period", id: "p1" },
      ctx,
    );
    expect(p.plan.usage.map((u) => [u.refId, u.amount])).toEqual([
      ["period:p1:cc/conversation", 40],
      ["period:p1:cc/conversation#2", 10 + 3],
    ]);
  });

  it("usedSoFar option overrides getRate (single number or per meter)", async () => {
    const tiered: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 10 }, { from: 100, unitPriceMicroUsd: 1 }] };
    const { m } = setup({ "cc/conversation": tiered });
    const a = await m.plan.observe("cc/conversation", { tier: "long" }, 1, { type: "period", id: "p" }, ctx, { usedSoFar: 500 });
    expect(a.result.ok && a.result.charged).toBe(1);
    const b = await m.plan.observe([{ meter: "cc/conversation", dims: { tier: "long" }, quantity: 1 }], { type: "period", id: "p" }, ctx, {
      usedSoFar: { "cc/conversation": 500 },
    });
    expect(b.result.ok && b.result.charged).toBe(1);
  });

  it("three states: priced at 0, missing → reject, missing → free", async () => {
    const { m, mem } = setup({ "cc/conversation": flat(0) });
    const zero = await m.observe("cc/conversation", { tier: "short" }, 1, { type: "period", id: "z" }, ctx);
    expect(zero).toMatchObject({ ok: true, charged: 0 });
    expect(mem.store.usage.at(-1)).toMatchObject({ amount: 0 });
    expect(mem.store.ledger).toHaveLength(0); // zero amounts are counted, not charged

    mem.store.setRate("cc/conversation", undefined);
    const rej = await m.observe("cc/conversation", { tier: "short" }, 1, { type: "period", id: "r" }, ctx);
    expect(rej).toEqual({ ok: false, reason: "no_price", meter: "cc/conversation" });
    const free = await m.observe("cc/conversation", { tier: "short" }, 1, { type: "period", id: "f" }, ctx, { ifMissing: "free" });
    expect(free).toMatchObject({ ok: true, charged: 0 });
    expect(mem.store.usage.at(-1)).toMatchObject({ refId: "period:f:cc/conversation", amount: 0 });
    expect(mem.store.usage.at(-1)!.rateId).toBeUndefined();
  });

  it("usage_required when a tiered rate comes without usedSoFar", async () => {
    const tiered: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1 }, { from: 5, unitPriceMicroUsd: 0 }] };
    const m = catalog()
      .getRate(async () => ({ rate: tiered }))
      .commit(async () => {});
    const r = await m.observe("cc/conversation", { tier: "short" }, 1, { type: "period", id: "x" }, ctx);
    expect(r).toEqual({ ok: false, reason: "usage_required", meter: "cc/conversation" });
  });

  it("invalid context, dims, ref and rate are results, not exceptions", async () => {
    const { m } = setup({ "cc/conversation": { model: "graduated", tiers: [] } as never });
    const ref = { type: "period" as const, id: "x" };
    // @ts-expect-error plan must be free | pro
    const c = await m.observe("cc/conversation", { tier: "short" }, 1, ref, { accountId: "a", plan: "gold" });
    expect(c).toMatchObject({ ok: false, reason: "invalid_context" });
    // @ts-expect-error tier enum
    const d = await m.observe("cc/conversation", { tier: "huge" }, 1, ref, ctx);
    expect(d).toMatchObject({ ok: false, reason: "invalid_dims", meter: "cc/conversation" });
    // @ts-expect-error extra dimension
    const d2 = await m.observe("cc/conversation", { tier: "short", x: 1 }, 1, ref, ctx);
    expect(d2).toMatchObject({ ok: false, reason: "invalid_dims" });
    // @ts-expect-error unknown ref type
    const f = await m.observe("cc/conversation", { tier: "short" }, 1, { type: "nope", id: "1" }, ctx);
    expect(f).toMatchObject({ ok: false, reason: "invalid_ref" });
    const g = await m.observe("cc/conversation", { tier: "short" }, 1, ref, ctx);
    expect(g).toMatchObject({ ok: false, reason: "invalid_rate", meter: "cc/conversation" });
    // @ts-expect-error unknown meter
    await expect(m.observe("nope", {}, 1, ref, ctx)).rejects.toThrow(/unknown meter/);
    await expect(m.observe("cc/conversation", { tier: "short" }, -1, ref, ctx)).rejects.toThrow(RangeError);
  });

  it("context validation can be switched off", async () => {
    const mem = memoryAdapters({ rates: { x: flat(1) } });
    const m = buildMetering()
      .context(z.object({ accountId: z.string(), plan: z.string() }), { validate: "never" })
      .meter("x")
      .getRate(mem.getRate)
      .commit(mem.commit);
    const r = await m.observe("x", {}, 1, { type: "t", id: "1" }, { accountId: "a" } as never);
    expect(r.ok).toBe(true);
    // accountId is still required
    const bad = await m.observe("x", {}, 1, { type: "t", id: "1" }, {} as never);
    expect(bad).toMatchObject({ ok: false, reason: "invalid_context" });
  });

  it("commit errors map to results", async () => {
    const mem = memoryAdapters({ rates: { "otp/sms": flat(10) } });
    const base = catalog().getRate(mem.getRate);
    const broke = base.bind({
      getRate: mem.getRate,
      commit: async () => {
        throw new InsufficientCredit();
      },
    });
    const r = await broke.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "1" }, ctx, { feeds: false });
    expect(r).toMatchObject({ ok: false, reason: "insufficient_credit" });
    const named = base.bind({
      getRate: mem.getRate,
      commit: async () => {
        throw Object.assign(new Error("x"), { name: "InsufficientCredit" });
      },
    });
    expect(await named.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "1" }, ctx, { feeds: false })).toMatchObject({
      reason: "insufficient_credit",
    });
    const down = base.bind({
      getRate: mem.getRate,
      commit: () => {
        throw new Error("db down");
      },
    });
    const d = await down.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "1" }, ctx, { feeds: false });
    expect(d).toMatchObject({ ok: false, reason: "commit_failed" });
    expect((d as { cause: Error }).cause.message).toBe("db down");
  });

  it("prepaid memory adapter refuses and writes nothing", async () => {
    const { m, mem } = setup({}, { prepaid: true, balances: { acc_1: 30_000 } });
    const r = await m.observe("otp/sms", { country: "TR" }, 2, { type: "otp_send", id: "1" }, ctx);
    expect(r).toMatchObject({ ok: false, reason: "insufficient_credit" });
    expect(mem.store.usage).toHaveLength(0);
    const ok = await m.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "2" }, ctx);
    expect(ok.ok).toBe(true);
    expect(mem.store.available("acc_1")).toBe(10_000);
  });

  it("metering.commit writes an external plan", async () => {
    const { m, mem } = setup();
    const plan: Plan = { ledger: [{ op: "charge", account: "acc_1", amount: -5 as never, refType: "period", refId: "credit:1", at: 0 }], usage: [] };
    expect(await m.commit(plan)).toEqual({ ok: true });
    expect(mem.store.account("acc_1").balance).toBe(5);
    expect(await m.commit({ ledger: [], usage: [] })).toEqual({ ok: true });
  });
});

describe("metering.price()", () => {
  const sms = defineRate(flat(20_000));
  const pool = defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }, { from: 10, unitPriceMicroUsd: 5 }] });

  it("needs pool lines or opts.pools for feeders", () => {
    const m = catalog();
    const line = { meter: "otp/sms" as const, dims: { country: "TR" }, quantity: 1, rate: sms };
    expect(() => m.price([line], { type: "otp_send", id: "1" }, ctx)).toThrow(/msg\/free_pool/);
    const p = m.price([line], { type: "otp_send", id: "1" }, ctx, { pools: { "msg/free_pool": { rate: pool, usedSoFar: 10 } }, at: 5 });
    expect(p.plan.usage.map((u) => [u.meter, u.amount])).toEqual([
      ["otp/sms", 20_000],
      ["msg/free_pool", 5],
    ]);
    expect(m.price([line], { type: "otp_send", id: "1" }, ctx, { feeds: false }).plan.usage).toHaveLength(1);
  });

  it("re-prices lines from plan.observe (embedded mode)", async () => {
    const { m } = setup();
    const planned = await m.plan.observe("otp/sms", { country: "TR" }, 2, { type: "otp_send", id: "1" }, ctx, { at: 9 });
    // inside the DO: fresh counters
    const fresh = planned.lines.map((l) => (l.meter === "msg/free_pool" ? { ...l, usedSoFar: 100 } : l));
    const again = m.price(fresh as never, { type: "otp_send", id: "1" }, ctx);
    expect(again.plan.usage.map((u) => u.amount)).toEqual([40_000, 2000]);
    expect(again.plan.usage.map((u) => u.refId)).toEqual(planned.plan.usage.map((u) => u.refId));
  });
});

describe("dims in three forms, and other schema libraries", () => {
  it("valibot, arktype, typed and key arrays", async () => {
    const mem = memoryAdapters({ rates: { a: flat(1), b: flat(1), c: flat(1), d: flat(1) } });
    const m = buildMetering()
      .context(v.object({ accountId: v.string() }))
      .refs(["t"])
      .meter("a", { region: v.picklist(["eu", "us"]) })
      .meter("b", type({ size: "number" }))
      .meter("c", typed<{ sku: string }>())
      .meter("d", ["anything"])
      .getRate(mem.getRate)
      .commit(mem.commit);
    const ref = { type: "t" as const, id: "1" };
    expect((await m.observe("a", { region: "eu" }, 1, ref, { accountId: "x" })).ok).toBe(true);
    // @ts-expect-error region
    expect(await m.observe("a", { region: "asia" }, 1, ref, { accountId: "x" })).toMatchObject({ reason: "invalid_dims" });
    expect((await m.observe("b", { size: 3 }, 1, { type: "t", id: "2" }, { accountId: "x" })).ok).toBe(true);
    // @ts-expect-error size must be a number
    expect(await m.observe("b", { size: "3" }, 1, ref, { accountId: "x" })).toMatchObject({ reason: "invalid_dims" });
    // typed and key arrays are not validated at runtime
    expect((await m.observe("c", { sku: 1 as never }, 1, { type: "t", id: "3" }, { accountId: "x" })).ok).toBe(true);
    expect((await m.observe("d", { anything: { deep: 1 } }, 1, { type: "t", id: "4" }, { accountId: "x" })).ok).toBe(true);
    expect(m.meters.b.dims).toEqual(["size"]); // arktype .props
    expect(m.meters.a.dims).toEqual(["region"]);
    // @ts-expect-error ref not in the list
    expect(await m.observe("a", { region: "eu" }, 1, { type: "u", id: "1" }, { accountId: "x" })).toMatchObject({ reason: "invalid_ref" });
    expect(await m.observe("a", { region: "eu" }, 1, null as never, { accountId: "x" })).toMatchObject({ reason: "invalid_ref" });
  });

  it("async schemas are awaited", async () => {
    const mem = memoryAdapters({ rates: { a: flat(1) } });
    const m = buildMetering()
      .context(z.object({ accountId: z.string().refine(async (s) => s.startsWith("acc_")) }))
      .meter("a")
      .bind(mem);
    expect((await m.observe("a", {}, 1, { type: "t", id: "1" }, { accountId: "acc_1" })).ok).toBe(true);
    expect(await m.observe("a", {}, 1, { type: "t", id: "1" }, { accountId: "bad" })).toMatchObject({ reason: "invalid_context" });
  });

  it("context and refs accept plain types", async () => {
    const mem = memoryAdapters({ rates: { a: flat(1) } });
    const m = buildMetering().context<{ accountId: string; tz: string }>().refs<"x">().meter("a").bind(mem);
    expect((await m.observe("a", {}, 1, { type: "x", id: "1" }, { accountId: "a", tz: "UTC" })).ok).toBe(true);
    const m2 = buildMetering().context(typed<{ accountId: string }>()).refs(typed<"x">()).meter("a").bind(mem);
    expect((await m2.observe("a", {}, 1, { type: "x", id: "2" }, { accountId: "a" })).ok).toBe(true);
    expect(() => buildMetering().context(5 as never)).toThrow(TypeError);
    expect(() => buildMetering().refs(5 as never)).toThrow(TypeError);
    expect(() => buildMetering().getRate(5 as never)).toThrow(TypeError);
  });
});
