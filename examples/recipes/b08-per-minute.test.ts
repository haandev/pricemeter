/**
 * B8 — Charged per started conversation-minute.
 * Layer: core (the quantity is minutes).
 *
 * How: quantities are integers in whatever unit you price. The app turns seconds into billable
 * minutes (its rounding rule, here "every started minute") and observes that.
 */
import { describe, expect, it } from "vitest";
import { buildMetering } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const billableMinutes = (seconds: number) => Math.ceil(seconds / 60);

describe("B8 per conversation-minute", () => {
  it("observes started minutes", async () => {
    const mem = memoryAdapters({ rates: { "voice/minutes": { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 12_000 }] } } });
    const metering = buildMetering().refs(["call"]).meter("voice/minutes", ["direction"]).bind(mem);
    const ctx = { accountId: "acme" };

    // 125 s → 3 minutes × 12,000
    expect(await metering.observe("voice/minutes", { direction: "out" }, billableMinutes(125), { type: "call", id: "a" }, ctx)).toMatchObject({
      charged: 36_000,
    });
    // 60 s → exactly 1 minute
    expect(await metering.observe("voice/minutes", { direction: "out" }, billableMinutes(60), { type: "call", id: "b" }, ctx)).toMatchObject({
      charged: 12_000,
    });
    expect(mem.store.used("acme", "voice/minutes")).toBe(4);
  });
});
