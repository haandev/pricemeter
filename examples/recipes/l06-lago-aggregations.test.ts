/**
 * L6 — Lago aggregations: count, sum, max, latest, weighted_sum.
 * Layer: core (the quantity comes from the app) / module (`integrate` from /gauge).
 *
 * How: pricemeter prices a quantity; it does not aggregate events. count and sum are one line of
 * app code; max, latest and weighted_sum are `integrate` over level samples with mode
 * `max`, `last` and `time_weighted`. Here all five are one period-end observation.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { integrate } from "pricemeter/gauge";
import { memoryAdapters } from "pricemeter/testing";

const flat = (price: number, per = 1): Rate => ({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: price, per }] });
const h = (hours: number) => Date.parse("2026-09-01T00:00:00Z") + hours * 3_600_000;
const day = { from: h(0), to: h(24) };

describe("L6 Lago count / sum / max / latest / weighted_sum", () => {
  it("app aggregates, one observation prices all", async () => {
    const requests = [{ mb: 1_500 }, { mb: 700 }, { mb: 2_100 }];
    const storageGb = [{ at: h(0), value: 10 }, { at: h(6), value: 45 }, { at: h(12), value: 20 }];
    const cores = [{ at: h(0), value: 4 }, { at: h(10), value: 8 }];

    const count = requests.length; // 3
    const sumMb = requests.reduce((s, r) => s + r.mb, 0); // 4,300
    const maxGb = integrate({ samples: storageGb, window: day, mode: "max" }); // 45
    const latestGb = integrate({ samples: storageGb, window: day, mode: "last" }); // 20
    const coreHours = integrate({ samples: cores, window: day, mode: "time_weighted", unit: "h" }); // 4 × 10 + 8 × 14 = 152

    const mem = memoryAdapters({
      rates: {
        "api/requests": flat(1_000),
        "egress/mb": flat(90_000, 1_000), // $0.09 per 1,000 MB
        "storage/peak_gb": flat(20_000),
        "storage/gb": flat(20_000),
        "cpu/core_hours": flat(30_000),
      },
    });
    const metering = buildMetering()
      .refs(["period"])
      .meter("api/requests")
      .meter("egress/mb")
      .meter("storage/peak_gb")
      .meter("storage/gb")
      .meter("cpu/core_hours")
      .bind(mem);

    const r = await metering.observe(
      [
        { meter: "api/requests", quantity: count },
        { meter: "egress/mb", quantity: sumMb },
        { meter: "storage/peak_gb", quantity: maxGb },
        { meter: "storage/gb", quantity: latestGb },
        { meter: "cpu/core_hours", quantity: coreHours },
      ],
      { type: "period", id: "2026-09-01" },
      { accountId: "acme" },
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.lines.map((l) => [l.meter, l.quantity, l.amount])).toEqual([
      ["api/requests", 3, 3_000],
      ["egress/mb", 4_300, 387_000], //       4,300 × 90,000 / 1,000
      ["storage/peak_gb", 45, 900_000],
      ["storage/gb", 20, 400_000],
      ["cpu/core_hours", 152, 4_560_000], //  152 × 30,000
    ]);
  });
});
