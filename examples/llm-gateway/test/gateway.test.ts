import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createGateway, LIFETIME_FREE_INPUT } from "../src/gateway.js";

const T0 = Date.parse("2026-09-01T10:00:00Z");
const ctx = { accountId: "acme" };

function gateway() {
  return createGateway(new DatabaseSync(":memory:"));
}

describe("llm-gateway", () => {
  it("buffers calls per minute and flushes one idempotent batch", async () => {
    const g = gateway();
    for (let i = 0; i < 100; i++) g.record({ ctx, model: "haiku", inputTokens: 1000, outputTokens: 7, at: T0 + i * 100 });
    expect(await g.flush(T0 + 30_000)).toEqual([]); // minute not over yet
    const [batch] = await g.flush(T0 + 60_000);
    expect(batch!.batch).toMatchObject({ inputTokens: 100_000, outputTokens: 700 });
    expect(batch!.result.ok).toBe(true);
    // 700 output tokens × weight 1 = 700 credits at $0.02 / 1k → 14_000 micro; input still in the free lifetime quota
    expect(batch!.result.ok && batch!.result.charged).toBe(14_000);
    expect(g.store.usedSoFar({ account: "acme", meter: "llm/credits" })).toBe(700);
    // replaying the same batch (e.g. a crash before the buffer was cleared) writes nothing new
    const again = await g.metering.observe(
      [
        { meter: "llm/input", dims: { model: "haiku" }, quantity: 100_000 },
        { meter: "llm/output", dims: { model: "haiku" }, quantity: 700 },
      ],
      { type: "batch", id: `acme:haiku:${T0}` },
      ctx,
      { at: T0 },
    );
    expect(again.ok).toBe(true);
    expect(g.store.spent({ account: "acme" })).toBe(14_000);
  });

  it("cumulative per-million pricing does not drift across tiny calls", async () => {
    const g = gateway();
    // use up the lifetime quota first
    g.record({ ctx, model: "sonnet", inputTokens: LIFETIME_FREE_INPUT, outputTokens: 0, at: T0 });
    await g.flush(T0 + 60_000);
    // then 1,000 one-minute batches of 333 tokens: 333,000 tokens × $3/1M = $0.999 = 999_000 micro exactly
    for (let i = 1; i <= 1000; i++) g.record({ ctx, model: "sonnet", inputTokens: 333, outputTokens: 0, at: T0 + i * 60_000 });
    const rs = await g.flush(T0 + 1002 * 60_000);
    const total = rs.reduce((a, r) => a + (r.result.ok ? r.result.charged : 0), 0);
    expect(total).toBe(999_000);
  });

  it("output tokens feed credits by model weight", async () => {
    const g = gateway();
    g.record({ ctx, model: "opus", inputTokens: 0, outputTokens: 1000, at: T0 });
    g.record({ ctx, model: "haiku", inputTokens: 0, outputTokens: 1000, at: T0 });
    const rs = await g.flush(T0 + 60_000);
    const credits = rs.flatMap((r) => (r.result.ok ? r.result.lines : [])).filter((l) => l.meter === "llm/credits");
    expect(credits.map((l) => [l.feeder, l.quantity])).toEqual([
      ["llm/output", 5000],
      ["llm/output", 1000],
    ]);
  });

  it("volume on_crossing: passing 10M credits reprices the month with a negative adjustment", async () => {
    const g = gateway();
    // 1,999,000 opus output tokens × 5 = 9,995,000 credits → 9,995,000 × $0.02/1k = $199.90
    g.record({ ctx, model: "opus", inputTokens: 0, outputTokens: 1_999_000, at: T0 });
    const [first] = await g.flush(T0 + 60_000);
    expect(first!.result.ok && first!.result.charged).toBe(199_900_000);
    // 2,000 more → 10,000 credits cross 10M: they cost $0.015/1k and the earlier 9,995,000 get −$0.005/1k
    g.record({ ctx, model: "opus", inputTokens: 0, outputTokens: 2000, at: T0 + 60_000 });
    const [second] = await g.flush(T0 + 120_000);
    const line = second!.result.ok ? second!.result.lines.find((l) => l.meter === "llm/credits")! : undefined;
    expect(line?.amount).toBe(150_000);
    expect(line?.adjustment).toBe(-49_975_000);
    // month total = 10,005,000 credits at the 10M tier = $150.075
    expect(g.store.spent({ account: "acme" })).toBe(150_075_000);
  });

  it("CRM discount comes from the context", async () => {
    const g = gateway();
    const vip = { accountId: "vip", discountPct: 25 };
    g.record({ ctx: vip, model: "haiku", inputTokens: 0, outputTokens: 1000, at: T0 });
    const [r] = await g.flush(T0 + 60_000);
    expect(r!.result.ok && r!.result.charged).toBe(15_000); // 20_000 × 0.75
  });

  it("lifetime quota: the first 1M input tokens per model are free, whenever they happen", async () => {
    const g = gateway();
    g.record({ ctx, model: "opus", inputTokens: 900_000, outputTokens: 0, at: T0 });
    await g.flush(T0 + 60_000);
    // a year later the quota is still partly there: 100k free + 100k at $15/1M
    const later = T0 + 365 * 86_400_000;
    g.record({ ctx, model: "opus", inputTokens: 200_000, outputTokens: 0, at: later });
    const [r] = await g.flush(later + 60_000);
    expect(r!.result.ok && r!.result.charged).toBe(1_500_000);
  });

  it("postpaid: no balance needed", async () => {
    const g = gateway();
    expect(g.store.balance("acme").available).toBe(0);
    g.record({ ctx, model: "opus", inputTokens: 0, outputTokens: 10, at: T0 });
    const [r] = await g.flush(T0 + 60_000);
    expect(r!.result.ok).toBe(true);
    expect(g.store.balance("acme").balance).toBeLessThan(0);
  });

  it("a failed flush keeps the batch for the next one", async () => {
    const g = gateway();
    g.record({ ctx: { accountId: 42 as never }, model: "opus", inputTokens: 1, outputTokens: 1, at: T0 });
    const [r] = await g.flush(T0 + 60_000);
    expect(r!.result).toMatchObject({ ok: false, reason: "invalid_context" });
    expect(await g.flush(T0 + 120_000)).toHaveLength(1);
  });
});
