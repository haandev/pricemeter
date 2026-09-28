/**
 * B2 — LLM tokens at $0.15 per 1M.
 * Layer: core (graduated, `per: 1_000_000`, `rounding: "cumulative"`).
 *
 * How: price per million with `per`, and use cumulative rounding so that many tiny observations
 * add up to exactly the month's total instead of rounding every call up to one micro-dollar.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

// $0.15 = 150,000 micro-USD per 1,000,000 tokens → 0.15 micro-USD per token.
const tokens: Rate = {
  id: "llm-input",
  model: "graduated",
  tiers: [{ from: 0, unitPriceMicroUsd: 150_000, per: 1_000_000 }],
  policy: { rounding: "cumulative" },
};

describe("B2 LLM $0.15 / 1M tokens", () => {
  it("small calls do not drift: the running total is floored, not each call rounded up", async () => {
    const mem = memoryAdapters({ rates: { "llm/input": tokens } });
    const metering = buildMetering().refs(["completion"]).meter("llm/input", ["model"]).bind(mem);
    const ctx = { accountId: "acme" };

    const charged: number[] = [];
    for (const id of ["c1", "c2", "c3"]) {
      const r = await metering.observe("llm/input", { model: "small" }, 7, { type: "completion", id }, ctx);
      if (!r.ok) throw new Error(r.reason);
      charged.push(r.charged);
    }
    // Running totals 1.05 → 2.10 → 3.15; floors 1, 2, 3 → one micro-dollar per call.
    // (per_event_up would charge ceil(1.05) = 2 each, 6 in total.)
    expect(charged).toEqual([1, 1, 1]);

    // 2,000,000 more tokens: floor(300,003.15) − floor(3.15) = 300,000
    expect(await metering.observe("llm/input", { model: "small" }, 2_000_000, { type: "completion", id: "c4" }, ctx)).toMatchObject({
      charged: 300_000,
    });
    // Whole period: 2,000,021 tokens × 0.15 = 300,003.15 → 300,003 charged, nothing lost or invented.
    expect(mem.store.ledger.reduce((s, op) => s + op.amount, 0)).toBe(300_003);
  });
});
