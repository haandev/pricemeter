/**
 * B5 — Sold in blocks of 1,000.
 * Layer: core (`package` model).
 *
 * How: a package rate charges a whole block the moment its first unit is used:
 * `ceil((usedSoFar + q) / size) − ceil(usedSoFar / size)` new blocks × block price.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const emails: Rate = { id: "email-blocks", model: "package", packageSize: 1_000, tiers: [{ from: 0, unitPriceMicroUsd: 2_000_000 }] }; // $2 / 1,000

describe("B5 blocks of 1,000", () => {
  it("buys a block on its first unit, and the next block only after 1,000", async () => {
    const mem = memoryAdapters({ rates: { email: emails } });
    const metering = buildMetering().refs(["send"]).meter("email").bind(mem);
    const ctx = { accountId: "acme" };
    const send = (id: string, n: number) => metering.observe("email", {}, n, { type: "send", id }, ctx);

    expect(await send("1", 1)).toMatchObject({ charged: 2_000_000 }); // ceil(1/1000) − 0 = 1 block
    expect(await send("2", 999)).toMatchObject({ charged: 0 }); //       ceil(1000/1000) − 1 = 0
    expect(await send("3", 1)).toMatchObject({ charged: 2_000_000 }); // ceil(1001/1000) − 1 = 1
    expect(await send("4", 2_500)).toMatchObject({ charged: 4_000_000 }); // ceil(3501/1000) − 2 = 2

    expect(mem.store.account("acme").balance).toBe(-8_000_000); // 4 blocks
  });
});
