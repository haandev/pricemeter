/**
 * B7 — A conversation is priced when it closes, by how long it was.
 * Layer: recipe (the app classifies; the tier is a dimension).
 *
 * How: the library does not know what a "long" conversation is. When the conversation closes,
 * the app maps its length to `dims.tier` and observes one unit; getRate prices by tier.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

type Tier = "short" | "medium" | "long";
const classify = (minutes: number): Tier => (minutes < 5 ? "short" : minutes < 20 ? "medium" : "long");

const prices: Record<Tier, number> = { short: 10_000, medium: 25_000, long: 60_000 };
const conversationRate = (tier: Tier): Rate => ({ id: `conv-${tier}`, model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: prices[tier] }] });

describe("B7 conversation priced at close by length", () => {
  it("the app classifies, the tier dimension selects the price", async () => {
    const mem = memoryAdapters({ rates: { "cc/conversation": (dims) => conversationRate(dims.tier) } });
    const metering = buildMetering()
      .refs(["conversation"])
      .meter("cc/conversation", { tier: z.enum(["short", "medium", "long"]) })
      .bind(mem);
    const ctx = { accountId: "acme" };

    const close = (id: string, minutes: number) =>
      metering.observe("cc/conversation", { tier: classify(minutes) }, 1, { type: "conversation", id }, ctx);

    expect(await close("c1", 3)).toMatchObject({ charged: 10_000 });
    expect(await close("c2", 12)).toMatchObject({ charged: 25_000 });
    expect(await close("c3", 45)).toMatchObject({ charged: 60_000 });
    expect(mem.store.usage.map((u) => [u.dims.tier, u.rateId])).toEqual([
      ["short", "conv-short"],
      ["medium", "conv-medium"],
      ["long", "conv-long"],
    ]);

    // The dimension schema guards the classification.
    expect(await metering.observe("cc/conversation", { tier: "epic" as Tier }, 1, { type: "conversation", id: "c4" }, ctx)).toMatchObject({
      ok: false,
      reason: "invalid_dims",
    });
  });
});
