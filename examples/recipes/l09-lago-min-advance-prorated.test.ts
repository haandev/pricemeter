/**
 * L9 — Lago min_amount_cents, pay_in_advance and prorated charges.
 * Layer: module (`minimumCommit`) / core (`observe` at event time, `per` for proration).
 *
 * How: a charge minimum is `minimumCommit` at period close. Paying in advance means observing
 * when the event happens (the ledger moves then) instead of at period end. Proration is the
 * remaining seconds of the period priced `per` the period's length.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { minimumCommit } from "pricemeter/adjustments";
import { monthWindow } from "pricemeter/calendar";
import { memoryAdapters } from "pricemeter/testing";

const seatRate = (at: number): Rate => {
  const w = monthWindow({ at });
  return { id: "seat-30", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 30_000_000, per: (w.to - w.from) / 1000 }] }; // $30 / month
};

describe("L9 Lago min_amount / pay_in_advance / prorated", () => {
  it("pay in advance, prorated: a seat added on Sep 21 is charged 10/30 of the month right away", async () => {
    const mem = memoryAdapters({ rates: { seats: (_dims, _ctx, at) => seatRate(at) } });
    const metering = buildMetering().refs(["seat_added"]).meter("seats").bind(mem);

    const added = Date.parse("2026-09-21T00:00:00Z");
    const remainingSeconds = (monthWindow({ at: added }).to - added) / 1000; // 10 days = 864,000
    // 864,000 × 30,000,000 / 2,592,000 = 10,000,000
    const r = await metering.observe("seats", {}, remainingSeconds, { type: "seat_added", id: "seat_7" }, { accountId: "acme" }, { at: added });
    expect(r).toMatchObject({ ok: true, charged: 10_000_000 });
    expect(mem.store.ledger[0]?.at).toBe(added); // money moved at event time, not at period end
  });

  it("min_amount: top the charge up to its minimum at close", () => {
    const plan = minimumCommit({ account: "acme", minimumMicroUsd: 10_000_000, spentMicroUsd: 4_000_000, period: "2026-09:api", at: Date.parse("2026-10-01T00:00:00Z") });
    expect(plan.ledger).toMatchObject([{ amount: 6_000_000, refId: "minimum_commit:2026-09:api" }]);
  });
});
