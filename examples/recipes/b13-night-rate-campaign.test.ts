/**
 * B13 — Night rate and a campaign window.
 * Layer: recipe (getRate reads `at`).
 *
 * How: the library passes the observation time to getRate and never interprets it. Time-of-day
 * prices and campaigns are just getRate choosing a different tariff for that instant.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const flat = (id: string, price: number): Rate => ({ id, model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: price }] });
const DAY = flat("day", 10_000);
const NIGHT = flat("night", 5_000); // 22:00–06:00 UTC
const BLACK_FRIDAY = flat("black-friday", 2_000);
const campaign = { from: Date.parse("2026-11-27T00:00:00Z"), to: Date.parse("2026-11-28T00:00:00Z") };

async function getRate(_meter: "sms", _dims: { country: string }, _ctx: { accountId: string }, at: number) {
  if (at >= campaign.from && at < campaign.to) return { rate: BLACK_FRIDAY };
  const hour = new Date(at).getUTCHours();
  return { rate: hour >= 22 || hour < 6 ? NIGHT : DAY };
}

describe("B13 night rate / campaign", () => {
  it("prices by observation time", async () => {
    const mem = memoryAdapters();
    const metering = buildMetering().refs(["send"]).meter("sms", ["country"]).bind({ getRate, commit: mem.commit });
    const ctx = { accountId: "acme" };
    const send = (id: string, iso: string) => metering.observe("sms", { country: "TR" }, 10, { type: "send", id }, ctx, { at: Date.parse(iso) });

    expect(await send("noon", "2026-09-10T12:00:00Z")).toMatchObject({ charged: 100_000 }); // 10 × 10,000
    expect(await send("night", "2026-09-10T23:30:00Z")).toMatchObject({ charged: 50_000 }); // 10 × 5,000
    expect(await send("bf", "2026-11-27T12:00:00Z")).toMatchObject({ charged: 20_000 }); //   10 × 2,000
    expect(mem.store.usage.map((u) => u.rateId)).toEqual(["day", "night", "black-friday"]);
  });
});
