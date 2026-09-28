import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { D1_USAGE_SCHEMA, d1UsageSink } from "pricemeter/cloudflare";
import type { PriceVersion } from "pricemeter/rates";
import { AccountCore } from "../src/account.js";
import { createApp, type OtpRecord, type WindowMessage } from "../src/app.js";
import type { Context } from "../src/catalog.js";
import { PRICE_ROWS, type RouteCost } from "../src/prices.js";
import { fakeD1, fakeStorage } from "./shim.js";

const SEP = Date.parse("2026-09-10T12:00:00Z");

/** The whole system in memory: DOs over node:sqlite, D1, KV-like OTP store, a queue. */
function system(opts: { rows?: PriceVersion[]; routes?: RouteCost[]; balance?: number; sandbox?: string[] } = {}) {
  const d1 = fakeD1();
  d1.db.exec(D1_USAGE_SCHEMA);
  const sink = d1UsageSink(d1 as never);
  const dos = new Map<string, AccountCore>();
  const account = (id: string) => {
    let a = dos.get(id);
    if (!a) {
      a = new AccountCore(fakeStorage(), sink);
      void a.credit(opts.balance ?? 100_000_000);
      dos.set(id, a);
    }
    return a;
  };
  const otps = new Map<string, OtpRecord>();
  const queued: WindowMessage[] = [];
  let rows = opts.rows ?? PRICE_ROWS;
  const app = createApp({
    account,
    priceRows: async () => rows,
    routes: async () => opts.routes ?? [],
    otps: {
      get: async (id) => (otps.has(id) ? structuredClone(otps.get(id)) : undefined),
      put: async (r) => void otps.set(r.id, structuredClone(r)),
      delete: async (id) => void otps.delete(id),
    },
    windowQueue: { send: async (m) => void queued.push(m) },
    sandbox: new Set(opts.sandbox ?? []),
  });
  const d1Rows = () => d1.db.prepare("SELECT ref_id, meter, quantity, amount_micro_usd FROM usage_events ORDER BY ref_id").all();
  return { app, account, otps, queued, d1Rows, setRows: (r: PriceVersion[]) => (rows = r) };
}

const free: Context = { accountId: "acme", plan: "free" };
const text = "Your code is 123456";

