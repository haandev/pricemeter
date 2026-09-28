/**
 * L5 — Lago progressive billing (invoice early when usage crosses a threshold).
 * Layer: out of scope — it is an invoicing feature.
 *
 * Why: pricemeter has no invoices. Its job ends at a priced plan; when to bill is the app's.
 * Nearest supported pattern: the prepaid gate. Progressive billing exists to cap exposure to unpaid
 * usage; a prepaid `commit` caps it at zero, atomically, by refusing what the balance cannot cover.
 * (A threshold-triggered invoice is an app job that sums `usage` rows, like any other.)
 */
import { describe, expect, it } from "vitest";
import { buildMetering } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

describe("L5 Lago progressive billing (out of scope)", () => {
  it("a prepaid commit bounds exposure instead of an early invoice", async () => {
    const mem = memoryAdapters({ prepaid: true, balances: { acme: 100_000 }, rates: { api: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1_000 }] } } });
    const metering = buildMetering().refs(["req", "topup"]).meter("api").bind(mem);
    const ctx = { accountId: "acme" };

    expect(await metering.observe("api", {}, 60, { type: "req", id: "1" }, ctx)).toMatchObject({ ok: true, charged: 60_000 });
    // 60 more would need 60,000 with 40,000 left: refused, nothing written.
    expect(await metering.observe("api", {}, 60, { type: "req", id: "2" }, ctx)).toMatchObject({ ok: false, reason: "insufficient_credit" });
    expect(mem.store.usage).toHaveLength(1);

    // The app tops up (its payment flow), then the same request goes through.
    mem.store.credit("acme", 100_000);
    expect(await metering.observe("api", {}, 60, { type: "req", id: "2" }, ctx)).toMatchObject({ ok: true, charged: 60_000 });
    expect(mem.store.available("acme")).toBe(80_000);
  });
});
