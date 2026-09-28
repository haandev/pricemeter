/**
 * B25 — Reseller pricing: the reseller's price for one customer, else the reseller's default, else list.
 * Layer: recipe (three lookups in getRate).
 *
 * How: a hand-written getRate that walks three layers, most specific first. (The same could be a
 * `layeredRates` table with scopes `account:…`, `reseller:…`, `list`; see B14.)
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

type Ctx = { accountId: string; resellerId?: string };
const flat = (id: string, price: number): Rate => ({ id, model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: price }] });

const LIST = flat("list", 10_000);
const resellerDefaults: Record<string, Rate> = { r1: flat("r1-default", 12_000) };
const resellerCustomerPrices: Record<string, Record<string, Rate>> = { r1: { c1: flat("r1-c1", 9_000) } };

async function getRate(_meter: "sms", _dims: {}, ctx: Ctx, _at: number) {
  const r = ctx.resellerId;
  const rate = (r && resellerCustomerPrices[r]?.[ctx.accountId]) || (r && resellerDefaults[r]) || LIST;
  return { rate };
}

describe("B25 reseller → customer → list", () => {
  it("resolves the most specific layer", async () => {
    const mem = memoryAdapters();
    const metering = buildMetering().context<Ctx>().refs(["send"]).meter("sms").bind({ getRate, commit: mem.commit });
    const send = (ctx: Ctx) => metering.observe("sms", {}, 1, { type: "send", id: ctx.accountId }, ctx);

    expect(await send({ accountId: "c1", resellerId: "r1" })).toMatchObject({ charged: 9_000 }); //  customer price
    expect(await send({ accountId: "c2", resellerId: "r1" })).toMatchObject({ charged: 12_000 }); // reseller default
    expect(await send({ accountId: "c3" })).toMatchObject({ charged: 10_000 }); //                   direct customer: list
  });
});
