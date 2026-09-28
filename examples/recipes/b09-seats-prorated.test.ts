/**
 * B9 — A seat costs $10 a month, prorated when added mid-month.
 * Layer: module (`integrate` from /gauge, `monthWindow` from /calendar) + core (`per`).
 *
 * How: the app records seat-count changes. At period end `integrate({ mode: "time_weighted" })`
 * turns them into seat-seconds, and the tariff prices `$10 per <seconds in this month>`, so a
 * seat present for half the month costs $5. One observation per period.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { monthWindow } from "pricemeter/calendar";
import { integrate } from "pricemeter/gauge";
import { memoryAdapters } from "pricemeter/testing";

// The denominator depends on the month, so the tariff is built for the month of `at`.
const seatRate = (at: number): Rate => {
  const w = monthWindow({ at });
  return { id: "seat-10", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 10_000_000, per: (w.to - w.from) / 1000 }] };
};

describe("B9 seats prorated mid-month", () => {
  it("prices seat-seconds against the month's length", async () => {
    const mem = memoryAdapters({ rates: { seats: (_dims, _ctx, at) => seatRate(at) } });
    const metering = buildMetering().refs(["period"]).meter("seats").bind(mem);

    const september = monthWindow({ at: Date.parse("2026-09-15T00:00:00Z") }); // 30 days = 2,592,000 s
    const samples = [
      { at: Date.parse("2026-08-20T00:00:00Z"), value: 2 }, // two seats since August
      { at: Date.parse("2026-09-16T00:00:00Z"), value: 3 }, // third seat for the last 15 days
    ];
    // 2 × 30 days + 1 × 15 days = 75 seat-days = 6,480,000 seat-seconds
    const seatSeconds = integrate({ samples, window: september, mode: "time_weighted" });
    expect(seatSeconds).toBe(6_480_000);

    // 6,480,000 × 10,000,000 / 2,592,000 = 25,000,000 → $20 for two full seats + $5 for half a month.
    // `at` is inside the period (its last millisecond) so getRate picks September's length.
    const r = await metering.observe("seats", {}, seatSeconds, { type: "period", id: "2026-09" }, { accountId: "acme" }, { at: september.to - 1 });
    expect(r).toMatchObject({ ok: true, charged: 25_000_000 });
  });
});
