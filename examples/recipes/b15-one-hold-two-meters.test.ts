/**
 * B15 — One request touches two meters under one reservation (OTP: SMS, then voice fallback).
 * Layer: core (multi-line `hold`, `capture`, `release`).
 *
 * How: hold both lines at request time; the hold reserves the worst case and is a value object the
 * app stores. Capture what was actually delivered, then release the rest. Captures are priced
 * with the tariff stored in the hold.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const flat = (price: number): Rate => ({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: price }] });

describe("B15 one request, two meters, one hold", () => {
  it("reserves the worst case, captures the actual, releases the rest", async () => {
    const mem = memoryAdapters({ prepaid: true, balances: { acme: 1_000_000 }, rates: { "otp/sms": flat(20_000), "otp/voice": flat(50_000) } });
    const metering = buildMetering().refs(["otp"]).meter("otp/sms", ["country"]).meter("otp/voice", ["country"]).bind(mem);
    const ctx = { accountId: "acme" };

    // Up to 3 SMS attempts + 1 voice call: 3 × 20,000 + 50,000 = 110,000 reserved.
    const h = await metering.hold(
      [
        { meter: "otp/sms", dims: { country: "TR" }, quantity: 3 },
        { meter: "otp/voice", dims: { country: "TR" }, quantity: 1 },
      ],
      { type: "otp", id: "otp_42" },
      ctx,
    );
    if (!h.ok) throw new Error(h.reason);
    expect(h.upperBound).toBe(110_000);
    expect(mem.store.available("acme")).toBe(890_000);

    // Delivered on the second SMS; voice never used.
    const c = await metering.capture(h.hold, [{ meter: "otp/sms", quantity: 2 }], ctx);
    expect(c).toMatchObject({ ok: true, charged: 40_000 });
    if (!c.ok) throw new Error(c.reason);

    await metering.release(c.hold, ctx);
    expect(mem.store.account("acme")).toEqual({ balance: 960_000, reserved: 0 });
  });
});
