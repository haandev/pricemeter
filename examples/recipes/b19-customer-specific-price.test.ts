/**
 * B19 — A customer-specific price, three ways.
 * Layer: recipe (getRate sees the account; `applyDiscount` from /rates).
 *
 * How: getRate receives the context, so "this customer's price" is a lookup there:
 * (1) an account row with its own tariff, (2) a plan row shared by a group of accounts,
 * (3) a CRM discount applied on top of whatever tariff would otherwise apply.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { applyDiscount } from "pricemeter/rates";
import { memoryAdapters } from "pricemeter/testing";

type Ctx = { accountId: string; plan: string };
const flat = (id: string, price: number): Rate => ({ id, model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: price }] });

const LIST = flat("list", 10_000);
const accountRates: Record<string, Rate> = { acme: flat("acme-contract", 7_000) }; // (1)
const planRates: Record<string, Rate> = { pro: flat("pro", 8_000) }; //               (2)
const crmDiscounts: Record<string, number> = { initech: 15 }; //                      (3) percent

async function getRate(_meter: "api", _dims: {}, ctx: Ctx, _at: number) {
  const own = accountRates[ctx.accountId];
  if (own) return { rate: own };
  const base = planRates[ctx.plan] ?? LIST;
  const discount = crmDiscounts[ctx.accountId];
  return { rate: discount ? applyDiscount({ rate: base, percent: discount }) : base };
}

describe("B19 customer-specific price", () => {
  it("account row, plan row, CRM discount, list", async () => {
    const mem = memoryAdapters();
    const metering = buildMetering().context<Ctx>().refs(["req"]).meter("api").bind({ getRate, commit: mem.commit });
    const call = (accountId: string, plan: string) => metering.observe("api", {}, 1, { type: "req", id: accountId }, { accountId, plan });

    expect(await call("acme", "free")).toMatchObject({ charged: 7_000 }); //    own contract
    expect(await call("globex", "pro")).toMatchObject({ charged: 8_000 }); //   plan price
    expect(await call("initech", "free")).toMatchObject({ charged: 8_500 }); // 10,000 − 15%
    expect(await call("hooli", "free")).toMatchObject({ charged: 10_000 }); //  list
    expect(mem.store.usage.map((u) => u.rateId)).toEqual(["acme-contract", "pro", "list-15pct", "list"]);
  });
});
