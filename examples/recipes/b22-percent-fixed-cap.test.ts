/**
 * B22 — Fintech fee: 2.9% + $0.30 per transaction, capped at $5.
 * Layer: core (`per: 1_000_000` for the percentage, `flatMicroUsd` for the fixed part, `perObservation` cap).
 *
 * How: the quantity is the transaction amount in micro-USD, and 29,000 per 1,000,000 is 2.9%.
 * The fixed fee is a flat fee on the only tier; since it must apply to every transaction, each
 * transaction is its own period: getRate returns `usedSoFar: 0` (A97, `tierPeriod: "observation"`).
 */
import { describe, expect, it } from "vitest";
import { buildMetering, usd, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const cardFee: Rate = {
  id: "card-2.9+30",
  model: "graduated",
  tiers: [{ from: 0, unitPriceMicroUsd: 29_000, per: 1_000_000, flatMicroUsd: 300_000 }],
  policy: { perObservation: { maxMicroUsd: 5_000_000 }, tierPeriod: "observation" },
};

describe("B22 percent + fixed per transaction + cap", () => {
  it("prices each transaction on its own", async () => {
    const mem = memoryAdapters({ rates: { "card/fee": () => ({ rate: cardFee, usedSoFar: 0 }) } });
    const metering = buildMetering().refs(["payment"]).meter("card/fee").bind(mem);
    const ctx = { accountId: "merchant_1" };
    const pay = (id: string, amount: number) => metering.observe("card/fee", {}, amount, { type: "payment", id }, ctx);

    expect(await pay("p1", usd(100))).toMatchObject({ charged: 3_200_000 }); // 2,900,000 + 300,000
    expect(await pay("p2", usd(100))).toMatchObject({ charged: 3_200_000 }); // fixed fee again: usedSoFar 0
    expect(await pay("p3", usd(5))).toMatchObject({ charged: 445_000 }); //     145,000 + 300,000
    expect(await pay("p4", usd(500))).toMatchObject({ charged: 5_000_000 }); // 14,800,000 capped
    expect(mem.store.usage.at(-1)?.detail.clamped).toBe("max");
  });
});
