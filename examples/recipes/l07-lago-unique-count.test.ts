/**
 * L7 — Lago unique_count (distinct users per workspace).
 * Layer: recipe (like B24: the app counts distinct values).
 *
 * How: the app counts distinct ids per group from its own event store and makes one multi-line
 * observation at period end, one line per workspace (a dimension), so each row can be invoiced per group.
 */
import { describe, expect, it } from "vitest";
import { buildMetering } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";

const events = [
  { workspace: "design", user: "ana" },
  { workspace: "design", user: "bo" },
  { workspace: "design", user: "ana" }, // repeat
  { workspace: "sales", user: "cy" },
  { workspace: "sales", user: "ana" }, // same person, other workspace: counted there too
];

describe("L7 Lago unique_count", () => {
  it("one line per workspace with its distinct users", async () => {
    const mem = memoryAdapters({ rates: { "users/active": { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 100_000 }] } } });
    const metering = buildMetering().refs(["period"]).meter("users/active", ["workspace"]).bind(mem);

    const uniques = new Map<string, Set<string>>();
    for (const e of events) uniques.set(e.workspace, (uniques.get(e.workspace) ?? new Set()).add(e.user));
    const lines = [...uniques].map(([workspace, users]) => ({ meter: "users/active" as const, dims: { workspace }, quantity: users.size }));

    const r = await metering.observe(lines, { type: "period", id: "2026-09" }, { accountId: "acme" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.charged).toBe(400_000); // (2 + 2) × 100,000
    expect(mem.store.usage.map((u) => [u.dims.workspace, u.quantity, u.amount, u.refId])).toEqual([
      ["design", 2, 200_000, "period:2026-09:users/active"],
      ["sales", 2, 200_000, "period:2026-09:users/active#2"], // same meter twice in one call → #2
    ]);
  });
});
