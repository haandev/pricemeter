/**
 * B17 — A customer billed in EUR.
 * Layer: recipe (getRate returns the EUR tariff; `Rate` carries no currency).
 *
 * How: amounts are integer micro-units of whatever currency the tariff is in. getRate picks the
 * tariff by the account's currency, and the app keeps one ledger account per currency (here the
 * currency is part of `accountId`), so EUR and USD never add up.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

type Ctx = { accountId: string; currency: "USD" | "EUR" };
const SMS_USD: Rate = { id: "sms-usd", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 20_000 }] }; // $0.020
const SMS_EUR: Rate = { id: "sms-eur", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 18_000 }] }; // €0.018

describe("B17 EUR tariff", () => {
  it("picks the tariff by currency and books into a per-currency account", async () => {
    const mem = memoryAdapters({ rates: { sms: (_dims, ctx: Ctx) => (ctx.currency === "EUR" ? SMS_EUR : SMS_USD) } });
    const metering = buildMetering().context<Ctx>().refs(["send"]).meter("sms").bind(mem);

    await metering.observe("sms", {}, 10, { type: "send", id: "1" }, { accountId: "acme:EUR", currency: "EUR" });
    await metering.observe("sms", {}, 10, { type: "send", id: "2" }, { accountId: "acme:USD", currency: "USD" });

    // 10 × 18,000 micro-EUR and 10 × 20,000 micro-USD, in separate accounts.
    expect(mem.store.account("acme:EUR").balance).toBe(-180_000);
    expect(mem.store.account("acme:USD").balance).toBe(-200_000);
    expect(mem.store.usage.map((u) => [u.account, u.rateId, u.amount])).toEqual([
      ["acme:EUR", "sms-eur", 180_000],
      ["acme:USD", "sms-usd", 200_000],
    ]);
  });
});
