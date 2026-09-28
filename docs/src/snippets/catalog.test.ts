/** Code on the "Catalog" page. Runs with `bun run test` in docs/ (vitest + tsc). */
import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { z } from "zod";
// #region dims
import { buildMetering, typed, type Rate } from "pricemeter";

const catalog = buildMetering()
  .context(z.object({ accountId: z.string(), plan: z.enum(["free", "pro"]) }))
  .refs(["otp_send", "period"])
  // 1. a record of Standard Schemas: typed and validated on every call
  .meter("otp/sms", { country: z.string().length(2) })
  // 2. one object schema (zod, valibot, arktype…): typed and validated
  .meter("cc/conversation", v.object({ tier: v.picklist(["short", "medium", "long"]) }))
  // 3. typed<T>(): typed, never validated
  .meter("storage/gb", typed<{ region: "eu" | "us" }>())
  // 4. a key array: values are `any`, never validated
  .meter("legacy/api", ["endpoint"])
  // no dims at all
  .meter("ip/dedicated");
// #endregion

// #region feeds
const withPools = buildMetering()
  .context(z.object({ accountId: z.string(), plan: z.enum(["free", "pro"]) }))
  .refs(["otp_send", "request"])
  .meter("msg/free_pool") // a pool is an ordinary meter: no dims, no feeds, declared first
  .meter("llm/credits")
  .meter("otp/sms", { country: z.string().length(2) }, { feeds: { "msg/free_pool": 1 } })
  .meter("otp/whatsapp", { country: z.string().length(2) }, { feeds: { "msg/free_pool": 1 } })
  // weight as a function of (dims, ctx): opus output counts 5 credits per token, the rest 3
  .meter("llm/output", { model: z.string() }, { feeds: { "llm/credits": (d, _ctx) => (d.model === "opus" ? 5 : 3) } });

withPools.meters["otp/sms"]; // { dims: ["country"], feeds: ["msg/free_pool"] }
// #endregion

// Never called: these lines exist for tsc (`@ts-expect-error` must fire).
export function typeErrors() {
  // #region errors
  // @ts-expect-error — "msg/unknown" is not a pool declared earlier
  buildMetering().meter("msg/free_pool").meter("otp/sms", ["country"], { feeds: { "msg/unknown": 1 } });

  // @ts-expect-error — observe needs getRate and commit first
  catalog.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "1" }, { accountId: "a", plan: "pro" });
  // #endregion
}

// #region bind
const sms: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 20_000 }] };

const metering = withPools
  // declare all four parameters, even unused ones (A94)
  .getRate(async (meter, dims, _ctx, _at) => {
    if (meter === "otp/sms") {
      dims.country; // string — dims narrow on meter
      return { rate: sms };
    }
    return null; // no price → ifMissing
  })
  .commit(async (_plan) => {
    /* your transaction */
  });

// The same catalog with other adapters: a new bound copy; `withPools` itself is unchanged.
const forTests = withPools.bind({ getRate: async (_m, _d, _c, _a) => null, commit: async () => {} });
// #endregion

describe("catalog page", () => {
  it("lists meters", () => {
    expect(catalog.meters).toEqual({
      "otp/sms": { dims: ["country"], feeds: [] },
      // object schemas list their keys too: zod `.shape`, valibot `.entries`, arktype `.props`
      "cc/conversation": { dims: ["tier"], feeds: [] },
      "storage/gb": { dims: [], feeds: [] },
      "legacy/api": { dims: ["endpoint"], feeds: [] },
      "ip/dedicated": { dims: [], feeds: [] },
    });
    expect(withPools.meters["otp/sms"]).toEqual({ dims: ["country"], feeds: ["msg/free_pool"] });
  });

  it("rejects undeclared pools at runtime too", () => {
    expect(() => buildMetering().meter("a", ["k"], { feeds: { nope: 1 } as never })).toThrow(/not defined yet/);
  });

  it("validates context and dims per call", async () => {
    const ctx = { accountId: "a", plan: "pro" as const };
    // #region validation
    await metering.observe("otp/sms", { country: "TUR" }, 1, { type: "otp_send", id: "1" }, ctx);
    // → { ok: false, reason: "invalid_dims", meter: "otp/sms", cause: [zod issues] }

    await metering.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "1" }, { accountId: "a", plan: "gold" } as never);
    // → { ok: false, reason: "invalid_context", cause: [zod issues] }

    await metering.observe("otp/sms", { country: "TR" }, 1, { type: "refund", id: "1" } as never, ctx);
    // → { ok: false, reason: "invalid_ref", cause: 'unknown ref type "refund"' }
    // #endregion
    expect(await metering.observe("otp/sms", { country: "TUR" }, 1, { type: "otp_send", id: "1" }, ctx)).toMatchObject({ ok: false, reason: "invalid_dims" });
    expect(
      await metering.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "1" }, { accountId: "a", plan: "gold" } as never),
    ).toMatchObject({ ok: false, reason: "invalid_context" });
    expect(await metering.observe("otp/sms", { country: "TR" }, 1, { type: "refund", id: "1" } as never, ctx)).toMatchObject({
      ok: false,
      reason: "invalid_ref",
    });
    expect(await forTests.observe("otp/sms", { country: "TR" }, 1, { type: "otp_send", id: "1" }, ctx)).toMatchObject({ ok: false, reason: "no_price" });
  });
});
