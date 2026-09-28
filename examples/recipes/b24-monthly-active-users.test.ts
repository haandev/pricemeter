/**
 * B24 — Monthly active users (MAU).
 * Layer: recipe (the app counts uniques; one `observe` per period).
 *
 * How: counting distinct users needs the event history, which lives in the app. At period end the
 * app counts them and makes a single observation with a period ref, so a retried close job is a
 * no-op in `commit`.
 */
import { describe, expect, it } from "vitest";
import { buildMetering } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const logins = [
  { user: "u1", at: "2026-09-02" },
  { user: "u2", at: "2026-09-03" },
  { user: "u1", at: "2026-09-10" }, // repeat
  { user: "u3", at: "2026-09-12" },
  { user: "u4", at: "2026-09-30" },
  { user: "u5", at: "2026-10-01" }, // next month
];

describe("B24 MAU", () => {
  it("observes the month's distinct users once", async () => {
    const mem = memoryAdapters({ rates: { mau: { id: "mau", model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 50_000 }] } } });
    const metering = buildMetering().refs(["period"]).meter("mau").bind(mem);
    const ctx = { accountId: "acme" };

    const mau = new Set(logins.filter((l) => l.at.startsWith("2026-09")).map((l) => l.user)).size;
    expect(mau).toBe(4);

    const close = () => metering.observe("mau", {}, mau, { type: "period", id: "2026-09" }, ctx);
    expect(await close()).toMatchObject({ ok: true, charged: 200_000 }); // 4 × 50,000
    await close(); // retried: same (refType, refId), nothing new is written
    expect(mem.store.ledger).toHaveLength(1);
    expect(mem.store.account("acme").balance).toBe(-200_000);
  });
});
