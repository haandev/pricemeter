/**
 * B1 — SMS priced by country, cheaper above 10,000 messages a month.
 * Layer: core (graduated rate + a `country` dimension).
 *
 * How: declare `country` as a dimension and let getRate return a graduated tariff per country.
 * `rate()` splits an observation that crosses the 10k threshold between the two tiers; getRate
 * only supplies the whole tariff and how many messages were already sent this month.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { monthKey } from "pricemeter/calendar";
import { memoryAdapters } from "pricemeter/testing";

const smsRate = (country: string): Rate =>
  country === "TR"
    ? { id: "sms-tr", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 20_000 }, { from: 10_000, unitPriceMicroUsd: 15_000 }] }
    : { id: "sms-intl", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 50_000 }, { from: 10_000, unitPriceMicroUsd: 40_000 }] };

function setup() {
  // usedSoFar is counted per (account, meter, month).
  const mem = memoryAdapters({ rates: { sms: (dims) => smsRate(dims.country) }, periodOf: (at) => monthKey({ at }) });
  const metering = buildMetering().refs(["sms_send"]).meter("sms", ["country"]).bind(mem);
  return { metering, mem };
}

const ctx = { accountId: "acme" };
const at = Date.parse("2026-09-10T12:00:00Z");

describe("B1 SMS by country with a 10k discount", () => {
  it("splits an observation that crosses the threshold", async () => {
    const { metering } = setup();

    // 9,990 × $0.02 = $199.80
    expect(await metering.observe("sms", { country: "TR" }, 9_990, { type: "sms_send", id: "batch_1" }, ctx, { at })).toMatchObject({
      ok: true,
      charged: 199_800_000,
    });

    // usedSoFar 9,990: 10 × 20,000 + 10 × 15,000 = 350,000
    const r = await metering.observe("sms", { country: "TR" }, 20, { type: "sms_send", id: "batch_2" }, ctx, { at });
    expect(r).toMatchObject({
      ok: true,
      charged: 350_000,
      lines: [{ meter: "sms", tierIndex: 1, breakdown: [{ from: 0, quantity: 10 }, { from: 10_000, quantity: 10 }] }],
    });
  });

  it("the volume counter is shared across countries (memoryAdapters counts per meter)", async () => {
    const { metering, mem } = setup();
    await metering.observe("sms", { country: "TR" }, 10_010, { type: "sms_send", id: "1" }, ctx, { at });
    expect(mem.store.used("acme", "sms", at)).toBe(10_010);

    // Already past 10k this month, so a German SMS is at the discounted international price.
    expect(await metering.observe("sms", { country: "DE" }, 1, { type: "sms_send", id: "2" }, ctx, { at })).toMatchObject({ charged: 40_000 });
  });
});
