import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMetering, type Rate } from "pricemeter";
import { commitContract } from "pricemeter/testing";
import { canonicalJson, sqliteAdapter } from "pricemeter/sqlite";

const fresh = (prepaid = true) => {
  const db = new DatabaseSync(":memory:");
  const a = sqliteAdapter({ db, prepaid });
  a.migrate();
  return { db, a };
};

describe("pricemeter/sqlite", () => {
  it("passes the commit contract (prepaid and postpaid)", async () => {
    const make = (prepaid: boolean) => () => {
      const { a } = fresh(prepaid);
      return {
        commit: a.commit,
        seed: (acc: string, n: number) => a.credit(acc, n),
        snapshot: (acc: string) => ({
          usage: a.usedSoFar({ account: acc, meter: "contract/meter" }) / 3,
          ledger: a.spent({ account: acc }) === 0 ? 0 : 1,
          available: a.balance(acc).available,
        }),
      };
    };
    const pre = await commitContract({ make: make(true) });
    expect(pre.checks.filter((c) => !c.ok)).toEqual([]);
    const post = await commitContract({ make: make(false), prepaid: false });
    expect(post.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("rolls back everything when short", async () => {
    const { db, a } = fresh();
    a.credit("acc", 100);
    const m = buildMetering()
      .context(z.object({ accountId: z.string() }))
      .meter("sms", { country: z.string() })
      .getRate(async (_m, _d, ctx, at) => ({ rate: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 60 }] } satisfies Rate, usedSoFar: a.usedSoFar({ account: ctx.accountId, meter: "sms", to: at + 1 }) }))
      .commit(a.commit);
    expect(await m.observe("sms", { country: "TR" }, 1, { type: "t", id: "1" }, { accountId: "acc" })).toMatchObject({ ok: true, charged: 60 });
    expect(await m.observe("sms", { country: "TR" }, 1, { type: "t", id: "2" }, { accountId: "acc" })).toMatchObject({ ok: false, reason: "insufficient_credit" });
    const rows = db.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number };
    expect(rows.n).toBe(1);
    expect(a.balance("acc")).toEqual({ balance: 40, reserved: 0, available: 40 });
  });

  it("counts usage by window and exact dims; stores canonical dims", async () => {
    const { db, a } = fresh(false);
    const row = (refId: string, dims: object, quantity: number, at: number) => ({
      account: "acc", meter: "m", dims: dims as Record<string, unknown>, quantity, amount: 0 as never, detail: { breakdown: [] }, refType: "t", refId, at,
    });
    await a.commit({ ledger: [], usage: [row("1", { b: 1, a: 2 }, 3, 10), row("2", { a: 2, b: 1 }, 4, 20), row("3", { a: 9 }, 5, 30)] });
    expect(a.usedSoFar({ account: "acc", meter: "m" })).toBe(12);
    expect(a.usedSoFar({ account: "acc", meter: "m", from: 15, to: 30 })).toBe(4);
    expect(a.usedSoFar({ account: "acc", meter: "m", dims: { a: 2, b: 1 } })).toBe(7);
    expect((db.prepare("SELECT dims FROM usage_events WHERE id = 't:1'").get() as { dims: string }).dims).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: [1, { y: 2, x: undefined }], a: null })).toBe('{"a":null,"z":[1,{"y":2}]}');
    expect(() => a.credit("acc", 1.5)).toThrow(RangeError);
  });

  it("rethrows driver errors after rollback", async () => {
    const { a } = fresh(false);
    const bad = { ledger: [{ op: "charge", account: "a", amount: 1, refType: "t", refId: "1", at: null }], usage: [] } as never;
    await expect(Promise.resolve().then(() => a.commit(bad))).rejects.toThrow();
    expect(a.spent({ account: "a" })).toBe(0);
  });
});
