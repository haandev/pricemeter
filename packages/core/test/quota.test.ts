import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMetering, QuotaExceeded, type Plan, type Rate } from "pricemeter";
import { monthKey, monthWindow } from "pricemeter/calendar";
import { accountUsed, commitReply, doCommit, migrateAccount } from "pricemeter/cloudflare";
import { sqliteAdapter } from "pricemeter/sqlite";
import { memoryAdapters } from "pricemeter/testing";
import { fakeStorage } from "./cloudflare-shim.js";

const free: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }] };
const ctx = { accountId: "acme", plan: "free" as const };
const ref = (id: string) => ({ type: "api" as const, id });

/** Free plan: 10 calls and 3 exports a month; exports aren't in the plan for "trial". Pool: 5 messages. */
function setup(opts: { limitOf?: (meter: string, plan: string) => number | undefined } = {}) {
  const mem = memoryAdapters();
  const limitOf = opts.limitOf ?? ((meter: string, plan: string) => (plan === "pro" || meter === "msg/sms" ? undefined : meter === "api/call" ? 10 : meter === "msg/pool" ? 5 : 3));
  const m = buildMetering()
    .context(z.object({ accountId: z.string(), plan: z.enum(["free", "pro", "trial"]) }))
    .refs(["api"])
    .meter("msg/pool")
    .meter("msg/sms", { country: z.string() }, { feeds: { "msg/pool": 1 } })
    .meter("api/call", { route: z.string() })
    .meter("api/export")
    .getRate(async (meter, _dims, c, _at) => {
      const limit = c.plan === "trial" && meter === "api/export" ? 0 : limitOf(meter, c.plan);
      return { rate: free, usedSoFar: mem.store.used(c.accountId, meter), ...(limit === undefined ? {} : { limit }) };
    })
    .commit(mem.commit);
  return { m, mem };
}

describe("quota", () => {
  it("allows up to the limit, then refuses the whole call and writes nothing", async () => {
    const { m, mem } = setup();
    expect(await m.observe("api/call", { route: "/a" }, 6, ref("1"), ctx)).toMatchObject({ ok: true });
    expect(await m.observe("api/call", { route: "/b" }, 3, ref("2"), ctx)).toMatchObject({ ok: true });
    const r = await m.observe("api/call", { route: "/a" }, 4, ref("3"), ctx);
    expect(r).toEqual({ ok: false, reason: "quota_exceeded", meter: "api/call", cause: { meter: "api/call", limit: 10, used: 9, requested: 4 } });
    expect(mem.store.used("acme", "api/call")).toBe(9);
    // the app decides about partial use: 1 is left
    expect(await m.observe("api/call", { route: "/a" }, 1, ref("4"), ctx)).toMatchObject({ ok: true });
    expect(await m.observe("api/call", { route: "/a" }, 1, ref("5"), ctx)).toMatchObject({ reason: "quota_exceeded" });
  });

  it("no limit on other plans; limit 0 means not in the plan", async () => {
    const { m } = setup();
    expect(await m.observe("api/call", { route: "/a" }, 50, ref("1"), { ...ctx, plan: "pro" })).toMatchObject({ ok: true });
    expect(await m.observe("api/export", {}, 1, ref("2"), { ...ctx, plan: "trial" })).toMatchObject({ reason: "quota_exceeded", cause: { limit: 0 } });
  });

  it("lines of the same meter add up across dims within one call", async () => {
    const { m } = setup();
    const r = await m.observe(
      [
        { meter: "api/call", dims: { route: "/a" }, quantity: 6 },
        { meter: "api/call", dims: { route: "/b" }, quantity: 5 },
      ],
      ref("1"),
      ctx,
    );
    expect(r).toMatchObject({ reason: "quota_exceeded", cause: { used: 6, requested: 5 } });
  });

  it("a pool limit caps every channel that feeds it", async () => {
    const { m, mem } = setup();
    expect(await m.observe("msg/sms", { country: "TR" }, 4, ref("1"), ctx)).toMatchObject({ ok: true });
    expect(await m.observe("msg/sms", { country: "DE" }, 2, ref("2"), ctx)).toMatchObject({ reason: "quota_exceeded", meter: "msg/pool" });
    expect(mem.store.used("acme", "msg/sms")).toBe(4);
  });

  it("holds check the reserved quantity; extend checks the total; capture always records", async () => {
    const { m } = setup();
    expect(await m.hold("api/export", {}, 4, ref("h0"), ctx)).toMatchObject({ reason: "quota_exceeded" });
    const h = await m.hold("api/export", {}, 2, ref("h1"), ctx);
    if (!h.ok) throw new Error(h.reason);
    expect(await m.extend(h, [{ meter: "api/export", quantity: 2 }], ctx)).toMatchObject({ reason: "quota_exceeded" });
    const e = await m.extend(h, [{ meter: "api/export", quantity: 1 }], ctx);
    if (!e.ok) throw new Error(e.reason);
    expect(await m.capture(e, [{ meter: "api/export", quantity: 3 }], ctx)).toMatchObject({ ok: true });
  });

  it("the commit gate closes the race the early check can't see", async () => {
    const { m, mem } = setup();
    await m.observe("api/call", { route: "/a" }, 9, ref("1"), ctx);
    // two requests read usedSoFar = 9 at the same time; both pass the early check
    const [a, b] = await Promise.all([m.plan.observe("api/call", { route: "/a" }, 1, ref("2"), ctx), m.plan.observe("api/call", { route: "/a" }, 1, ref("3"), ctx)]);
    expect([a.result.ok, b.result.ok]).toEqual([true, true]);
    expect(await m.commit(a.plan)).toEqual({ ok: true });
    expect(await m.commit(b.plan)).toMatchObject({ ok: false, reason: "quota_exceeded", meter: "api/call", cause: { used: 10, requested: 1, limit: 10 } });
    expect(mem.store.used("acme", "api/call")).toBe(10);
  });

  it("a limit needs usedSoFar; a bad limit is an invalid rate", async () => {
    const mem = memoryAdapters();
    const cat = buildMetering().meter("x");
    const noUsage = cat.bind({ getRate: async () => ({ rate: free, limit: 5 }), commit: mem.commit });
    expect(await noUsage.observe("x", {}, 1, ref("1"), ctx)).toMatchObject({ reason: "usage_required" });
    const bad = cat.bind({ getRate: async () => ({ rate: free, usedSoFar: 0, limit: -1 }), commit: mem.commit });
    expect(await bad.observe("x", {}, 1, ref("1"), ctx)).toMatchObject({ reason: "invalid_rate" });
  });
});

