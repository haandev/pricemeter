/**
 * L3 — Lago "dynamic": the price is known only when the event happens (e.g. GPU spot price).
 * Layer: recipe (like B23: getRate per observation, at `at`).
 *
 * How: Lago takes the amount from the event. Here the app keeps the price source (a spot price
 * feed) and getRate turns the price in force at `at` into a one-tier tariff, so the usage row
 * still records which tariff priced it and the amount stays explainable.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const spot = [
  { from: Date.parse("2026-09-10T00:00:00Z"), perHour: 1_800_000 }, // $1.80 / GPU-hour
  { from: Date.parse("2026-09-10T12:00:00Z"), perHour: 2_400_000 }, // $2.40 / GPU-hour
];
const spotRate = (at: number): Rate => {
  const p = spot.filter((s) => s.from <= at).at(-1)!;
  return { id: `spot@${p.from}`, model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: p.perHour }] };
};

describe("L3 Lago dynamic", () => {
  it("prices each event at the spot price of its time", async () => {
    const mem = memoryAdapters({ rates: { "gpu/hours": (_dims, _ctx, at) => spotRate(at) } });
    const metering = buildMetering().refs(["job"]).meter("gpu/hours", ["gpu"]).bind(mem);
    const ctx = { accountId: "acme" };
    const run = (id: string, hours: number, iso: string) => metering.observe("gpu/hours", { gpu: "h100" }, hours, { type: "job", id }, ctx, { at: Date.parse(iso) });

    expect(await run("j1", 3, "2026-09-10T08:00:00Z")).toMatchObject({ charged: 5_400_000 }); // 3 × 1,800,000
    expect(await run("j2", 3, "2026-09-10T18:00:00Z")).toMatchObject({ charged: 7_200_000 }); // 3 × 2,400,000
    expect(new Set(mem.store.usage.map((u) => u.rateId)).size).toBe(2);
  });
});
