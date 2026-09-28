/**
 * B26 — Postpaid: usage is recorded and invoiced later, whatever the balance.
 * Layer: recipe (commit does not check the balance).
 *
 * How: the balance gate lives in `commit`, not in the library. A postpaid commit never throws
 * `InsufficientCredit`, so the balance simply goes negative; a prepaid one refuses atomically.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const api: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1_000 }] };
const setup = (prepaid: boolean) => {
  const mem = memoryAdapters({ prepaid, rates: { api } });
  return { mem, metering: buildMetering().refs(["req"]).meter("api").bind(mem) };
};
const ctx = { accountId: "acme" };

describe("B26 postpaid", () => {
  it("postpaid commit accepts usage with no balance", async () => {
    const { mem, metering } = setup(false);
    expect(await metering.observe("api", {}, 500, { type: "req", id: "1" }, ctx)).toMatchObject({ ok: true, charged: 500_000 });
    expect(mem.store.account("acme").balance).toBe(-500_000); // owed, to be invoiced
  });

  it("the same catalog with a prepaid commit refuses and writes nothing", async () => {
    const { mem, metering } = setup(true);
    expect(await metering.observe("api", {}, 500, { type: "req", id: "1" }, ctx)).toMatchObject({ ok: false, reason: "insufficient_credit" });
    expect(mem.store.usage).toHaveLength(0);
  });
});
