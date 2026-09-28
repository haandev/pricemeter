/**
 * B14 — Enterprise pricing: a plan (group) price, and an even more specific account price.
 * Layer: recipe / module (`layeredRates` from /rates).
 *
 * How: keep one price table with scoped rows (`account:…`, `plan:…`, `list`), wildcard dimensions
 * and `effectiveFrom` versions. `layeredRates` resolves it into a getRate: scopes are tried most
 * specific first; inside a scope the most specific matching row wins, then the latest version.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { layeredRates, type PriceVersion } from "pricemeter/rates";
import { memoryAdapters } from "pricemeter/testing";

const flat = (price: number): Rate => ({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: price }] });
const rows: PriceVersion[] = [
  { id: "list-any", meter: "sms", scope: "list", dims: { country: "*" }, effectiveFrom: 0, rate: flat(50_000) },
  { id: "list-tr", meter: "sms", scope: "list", dims: { country: "TR" }, effectiveFrom: 0, rate: flat(20_000) },
  { id: "enterprise-any", meter: "sms", scope: "plan:enterprise", dims: { country: "*" }, effectiveFrom: 0, rate: flat(30_000) },
  { id: "acme-tr", meter: "sms", scope: "account:acme", dims: { country: "TR" }, effectiveFrom: 0, rate: flat(10_000) },
  { id: "acme-tr-2027", meter: "sms", scope: "account:acme", dims: { country: "TR" }, effectiveFrom: Date.parse("2027-01-01T00:00:00Z"), rate: flat(8_000) },
];

type Ctx = { accountId: string; plan: string };

describe("B14 enterprise: group price, account price more specific", () => {
  it("resolves account > plan > list", async () => {
    const getRate = layeredRates<Ctx>({
      loadRows: (meter) => rows.filter((r) => r.meter === meter),
      scopes: (ctx) => [`account:${ctx.accountId}`, `plan:${ctx.plan}`, "list"],
    });
    const metering = buildMetering().context<Ctx>().refs(["send"]).meter("sms", ["country"]).bind({ getRate, commit: memoryAdapters().commit });

    const quote = async (accountId: string, plan: string, country: string, iso = "2026-09-10T00:00:00Z") => {
      const { result, plan: written } = await metering.plan.observe("sms", { country }, 1, { type: "send", id: "q" }, { accountId, plan }, { at: Date.parse(iso) });
      return [result.ok ? result.charged : result.reason, written.usage[0]?.rateId];
    };

    expect(await quote("acme", "enterprise", "TR")).toEqual([10_000, "acme-tr"]); //         account row
    expect(await quote("acme", "enterprise", "DE")).toEqual([30_000, "enterprise-any"]); //  no account row for DE → plan
    expect(await quote("globex", "enterprise", "TR")).toEqual([30_000, "enterprise-any"]); // scope beats specificity
    expect(await quote("smallco", "free", "TR")).toEqual([20_000, "list-tr"]); //             most specific list row
    expect(await quote("smallco", "free", "DE")).toEqual([50_000, "list-any"]); //            wildcard
    expect(await quote("acme", "enterprise", "TR", "2027-02-01T00:00:00Z")).toEqual([8_000, "acme-tr-2027"]); // new version
  });
});
