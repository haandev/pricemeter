/**
 * B3 — First 500 per month are free.
 * Layer: core (graduated `[0: 0, 500: p]`).
 *
 * How: a zero-priced first tier. The free allowance resets because getRate reports `usedSoFar`
 * for the current month; the library itself has no calendar.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { monthKey } from "pricemeter/calendar";
import { memoryAdapters } from "pricemeter/testing";

const verify: Rate = {
  id: "verify-2026",
  model: "graduated",
  tiers: [
    { from: 0, unitPriceMicroUsd: 0 }, // first 500 free
    { from: 500, unitPriceMicroUsd: 10_000 }, // then $0.01 each
  ],
  policy: { tierPeriod: "month" },
};

describe("B3 first 500 per month free", () => {
  it("charges only past the allowance, and the allowance resets next month", async () => {
    const mem = memoryAdapters({ rates: { verify }, periodOf: (at) => monthKey({ at }) });
    const metering = buildMetering().refs(["check"]).meter("verify").bind(mem);
    const ctx = { accountId: "acme" };
    const sep = Date.parse("2026-09-05T00:00:00Z");
    const oct = Date.parse("2026-10-02T00:00:00Z");

    // 400 of 500 free units: 0, but the usage row is written (and counts).
    expect(await metering.observe("verify", {}, 400, { type: "check", id: "1" }, ctx, { at: sep })).toMatchObject({ ok: true, charged: 0 });
    expect(mem.store.usage).toHaveLength(1);
    expect(mem.store.ledger).toHaveLength(0);

    // usedSoFar 400: 100 free + 100 × 10,000 = 1,000,000
    expect(await metering.observe("verify", {}, 200, { type: "check", id: "2" }, ctx, { at: sep })).toMatchObject({ charged: 1_000_000 });

    // New month, new counter: free again.
    expect(await metering.observe("verify", {}, 10, { type: "check", id: "3" }, ctx, { at: oct })).toMatchObject({ charged: 0 });
  });
});
