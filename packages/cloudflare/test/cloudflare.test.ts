import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMetering, microUsd, type Plan, type Rate } from "pricemeter";
import { monthKey } from "pricemeter/calendar";
import { commitContract } from "pricemeter/testing";
import {
  accountState,
  accountUsed,
  applyPlan,
  commitReply,
  creditAccount,
  D1_USAGE_SCHEMA,
  d1UsageSink,
  doCommit,
  flushOutbox,
  migrateAccount,
  readOutbox,
} from "pricemeter-cloudflare";
import { fakeD1, fakeStorage } from "./shim.js";

/** One fake DO per account. */
function accounts(prepaid = true) {
  const dos = new Map<string, ReturnType<typeof fakeStorage>>();
  const get = (id: string) => {
    let s = dos.get(id);
    if (!s) {
      s = fakeStorage();
      migrateAccount(s.sql);
      migrateAccount(s.sql); // idempotent
      dos.set(id, s);
    }
    return s;
  };
  const periodOf = (row: { at: number }) => monthKey({ at: row.at });
  const commit = doCommit((id) => ({ commit: async (plan: Plan) => commitReply(get(id), plan, { prepaid, periodOf }) }));
  return { get, commit, periodOf };
}

describe("pricemeter-cloudflare", () => {
  it("passes the commit contract through the DO RPC path", async () => {
    const res = await commitContract({
      make: () => {
        const a = accounts();
        return {
          commit: a.commit,
          seed: (id, n) => creditAccount(a.get(id).sql, n),
          snapshot: (id) => {
            const s = a.get(id);
            const count = (t: string) => Number((s.sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).one() as { n: number }).n);
            return { usage: count("pm_usage_seen"), ledger: count("pm_ledger"), available: accountState(s.sql).available };
          },
        };
      },
    });
    expect(res.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("observe → DO ledger and counters → outbox → D1", async () => {
    const a = accounts();
    creditAccount(a.get("acc").sql, 1_000_000);
    const rate: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }, { from: 2, unitPriceMicroUsd: 10_000 }] };
    const m = buildMetering()
      .context(z.object({ accountId: z.string() }))
      .refs(["otp_send"])
      .meter("sms", { country: z.string() })
      .getRate(async (_meter, _dims, ctx, at) => ({ rate, usedSoFar: accountUsed(a.get(ctx.accountId).sql, "sms", monthKey({ at })) }))
      .commit(a.commit);
    const at = Date.parse("2026-09-10T00:00:00Z");
    expect(await m.observe("sms", { country: "TR" }, 3, { type: "otp_send", id: "1" }, { accountId: "acc" }, { at })).toMatchObject({ ok: true, charged: 10_000 });
    expect(accountUsed(a.get("acc").sql, "sms", "2026-09")).toBe(3);
    expect(accountState(a.get("acc").sql)).toEqual({ balance: 990_000, reserved: 0, available: 990_000 });

    const d1 = fakeD1();
    d1.db.exec(D1_USAGE_SCHEMA);
    const sink = d1UsageSink(d1 as never);
    expect(await flushOutbox(a.get("acc").sql, sink)).toBe(1);
    expect(await flushOutbox(a.get("acc").sql, sink)).toBe(0);
    await sink([]); // no-op
    // re-shipping the same rows is harmless
    const row = JSON.parse(JSON.stringify((d1.db.prepare("SELECT * FROM usage_events").get() as { ref_id: string }).ref_id));
    expect(row).toBe("otp_send:1:sms");
    expect(readOutbox(a.get("acc").sql).rows).toEqual([]);
  });

  it("embedded pricing: the DO re-prices lines from plan.observe with its own counters", async () => {
    const a = accounts();
    const s = a.get("acc");
    creditAccount(s.sql, 100_000);
    const rate: Rate = { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }, { from: 5, unitPriceMicroUsd: 1000 }] };
    const catalog = buildMetering().context(z.object({ accountId: z.string() })).meter("sms");
    // Worker: stale counters (0)
    const worker = catalog.bind({ getRate: async () => ({ rate, usedSoFar: 0 }), commit: a.commit });
    const planned = await worker.plan.observe("sms", {}, 2, { type: "t", id: "x" }, { accountId: "acc" }, { at: 0 });
    expect(planned.result).toMatchObject({ charged: 0 });
    // DO: 4 already used → 1 unit crosses into the paid tier
    applyPlan(s, { ledger: [], usage: [{ account: "acc", meter: "sms", dims: {}, quantity: 4, amount: microUsd(0), detail: { breakdown: [] }, refType: "t", refId: "seed", at: 0 }] });
    const fresh = planned.lines.map((l) => ({ ...l, usedSoFar: accountUsed(s.sql, l.meter) }));
    const repriced = catalog.price(fresh as never, { type: "t", id: "x" }, { accountId: "acc" });
    expect(repriced.result).toMatchObject({ ok: true, charged: 1000 });
    applyPlan(s, repriced.plan, { prepaid: true });
    expect(accountState(s.sql).balance).toBe(99_000);
  });

  it("doCommit rejects multi-account plans and ignores empty ones", async () => {
    const a = accounts();
    const row = (account: string) => ({ op: "charge" as const, account, amount: microUsd(1), refType: "t", refId: account, at: 0 });
    await expect(a.commit({ ledger: [row("a"), row("b")], usage: [] })).rejects.toThrow(/one account/);
    await a.commit({ ledger: [], usage: [] });
    expect(() => creditAccount(a.get("a").sql, 0.5)).toThrow(RangeError);
    expect(() => commitReply({ sql: { exec: () => { throw new Error("disk"); } } as never, transactionSync: (f) => f() }, { ledger: [row("a")], usage: [] })).toThrow("disk");
  });
});
