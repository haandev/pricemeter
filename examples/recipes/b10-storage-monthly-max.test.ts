/**
 * B10 — Storage billed on the month's peak GB.
 * Layer: module (`integrate({ mode: "max" })` from /gauge).
 *
 * How: the app keeps level samples (GB stored). At period end `integrate` reduces them to the
 * highest level in the window, and that single number is observed once for the period.
 */
import { describe, expect, it } from "vitest";
import { buildMetering } from "pricemeter";
import { monthWindow } from "pricemeter/calendar";
import { integrate } from "pricemeter/gauge";
import { memoryAdapters } from "pricemeter/testing";

describe("B10 storage: month's max GB", () => {
  it("observes the peak level once per month", async () => {
    const mem = memoryAdapters({ rates: { "storage/gb": { id: "gb-month", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 20_000 }] } } }); // $0.02 / GB-month
    const metering = buildMetering().refs(["period"]).meter("storage/gb").bind(mem);

    const september = monthWindow({ at: Date.parse("2026-09-01T00:00:00Z") });
    const samples = [
      { at: Date.parse("2026-09-01T00:00:00Z"), value: 10 },
      { at: Date.parse("2026-09-10T00:00:00Z"), value: 45 }, // peak
      { at: Date.parse("2026-09-20T00:00:00Z"), value: 20 },
    ];
    const peakGb = integrate({ samples, window: september, mode: "max" });
    expect(peakGb).toBe(45);

    // 45 GB × 20,000 = 900,000
    expect(await metering.observe("storage/gb", {}, peakGb, { type: "period", id: "2026-09" }, { accountId: "acme" }, { at: september.to - 1 })).toMatchObject({
      charged: 900_000,
    });
  });
});
