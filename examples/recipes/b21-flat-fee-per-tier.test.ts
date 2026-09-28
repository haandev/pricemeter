/**
 * B21 — A flat fee when usage enters a tier (a platform fee plus a step fee at 10k).
 * Layer: core (`Tier.flatMicroUsd`).
 *
 * How: each tier may carry `flatMicroUsd`, added once, by the observation whose units first
 * enter that tier. Units are priced as usual on top.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const rate: Rate = {
  id: "stepped",
  model: "graduated",
  tiers: [
    { from: 0, unitPriceMicroUsd: 1_000, flatMicroUsd: 5_000_000 }, //  $5 to start, then $0.001 each
    { from: 10_000, unitPriceMicroUsd: 800, flatMicroUsd: 20_000_000 }, // $20 on reaching 10k, then $0.0008 each
  ],
};

describe("B21 flat fee per tier", () => {
  it("adds each tier's flat fee once, on entry", async () => {
    const mem = memoryAdapters({ rates: { events: rate } });
    const metering = buildMetering().refs(["batch"]).meter("events").bind(mem);
    const ctx = { accountId: "acme" };
    const send = (id: string, n: number) => metering.observe("events", {}, n, { type: "batch", id }, ctx);

    expect(await send("1", 1)).toMatchObject({ charged: 5_001_000 }); //     5,000,000 + 1 × 1,000
    expect(await send("2", 9_999)).toMatchObject({ charged: 9_999_000 }); //  no flat: tier 0 already entered
    const r = await send("3", 1); //                                          20,000,000 + 1 × 800
    expect(r).toMatchObject({ charged: 20_000_800, lines: [{ breakdown: [{ from: 10_000, quantity: 1, flatMicroUsd: 20_000_000 }] }] });
  });
});
