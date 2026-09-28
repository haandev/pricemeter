/** Code on the "Writing adapters" page. Runs with `bun run test` in docs/. */
import { describe, expect, it } from "vitest";
import { commitContract } from "pricemeter/testing";
// #region sqlite
import { DatabaseSync } from "node:sqlite";
import { buildMetering } from "pricemeter";
import { monthWindow } from "pricemeter/calendar";
import { sqliteAdapter } from "pricemeter/sqlite";

const db = new DatabaseSync(":memory:"); // node:sqlite here; bun:sqlite and better-sqlite3 fit too
const store = sqliteAdapter({ db, prepaid: true });
store.migrate();
store.credit("acme", 5_000_000); // $5

const metering = buildMetering()
  .refs(["api_call"])
  .meter("api/requests")
  .getRate(async (meter, _dims, ctx, at) => {
    const { from, to } = monthWindow({ at }); // usedSoFar = this calendar month
    return {
      rate: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }, { from: 1_000, unitPriceMicroUsd: 1_000 }] },
      usedSoFar: store.usedSoFar({ account: ctx.accountId, meter, from, to }),
    };
  })
  .commit(store.commit);
// #endregion

describe("adapters page", () => {
  it("passes the commit contract", async () => {
    // #region contract
    const report = await commitContract({
      make: () => {
        const a = sqliteAdapter({ db: new DatabaseSync(":memory:"), prepaid: true });
        a.migrate();
        return {
          commit: a.commit,
          seed: (account, amount) => a.credit(account, amount),
          snapshot: (account) => ({
            usage: a.usedSoFar({ account, meter: "contract/meter" }) / 3, // the sample row has quantity 3
            ledger: a.spent({ account }) === 0 ? 0 : 1,
            available: a.balance(account).available,
          }),
        };
      },
    });
    report.ok; // true
    report.checks; // [{ name: "repeated (refType, refId) is a silent no-op", ok: true }, …]
    // #endregion
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "repeated (refType, refId) is a silent no-op")?.ok).toBe(true);
  });

  it("the sqlite setup works", async () => {
    const r = await metering.observe("api/requests", {}, 1_200, { type: "api_call", id: "c1" }, { accountId: "acme" });
    expect(r).toMatchObject({ ok: true, charged: 200_000 });
    expect(store.balance("acme")).toEqual({ balance: 4_800_000, reserved: 0, available: 4_800_000 });
  });
});
