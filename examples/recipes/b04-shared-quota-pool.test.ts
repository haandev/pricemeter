/**
 * B4 — SMS and WhatsApp share one monthly quota of 1,000 messages.
 * Layer: core (`feeds` into a pool meter).
 *
 * How: declare a dimensionless pool meter and let both channels `feed` it. Every observation adds a
 * pool line with its own tariff; the channels keep their own per-message price (carrier cost) and
 * the pool charges the platform fee once the shared quota is used up.
 */
import { describe, expect, it } from "vitest";
import { buildMetering } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

function setup() {
  const mem = memoryAdapters({
    rates: {
      "msg/quota": { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }, { from: 1_000, unitPriceMicroUsd: 5_000 }] },
      "msg/sms": { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1_000 }] }, // carrier pass-through
      "msg/whatsapp": { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }] },
    },
  });
  const metering = buildMetering()
    .refs(["send"])
    .meter("msg/quota") // pools are declared first, without dims
    .meter("msg/sms", ["country"], { feeds: { "msg/quota": 1 } })
    .meter("msg/whatsapp", ["country"], { feeds: { "msg/quota": 1 } })
    .bind(mem);
  return { metering, mem };
}

const ctx = { accountId: "acme" };

describe("B4 shared quota across channels", () => {
  it("both channels draw from one pool", async () => {
    const { metering, mem } = setup();

    // 800 SMS: 800 × 1,000 carrier cost; pool 0..800 is inside the free quota.
    expect(await metering.observe("msg/sms", { country: "TR" }, 800, { type: "send", id: "s1" }, ctx)).toMatchObject({
      charged: 800_000,
      lines: [{ meter: "msg/sms", amount: 800_000 }, { meter: "msg/quota", amount: 0, feeder: "msg/sms" }],
    });

    // 300 WhatsApp: pool 800..1,100 → 200 free + 100 × 5,000 = 500,000
    expect(await metering.observe("msg/whatsapp", { country: "TR" }, 300, { type: "send", id: "w1" }, ctx)).toMatchObject({
      charged: 500_000,
      lines: [{ meter: "msg/whatsapp", amount: 0 }, { meter: "msg/quota", amount: 500_000, feeder: "msg/whatsapp" }],
    });

    expect(mem.store.used("acme", "msg/quota")).toBe(1_100);
    const poolRow = mem.store.usage.find((u) => u.refId === "send:w1:msg/whatsapp:msg/quota");
    expect(poolRow?.detail).toMatchObject({ feeder: "msg/whatsapp", weight: 1 });
  });
});
