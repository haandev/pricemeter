import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createBilling, PRICE_ROWS, type Context } from "../src/billing.js";

const d = (s: string) => Date.parse(s);
// Subscribed on 15 Aug: cycles run 15th → 15th. The Sep 15 → Oct 15 cycle has 30 days.
const anchor = d("2026-08-15T00:00:00Z");
const inCycle = d("2026-09-20T00:00:00Z");
const cycleStart = d("2026-09-15T00:00:00Z");
const half = d("2026-09-30T00:00:00Z");

const team: Context = { accountId: "acme", plan: "team", currency: "USD", cycleAnchor: anchor };

describe("saas-seats", () => {
  it("prorates seats added mid-cycle and bills max storage above the free 10 GB", async () => {
    const b = createBilling(new DatabaseSync(":memory:"));
    const r = await b.closeCycle({
      ctx: team,
      at: inCycle,
      seats: [
        { at: d("2026-09-01T00:00:00Z"), value: 3 }, // 3 seats from before the cycle
        { at: half, value: 5 }, // +2 seats for the second half
      ],
      storageGb: [
        { at: cycleStart, value: 4 },
        { at: d("2026-10-01T00:00:00Z"), value: 12.4 }, // peak rounds up to 13 GB
        { at: d("2026-10-05T00:00:00Z"), value: 6 },
      ],
    });
    expect(r.cycle).toBe("2026-09-15");
    // seats: 3 × $10 + 2 × $10 × ½ = $40; storage: (13 − 10) × $0.25 = $0.75
    expect(r.usage).toMatchObject({ ok: true, charged: 40_750_000 });
    expect(r.shortfall).toBe(0);
    // closing again (cron retry) changes nothing
    await b.closeCycle({ ctx: team, at: inCycle, seats: [{ at: 0, value: 99 }], storageGb: [] });
    expect(b.store.spent({ account: "acme" })).toBe(40_750_000);
  });

  it("EUR accounts read EUR rows; the Rate has no currency", async () => {
    const b = createBilling(new DatabaseSync(":memory:"));
    const r = await b.closeCycle({ ctx: { ...team, accountId: "eu", currency: "EUR" }, at: inCycle, seats: [{ at: 0, value: 2 }], storageGb: [] });
    expect(r.usage).toMatchObject({ ok: true, charged: 18_000_000 }); // 2 × €9
  });

  it("enterprise: plan price, then the minimum commitment tops up the cycle", async () => {
    const b = createBilling(new DatabaseSync(":memory:"));
    const ent: Context = { ...team, accountId: "bigco", plan: "enterprise" };
    const r = await b.closeCycle({ ctx: ent, at: inCycle, seats: [{ at: 0, value: 10 }], storageGb: [] });
    expect(r.usage).toMatchObject({ ok: true, charged: 80_000_000 }); // 10 × $8
    expect(r.minimum).toEqual({ ok: true });
    expect(r.shortfall).toBe(420_000_000); // $500 − $80
    expect(b.store.spent({ account: "bigco" })).toBe(500_000_000);
    await b.closeCycle({ ctx: ent, at: inCycle, seats: [{ at: 0, value: 10 }], storageGb: [] });
    expect(b.store.spent({ account: "bigco" })).toBe(500_000_000);
  });

  it("an account-specific price beats plan and list", async () => {
    const rows = [...PRICE_ROWS, { id: "seat-acme", meter: "seats", scope: "account:acme", effectiveFrom: 0, rate: { model: "graduated" as const, tiers: [{ from: 0, unitPriceMicroUsd: 7_000_000 }] } }];
    const b = createBilling(new DatabaseSync(":memory:"), rows);
    const r = await b.closeCycle({ ctx: team, at: inCycle, seats: [{ at: 0, value: 1 }], storageGb: [] });
    expect(r.usage).toMatchObject({ ok: true, charged: 7_000_000 });
    expect(b.store.usedSoFar({ account: "acme", meter: "seats" })).toBe(30 * 86_400);
  });

  it("no price row → no_price, nothing written", async () => {
    const b = createBilling(new DatabaseSync(":memory:"), []);
    const r = await b.closeCycle({ ctx: team, at: inCycle, seats: [{ at: 0, value: 1 }], storageGb: [] });
    expect(r.usage).toMatchObject({ ok: false, reason: "no_price", meter: "seats" });
    expect(r.minimum).toBeNull();
  });
});
