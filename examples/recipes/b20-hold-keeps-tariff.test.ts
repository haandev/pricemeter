/**
 * B20 — A custom price ends and the account goes back to list; a hold opened before keeps the old price.
 * Layer: core (the tariff is embedded in the hold).
 *
 * How: `hold` stores the tariff it was priced with on each line, and `capture` uses it without
 * calling getRate again. New observations see the new tariff. (To price a capture at capture time
 * instead, pass `{ rate }` to `capture`.)
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const CUSTOM: Rate = { id: "acme-custom", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 5_000 }] };
const LIST: Rate = { id: "list", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 10_000 }] };

describe("B20 open hold keeps the old tariff", () => {
  it("captures at hold-time price, new usage at list", async () => {
    const mem = memoryAdapters({ rates: { transcode: CUSTOM } });
    const metering = buildMetering().refs(["job"]).meter("transcode").bind(mem);
    const ctx = { accountId: "acme" };

    const h = await metering.hold("transcode", {}, 10, { type: "job", id: "long_video" }, ctx);
    if (!h.ok) throw new Error(h.reason);
    expect(h.upperBound).toBe(50_000); // 10 × 5,000

    mem.store.setRate("transcode", LIST); // contract ended while the job was running

    const c = await metering.capture(h.hold, [{ meter: "transcode", quantity: 10 }], ctx);
    expect(c).toMatchObject({ ok: true, charged: 50_000 }); // still 5,000 each
    expect(await metering.observe("transcode", {}, 1, { type: "job", id: "next" }, ctx)).toMatchObject({ charged: 10_000 });
    expect(mem.store.usage.map((u) => u.rateId)).toEqual(["acme-custom", "list"]);
  });
});
