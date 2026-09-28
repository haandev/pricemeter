/**
 * L8 — Lago filters, grouped_by and pricing_group_keys.
 * Layer: core (dimensions) + `layeredRates` from /rates.
 *
 * How: filters = a price per dimension value, wildcard rows for the rest (`layeredRates`).
 * grouped_by = every usage row carries its dims, so invoice lines are a group-by on rows.
 * pricing_group_keys = tiers counted per group: `usedSoFar` counted per `project` instead of per meter.
 */
import { describe, expect, it } from "vitest";
import { buildMetering, type Rate } from "pricemeter";
import { layeredRates, type PriceVersion } from "pricemeter/rates";
import { memoryAdapters } from "pricemeter/testing";

const tiered = (first: number, after100: number): Rate => ({
  model: "graduated",
  tiers: [{ from: 0, unitPriceMicroUsd: first }, { from: 100, unitPriceMicroUsd: after100 }],
});
const rows: PriceVersion[] = [
  { id: "eu", meter: "api", scope: "list", dims: { region: "eu" }, effectiveFrom: 0, rate: tiered(1_000, 500) }, // filter region=eu
  { id: "default", meter: "api", scope: "list", effectiveFrom: 0, rate: tiered(2_000, 1_000) }, //                any other region
];

describe("L8 Lago filters / grouped_by / pricing_group_keys", () => {
  it("prices by filter, tiers per project, groups rows per project", async () => {
    const mem = memoryAdapters();
    const getRate = layeredRates({
      loadRows: (meter) => rows.filter((r) => r.meter === meter),
      scopes: () => ["list"],
      // pricing_group_keys: ["project"] → usage counted per project, across regions
      usedSoFar: (meter, dims, ctx) =>
        mem.store.usage.filter((u) => u.account === ctx.accountId && u.meter === meter && u.dims.project === dims.project).reduce((s, u) => s + u.quantity, 0),
    });
    const metering = buildMetering().refs(["req"]).meter("api", ["region", "project"]).bind({ getRate, commit: mem.commit });
    const ctx = { accountId: "acme" };
    const call = (id: string, region: string, project: string, n: number) => metering.observe("api", { region, project }, n, { type: "req", id }, ctx);

    expect(await call("1", "eu", "p1", 90)).toMatchObject({ charged: 90_000 }); // 90 × 1,000
    expect(await call("2", "eu", "p1", 20)).toMatchObject({ charged: 15_000 }); // p1 at 90: 10 × 1,000 + 10 × 500
    expect(await call("3", "eu", "p2", 20)).toMatchObject({ charged: 20_000 }); // p2 starts at 0
    expect(await call("4", "us", "p2", 10)).toMatchObject({ charged: 20_000 }); // default filter: 10 × 2,000

    // grouped_by: ["project"]
    const byProject: Record<string, number> = {};
    for (const u of mem.store.usage) byProject[u.dims.project as string] = (byProject[u.dims.project as string] ?? 0) + u.amount;
    expect(byProject).toEqual({ p1: 105_000, p2: 40_000 });
  });
});
