/**
 * B28 — Hard quota: the free plan gets 1,000 OTPs a month, then sending stops (it doesn't get pricier).
 * Layer: core (`limit` from getRate → `quota_exceeded`; the adapter enforces it atomically in `commit`).
 *
 * How: getRate returns `limit` next to `rate` and `usedSoFar`, counted over the same period. A call that
 * would pass it returns `quota_exceeded` with `{ limit, used, requested }` and writes nothing. Because the
 * limit also travels on the usage row, two concurrent requests that both saw 999 can't both get through:
 * the adapter re-checks inside its transaction. Pools take limits too: a limit on the pool caps every channel.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const otp: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }] }; // free, but capped
const LIMIT: Record<string, number | undefined> = { free: 1_000, pro: undefined };

describe("B28 hard quota", () => {
  it("stops the free plan at 1,000 a month; pro is unlimited", async () => {
    const mem = memoryAdapters();
    const metering = buildMetering()
      .context<{ accountId: string; plan: "free" | "pro" }>()
      .refs(["otp_send"])
      .meter("otp/sms", ["country"])
      .getRate(async (meter, _dims, ctx, _at) => {
        const limit = LIMIT[ctx.plan];
        return { rate: otp, usedSoFar: mem.store.used(ctx.accountId, meter), ...(limit === undefined ? {} : { limit }) };
      })
      .commit(mem.commit);
    const free = { accountId: "acme", plan: "free" as const };

    expect(await metering.observe("otp/sms", { country: "TR" }, 999, { type: "otp_send", id: "bulk" }, free)).toMatchObject({ ok: true });
    expect(await metering.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "m1000" }, free)).toMatchObject({ ok: true });
    expect(await metering.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "m1001" }, free)).toEqual({
      ok: false,
      reason: "quota_exceeded",
      meter: "otp/sms",
      cause: { meter: "otp/sms", limit: 1_000, used: 1_000, requested: 1 },
    });
    expect(await metering.observe("otp/sms", { country: "TR" }, 5_000, { type: "otp_send", id: "p1" }, { accountId: "big", plan: "pro" })).toMatchObject({ ok: true });
  });
});
