/** Regressions from the adversarial review (see design/decisions.md A101–A104). Titles describe the bug that was fixed. */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { validateRate, type Rate } from "pricemeter";
import { minimumCommit } from "pricemeter/adjustments";
import { layeredRates, scaleTiers } from "pricemeter/rates";
import { sqliteAdapter } from "pricemeter-sqlite";
import { d1UsageSink } from "pricemeter-cloudflare";

describe("sqlite: minimumCommit across accounts", () => {
  it("second account's shortfall is silently dropped as a duplicate", async () => {
    const db = new DatabaseSync(":memory:");
    const a = sqliteAdapter({ db });
    a.migrate();
    await a.commit(minimumCommit({ account: "A", minimumMicroUsd: 1000, spentMicroUsd: 0, period: "2026-09", at: 1 }));
    await a.commit(minimumCommit({ account: "B", minimumMicroUsd: 1000, spentMicroUsd: 0, period: "2026-09", at: 1 }));
    expect(a.balance("A").balance).toBe(-1000);
    expect(a.balance("B").balance).toBe(-1000);
  });
});

describe("d1UsageSink dims encoding", () => {
  it("writes non-canonical dims (differs from sqlite canonicalJson)", async () => {
    const bound: unknown[][] = [];
    const db = { prepare: () => ({ bind: (...v: unknown[]) => (bound.push(v), v) }), batch: async () => {} };
    await d1UsageSink(db)([{ account: "a", meter: "m", dims: { b: 1, a: 2 }, quantity: 1, amount: 0 as never, detail: { breakdown: [] }, refType: "t", refId: "1", at: 0 }]);
    expect(bound[0]![3]).toBe('{"a":2,"b":1}');
  });
});

describe("layeredRates cache", () => {
  it("a transient loadRows failure is cached for cacheMs", async () => {
    let calls = 0;
    let t = 0;
    const rate: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 1 }] };
    const g = layeredRates({
      cacheMs: 60_000,
      now: () => t,
      scopes: () => ["list"],
      loadRows: async () => {
        calls++;
        if (calls === 1) throw new Error("db blip");
        return [{ id: "r", meter: "m", scope: "list", effectiveFrom: 0, rate }];
      },
    });
    await expect(g("m", {}, { accountId: "a" }, 0)).rejects.toThrow("db blip");
    t = 1000;
    await expect(g("m", {}, { accountId: "a" }, 0)).resolves.toMatchObject({ rate: { id: "r" } });
  });
});

describe("scaleTiers", () => {
  it("refuses a factor that would collapse tiers instead of producing an invalid rate", () => {
    const r: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 3 }, { from: 1, unitPriceMicroUsd: 2 }, { from: 2, unitPriceMicroUsd: 1 }] };
    expect(() => scaleTiers({ rate: r, factor: 0.4 })).toThrow(RangeError);
    expect(validateRate(scaleTiers({ rate: r, factor: 2 })).ok).toBe(true);
  });
});
