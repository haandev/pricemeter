/**
 * L10 — Lago fixed charges with graduated or volume pricing (e.g. seats).
 * Layer: core (an `integrate` result fed into any model).
 *
 * How: a fixed charge is a level (seats) reduced to one quantity per period with `integrate`, then
 * observed like any other quantity, so every model applies. Each period starts at `usedSoFar` 0.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { monthKey, monthWindow } from "pricemeter/calendar";
import { integrate } from "pricemeter/gauge";
import { memoryAdapters } from "pricemeter/testing";

const tiers: Rate["tiers"] = [
  { from: 0, unitPriceMicroUsd: 10_000_000 }, //  seats 1–10: $10
  { from: 10, unitPriceMicroUsd: 8_000_000 }, //  seats 11–20: $8
  { from: 20, unitPriceMicroUsd: 5_000_000 }, //  seats 21+: $5
];

describe("L10 Lago fixed charge, graduated / volume", () => {
  it("prices the period's seat count in either model", async () => {
    const mem = memoryAdapters({
      rates: { "seats/graduated": { model: "graduated", tiers }, "seats/volume": { model: "volume", tiers } },
      periodOf: (at) => monthKey({ at }),
    });
    const metering = buildMetering().refs(["period"]).meter("seats/graduated").meter("seats/volume").bind(mem);

    const september = monthWindow({ at: Date.parse("2026-09-01T00:00:00Z") });
    const seats = integrate({ samples: [{ at: september.from, value: 18 }, { at: Date.parse("2026-09-12T00:00:00Z"), value: 25 }], window: september, mode: "last" });
    expect(seats).toBe(25);

    const r = await metering.observe(
      [
        { meter: "seats/graduated", quantity: seats },
        { meter: "seats/volume", quantity: seats },
      ],
      { type: "period", id: "2026-09" },
      { accountId: "acme" },
      { at: september.to - 1 },
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.lines.map((l) => l.amount)).toEqual([
      205_000_000, // graduated: 10 × 10M + 10 × 8M + 5 × 5M
      125_000_000, // volume: all 25 × 5M
    ]);
  });
});
