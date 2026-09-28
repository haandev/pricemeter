/**
 * B11 — A dedicated IP costs a flat $50 a month.
 * Layer: core (single tier, unit price 0, `flatMicroUsd`).
 *
 * How: `flatMicroUsd` is added once, the first time usage enters the tier in the period.
 * With a monthly `usedSoFar` the fee is charged on the first observation of each month, however
 * many times the app observes.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { monthKey } from "pricemeter/calendar";
import { memoryAdapters } from "pricemeter/testing";

const dedicatedIp: Rate = { id: "ip-50", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0, flatMicroUsd: 50_000_000 }], policy: { tierPeriod: "month" } };

describe("B11 dedicated IP $50/mo flat", () => {
  it("charges once per month", async () => {
    const mem = memoryAdapters({ rates: { "ip/dedicated": dedicatedIp }, periodOf: (at) => monthKey({ at }) });
    const metering = buildMetering().refs(["daily"]).meter("ip/dedicated").bind(mem);
    const ctx = { accountId: "acme" };
    const tick = (day: string) => metering.observe("ip/dedicated", {}, 1, { type: "daily", id: day }, ctx, { at: Date.parse(`${day}T00:00:00Z`) });

    expect(await tick("2026-09-01")).toMatchObject({ charged: 50_000_000 }); // enters the tier
    expect(await tick("2026-09-02")).toMatchObject({ charged: 0 }); //          already in it
    expect(await tick("2026-10-01")).toMatchObject({ charged: 50_000_000 }); // new month
  });

  it("a flat fee needs usedSoFar, so a silent double charge is impossible", async () => {
    const metering = buildMetering()
      .refs(["daily"])
      .meter("ip/dedicated")
      .bind({ getRate: async (_meter, _dims, _ctx, _at) => ({ rate: dedicatedIp }), commit: async () => {} });
    expect(await metering.observe("ip/dedicated", {}, 1, { type: "daily", id: "x" }, { accountId: "acme" })).toMatchObject({
      ok: false,
      reason: "usage_required",
    });
  });
});
