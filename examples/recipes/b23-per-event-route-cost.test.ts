/**
 * B23 — Each event has its own price (SMS priced at the route's cost at send time, plus margin).
 * Layer: recipe (getRate per observation, reading `at`).
 *
 * How: getRate is called for every observation with its dimensions and time, so it can look up
 * the cost of that route at that moment and return a one-tier tariff built from it. The tariff id
 * records which cost priced the row.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

// Carrier cost history per route (in the app's database).
const routeCosts: Record<string, { from: number; cost: number }[]> = {
  "tr-turkcell": [
    { from: Date.parse("2026-09-01T00:00:00Z"), cost: 8_000 },
    { from: Date.parse("2026-09-15T00:00:00Z"), cost: 9_000 },
  ],
};
const costAt = (route: string, at: number) => routeCosts[route]!.filter((c) => c.from <= at).at(-1)!.cost;

const routeRate = (route: string, at: number): Rate => {
  const cost = costAt(route, at);
  return { id: `${route}@${cost}`, model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: Math.round(cost * 1.25) }] }; // +25%
};

describe("B23 per-event price from route cost", () => {
  it("prices with the route cost in force at send time", async () => {
    const mem = memoryAdapters({ rates: { sms: (dims, _ctx, at) => routeRate(dims.route, at) } });
    const metering = buildMetering().refs(["send"]).meter("sms", ["route"]).bind(mem);
    const ctx = { accountId: "acme" };
    const send = (id: string, iso: string) => metering.observe("sms", { route: "tr-turkcell" }, 1, { type: "send", id }, ctx, { at: Date.parse(iso) });

    expect(await send("m1", "2026-09-10T00:00:00Z")).toMatchObject({ charged: 10_000 }); // 8,000 × 1.25
    expect(await send("m2", "2026-09-20T00:00:00Z")).toMatchObject({ charged: 11_250 }); // 9,000 × 1.25
    expect(mem.store.usage.map((u) => u.rateId)).toEqual(["tr-turkcell@8000", "tr-turkcell@9000"]);
  });
});
