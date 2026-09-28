/**
 * B12 — A $100 monthly minimum commitment.
 * Layer: module (`minimumCommit` from /adjustments).
 *
 * How: at period close the app sums what the account spent and asks `minimumCommit` for the
 * shortfall. It returns a plan with refId `minimum_commit:{period}`, so the job can run twice.
 */
import { describe, expect, it } from "vitest";
import { buildMetering } from "pricemeter";
import { minimumCommit } from "pricemeter/adjustments";
import { memoryAdapters } from "pricemeter/testing";

function setup() {
  const mem = memoryAdapters({ rates: { "api/calls": { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 10_000 }] } } });
  const metering = buildMetering().refs(["req"]).meter("api/calls").bind(mem);
  const spent = () => mem.store.ledger.filter((op) => op.op === "charge").reduce((s, op) => s + op.amount, 0);
  return { metering, mem, spent };
}
const ctx = { accountId: "acme" };
const close = Date.parse("2026-10-01T00:00:00Z");

describe("B12 monthly minimum commitment", () => {
  it("charges the shortfall once", async () => {
    const { metering, mem, spent } = setup();
    await metering.observe("api/calls", {}, 3_000, { type: "req", id: "1" }, ctx); // 3,000 × 10,000 = $30

    // $100 − $30 = $70
    const plan = minimumCommit({ account: "acme", minimumMicroUsd: 100_000_000, spentMicroUsd: spent(), period: "2026-09", at: close });
    expect(plan.ledger).toMatchObject([{ op: "charge", amount: 70_000_000, refType: "period", refId: "minimum_commit:2026-09" }]);

    await metering.commit(plan);
    await metering.commit(plan); // the close job retried
    expect(mem.store.account("acme").balance).toBe(-100_000_000);
  });

  it("nothing to charge when usage already covers the minimum", async () => {
    const { metering, spent } = setup();
    await metering.observe("api/calls", {}, 12_000, { type: "req", id: "1" }, ctx); // $120
    expect(minimumCommit({ account: "acme", minimumMicroUsd: 100_000_000, spentMicroUsd: spent(), period: "2026-09", at: close })).toEqual({
      ledger: [],
      usage: [],
    });
  });
});
