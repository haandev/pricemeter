/**
 * Type-level tests. Run by `tsc -p tsconfig.typetests.json` (every `@ts-expect-error` must fire)
 * and by vitest (expectTypeOf is a no-op at runtime).
 */
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { buildMetering, typed, type LineOf, type Metering, type Result } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const mem = memoryAdapters();

const catalog = buildMetering()
  .context(z.object({ accountId: z.string(), plan: z.enum(["free", "pro"]) }))
  .refs(z.enum(["otp_send", "window"]))
  .meter("msg/free_pool")
  .meter("otp/sms", { country: z.string().length(2) }, { feeds: { "msg/free_pool": 1 } })
  .meter("llm/output", { model: z.string(), tokens: z.number() })
  .meter("seats", typed<{ plan: "a" | "b" }>())
  .meter("raw", ["k1", "k2"]);

const ctx = { accountId: "a", plan: "pro" as const };
const ref = { type: "otp_send" as const, id: "1" };

describe("catalog types", () => {
  it("unbound catalogs have no observe", () => {
    // @ts-expect-error not bound
    catalog.observe;
    const onlyRate = catalog.getRate(mem.getRate);
    // @ts-expect-error commit missing
    onlyRate.observe;
    expectTypeOf(catalog.meters["otp/sms"].dims).toEqualTypeOf<string[]>();
  });

  it("getRate narrows dims by meter", () => {
    catalog.getRate((meter, dims, c, at) => {
      expectTypeOf(c.plan).toEqualTypeOf<"free" | "pro">();
      expectTypeOf(at).toEqualTypeOf<number>();
      if (meter === "otp/sms") expectTypeOf(dims).toEqualTypeOf<{ country: string }>();
      if (meter === "llm/output") expectTypeOf(dims).toEqualTypeOf<{ model: string; tokens: number }>();
      if (meter === "seats") expectTypeOf(dims).toEqualTypeOf<{ plan: "a" | "b" }>();
      if (meter === "raw") expectTypeOf(dims).toEqualTypeOf<{ k1: any; k2: any }>();
      return null;
    });
  });

  const m = catalog.getRate(mem.getRate).commit(mem.commit);

  it("observe checks meter ids, dims and refs", () => {
    expectTypeOf(m.observe("otp/sms", { country: "TR" }, 1, ref, ctx)).resolves.toEqualTypeOf<Result>();
    // @ts-expect-error unknown meter
    void (() => m.observe("otp/mms", { country: "TR" }, 1, ref, ctx));
    // @ts-expect-error missing dimension
    void (() => m.observe("otp/sms", {}, 1, ref, ctx));
    // @ts-expect-error extra dimension
    void (() => m.observe("otp/sms", { country: "TR", op: "x" }, 1, ref, ctx));
    // @ts-expect-error wrong dimension type
    void (() => m.observe("llm/output", { model: "x", tokens: "1" }, 1, ref, ctx));
    // @ts-expect-error ref type not declared
    void (() => m.observe("otp/sms", { country: "TR" }, 1, { type: "nope", id: "1" }, ctx));
    // @ts-expect-error context field missing
    void (() => m.observe("otp/sms", { country: "TR" }, 1, ref, { accountId: "a" }));
    // meters without dims may omit them in line form
    m.observe([{ meter: "msg/free_pool", quantity: 1 }], ref, ctx);
    // @ts-expect-error line form still requires declared dims
    void (() => m.observe([{ meter: "otp/sms", quantity: 1 }], ref, ctx));
    m.observe(
      [
        { meter: "otp/sms", dims: { country: "TR" }, quantity: 1 },
        { meter: "llm/output", dims: { model: "x", tokens: 1 }, quantity: 1 },
      ],
      ref,
      ctx,
      { usedSoFar: { "otp/sms": 1 } },
    );
    // @ts-expect-error usedSoFar map keys are meter ids
    void (() => m.observe([{ meter: "otp/sms", dims: { country: "TR" }, quantity: 1 }], ref, ctx, { usedSoFar: { nope: 1 } }));
  });

  it("LineOf is a discriminated union", () => {
    type L = LineOf<typeof m extends Metering<infer S> ? S : never>;
    expectTypeOf<Extract<L, { meter: "otp/sms" }>["dims"]>().toEqualTypeOf<{ country: string }>();
  });

  it("feeds only targets earlier pools", () => {
    const b = buildMetering().meter("pool").meter("dimmed", ["x"]).meter("feeder", [], { feeds: { pool: 2 } });
    // @ts-expect-error a feeder cannot be a pool
    void (() => b.meter("a", [], { feeds: { feeder: 1 } }));
    // @ts-expect-error a meter with dims cannot be a pool
    void (() => b.meter("a", [], { feeds: { dimmed: 1 } }));
    // @ts-expect-error undefined pool
    void (() => b.meter("a", [], { feeds: { later: 1 } }));
    b.meter("a", { k: z.string() }, {
      feeds: {
        pool: (d) => {
          expectTypeOf(d).toEqualTypeOf<{ k: string }>();
          return 1;
        },
      },
    });
  });

  it("hold results must be checked before capture", async () => {
    const h = await m.hold([{ meter: "otp/sms", dims: { country: "TR" }, quantity: 2 }], ref, ctx);
    if (h.ok) {
      expectTypeOf(h.upperBound).toEqualTypeOf<import("pricemeter").MicroUsd>();
      m.capture(h, [{ meter: "otp/sms", quantity: 1 }], ctx);
      // @ts-expect-error capture lines use catalog meter ids
      void (() => m.capture(h, [{ meter: "nope", quantity: 1 }], ctx));
    }
    // @ts-expect-error a failed hold has no hold value
    void (() => m.capture(h, [{ meter: "otp/sms", quantity: 1 }], ctx));
  });

  it("bind returns a bound copy", () => {
    const bound = catalog.bind({ getRate: mem.getRate, commit: mem.commit });
    expectTypeOf(bound.observe).toBeFunction();
  });
});