describe("quota in the reference adapters", () => {
  const row = (refId: string, quantity: number, at: number, limit = 5): Plan => ({
    ledger: [],
    usage: [{ account: "acme", meter: "api/call", dims: {}, quantity, amount: 0 as never, detail: { breakdown: [] }, refType: "api", refId, at, limit }],
  });
  const sep = Date.parse("2026-09-10T00:00:00Z");
  const oct = Date.parse("2026-10-10T00:00:00Z");

  it("sqlite counts in windowOf(row)", async () => {
    const a = sqliteAdapter({ db: new DatabaseSync(":memory:"), windowOf: (r) => monthWindow({ at: r.at }) });
    a.migrate();
    await a.commit(row("1", 5, sep));
    expect(() => a.commit(row("2", 1, sep))).toThrow(QuotaExceeded); // the SQLite commit is synchronous
    await a.commit(row("3", 5, oct)); // a new month
    await a.commit(row("1", 5, sep)); // a retry of a written row is not re-checked
    expect(a.usedSoFar({ account: "acme", meter: "api/call" })).toBe(10);
  });

  it("cloudflare: counted per period in the DO, and the refusal crosses RPC", async () => {
    const s = fakeStorage();
    migrateAccount(s.sql);
    const periodOf = (r: { at: number }) => monthKey({ at: r.at });
    const commit = doCommit(() => ({ commit: async (p: Plan) => commitReply(s, p, { periodOf }) }));
    await commit(row("1", 4, sep));
    const err = await Promise.resolve(commit(row("2", 2, sep))).catch((e: QuotaExceeded) => e);
    expect(err).toBeInstanceOf(QuotaExceeded);
    expect((err as QuotaExceeded).details).toEqual({ meter: "api/call", limit: 5, used: 4, requested: 2, account: "acme" });
    expect(accountUsed(s.sql, "api/call", "2026-09")).toBe(4);
    await commit(row("3", 5, oct));
    expect(accountUsed(s.sql, "api/call", "2026-10")).toBe(5);
  });
});