describe("messaging example", () => {
  it("OTP: two-line hold on send, extend on resend, capture + release on verify", async () => {
    const s = system();
    const sent = await s.app.sendOtp({ id: "otp1", ctx: free, channel: "sms", country: "TR", text, at: SEP });
    expect(sent).toMatchObject({ ok: true, holdId: "otp_send:otp1" });
    // reserve: 1 SMS at the dearest TR tier (20_000) + pool worst case (2_000) + verify (5_000)
    expect(sent.ok && "upperBound" in sent && sent.upperBound).toBe(27_000);
    expect(await s.account("acme").state()).toEqual({ balance: 100_000_000, reserved: 27_000, available: 99_973_000 });

    const again = await s.app.resendOtp({ id: "otp1", text, at: SEP + 30_000 });
    expect(again).toMatchObject({ ok: true, upperBound: 49_000 });

    const done = await s.app.verifyOtp({ id: "otp1", delivered: 2, at: SEP + 60_000 });
    // 2 SMS × 20_000 + verify 5_000; the pool is inside the free 1,000
    expect(done).toMatchObject({ ok: true, charged: 45_000, released: true });
    expect(await s.account("acme").state()).toEqual({ balance: 99_955_000, reserved: 0, available: 99_955_000 });
    expect(s.otps.size).toBe(0);
    expect(await s.account("acme").flush()).toBe(3);
    expect(s.d1Rows().map((r: any) => [r.meter, r.quantity, r.amount_micro_usd])).toEqual([
      ["otp/sms", 2, 40_000],
      ["msg/free_pool", 2, 0],
      ["otp/verify", 1, 5_000],
    ]);
  });

  it("expired OTP: delivered segments are charged, the verification fee is released", async () => {
    const s = system();
    await s.app.sendOtp({ id: "o", ctx: free, channel: "whatsapp", country: "DE", text, at: SEP });
    const r = await s.app.expireOtp({ id: "o", delivered: 1, at: SEP + 600_000 });
    expect(r.ok).toBe(true);
    expect((await s.account("acme").state()).balance).toBe(100_000_000 - 10_000);
    expect(await s.app.expireOtp({ id: "o", delivered: 1, at: SEP })).toMatchObject({ ok: false, reason: "unknown_otp" });
  });

  it("prepaid: an empty account cannot even reserve", async () => {
    const s = system({ balance: 10_000 });
    expect(await s.app.sendOtp({ id: "o", ctx: free, channel: "sms", country: "TR", text, at: SEP })).toMatchObject({ ok: false, reason: "insufficient_credit" });
    expect(s.otps.size).toBe(0);
  });

  it("per-event route cost for countries without a table row", async () => {
    const routes: RouteCost[] = [
      { country: "NG", from: 0, costMicroUsd: 40_000 },
      { country: "NG", from: SEP + 1000, costMicroUsd: 60_000 },
    ];
    const s = system({ routes });
    const before = await s.app.metering.plan.observe("otp/sms", { country: "NG" }, 1, { type: "otp_send", id: "a" }, free, { at: SEP });
    const after = await s.app.metering.plan.observe("otp/sms", { country: "NG" }, 1, { type: "otp_send", id: "b" }, free, { at: SEP + 2000 });
    expect(before.plan.usage[0]).toMatchObject({ amount: 50_000, rateId: `route-NG-0` });
    expect(after.plan.usage[0]).toMatchObject({ amount: 75_000 });
    expect((await s.app.metering.plan.observe("otp/sms", { country: "ZZ" }, 1, { type: "otp_send", id: "c" }, free)).result).toMatchObject({ reason: "no_price" });
  });

  it("plan and account scopes, and falling back to the list when an override is removed", async () => {
    const rows: PriceVersion[] = [
      ...PRICE_ROWS,
      { id: "acme-tr", meter: "otp/sms", scope: "account:acme", dims: { country: "TR" }, effectiveFrom: 0, rate: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 12_000 }] } },
      { id: "acme-tr-end", meter: "otp/sms", scope: "account:acme", dims: { country: "TR" }, effectiveFrom: SEP + 1000, removed: true },
    ];
    const s = system({ rows });
    const price = async (ctx: Context, at: number) =>
      (await s.app.metering.plan.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "x" }, ctx, { at })).plan.usage[0]!.amount;
    expect(await price(free, SEP)).toBe(12_000);
    expect(await price({ accountId: "other", plan: "pro" }, SEP)).toBe(18_000);
    expect(await price(free, SEP + 2000)).toBe(20_000);
  });

  it("an open hold keeps its tariff after the price changes (B20)", async () => {
    const s = system();
    await s.app.sendOtp({ id: "o", ctx: free, channel: "sms", country: "TR", text, at: SEP });
    s.setRows(PRICE_ROWS.map((r) => (r.id === "sms-tr-list" ? { ...r, rate: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 99_000 }] } } : r)));
    const r = await s.app.verifyOtp({ id: "o", delivered: 1, at: SEP + 1 });
    expect(r).toMatchObject({ ok: true, charged: 25_000 });
  });

  it("WhatsApp windows: embedded pricing in the DO, and a queue when Meta's price is late", async () => {
    const s = system();
    const ok = await s.app.closeWindow({ ctx: free, windowId: "w1", country: "TR", at: SEP });
    expect(ok).toMatchObject({ ok: true, charged: 9_000 });
    const late = await s.app.closeWindow({ ctx: free, windowId: "w2", country: "BR", at: SEP });
    expect(late).toMatchObject({ ok: false, reason: "no_price" });
    expect(s.queued).toEqual([{ ctx: free, windowId: "w2", country: "BR", at: SEP }]);
    // Meta publishes BR later; the queue consumer retries with the original `at`
    s.setRows([...PRICE_ROWS, { id: "wa-window-br", meter: "wa/window", scope: "list", dims: { country: "BR" }, effectiveFrom: 0, rate: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 11_000 }] } }]);
    expect(await s.app.closeWindow(s.queued.shift()!)).toMatchObject({ ok: true, charged: 11_000 });
    await s.account("acme").flush();
    expect(s.d1Rows().find((r: any) => r.ref_id === "wa_window:w2:wa/window")).toMatchObject({ quantity: 1 });
  });

  it("dedicated IP: $50 once per month however often the cron runs", async () => {
    const s = system();
    expect(await s.app.monthlyFees({ ctx: free, at: SEP })).toMatchObject({ ok: true, charged: 50_000_000 });
    // a retry in the same month: the counter already shows this month's unit, so the flat fee is not re-entered
    // (and the same ref makes the write a no-op anyway)
    expect(await s.app.monthlyFees({ ctx: free, at: SEP + 3600_000 })).toMatchObject({ ok: true, charged: 0 });
    expect((await s.account("acme").state()).balance).toBe(50_000_000);
    const oct = Date.parse("2026-10-01T00:00:00Z");
    expect(await s.app.monthlyFees({ ctx: free, at: oct })).toMatchObject({ ok: true, charged: 50_000_000 });
    expect((await s.account("acme").state()).balance).toBe(0);
  });

  it("SMS above 10k a month moves to the cheaper TR tier (counters live in the DO)", async () => {
    const s = system({ balance: 1_000_000_000 });
    await s.account("acme").commit({
      ledger: [],
      usage: [{ account: "acme", meter: "otp/sms", dims: { country: "TR" }, quantity: 9_999, amount: 0 as never, detail: { breakdown: [] }, refType: "otp_send", refId: "seed", at: SEP }],
    });
    const r = await s.app.metering.observe("otp/sms", { country: "TR" }, 2, { type: "otp_send", id: "big" }, free, { at: SEP, feeds: false });
    expect(r).toMatchObject({ ok: true, charged: 20_000 + 15_000 });
  });

  it("sandbox accounts are never metered", async () => {
    const s = system({ sandbox: ["acme"] });
    expect(await s.app.sendOtp({ id: "o", ctx: free, channel: "sms", country: "TR", text, at: SEP })).toEqual({ ok: true, sandbox: true });
    expect(await s.app.closeWindow({ ctx: free, windowId: "w", country: "TR", at: SEP })).toEqual({ ok: true, sandbox: true });
    expect((await s.account("acme").state()).reserved).toBe(0);
  });
});
