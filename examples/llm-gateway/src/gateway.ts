/**
 * An LLM gateway on SQLite.
 *
 * - Tokens are priced per million with `cumulative` rounding, so a month of tiny calls never drifts.
 * - Calls are buffered per (account, model) and flushed once a minute as one `observe` (ref type "batch").
 * - Output tokens feed a credits pool with a per-model weight; credits are priced by volume with `on_crossing`.
 * - Every account gets its first 1M input tokens per model free, for life (usedSoFar over all time).
 * - A CRM discount from the context is applied in getRate. Postpaid: commit never checks balances.
 */
import { buildMetering, type Rate } from "pricemeter";
import { monthWindow } from "pricemeter/calendar";
import { applyDiscount } from "pricemeter/rates";
import { sqliteAdapter, type SqliteLike } from "pricemeter-sqlite";
import { z } from "zod";

export const MODELS = ["opus", "sonnet", "haiku"] as const;
export type Model = (typeof MODELS)[number];

/** Micro-USD per 1M tokens. */
const INPUT_PRICE: Record<Model, number> = { opus: 15_000_000, sonnet: 3_000_000, haiku: 800_000 };
/** Credits per output token, by model. */
export const CREDIT_WEIGHT: Record<Model, number> = { opus: 5, sonnet: 3, haiku: 1 };

export const LIFETIME_FREE_INPUT = 1_000_000;

const perMillion = (price: number, id: string): Rate => ({
  id,
  model: "graduated",
  tiers: [
    { from: 0, unitPriceMicroUsd: 0, per: 1_000_000 },
    { from: LIFETIME_FREE_INPUT, unitPriceMicroUsd: price, per: 1_000_000 },
  ],
  policy: { rounding: "cumulative", tierPeriod: "lifetime" },
});

/** Credits: $0.02 per 1k credits, $0.015 once the month passes 10M credits — for the whole month. */
export const CREDIT_RATE: Rate = {
  id: "credits-2026",
  model: "volume",
  tiers: [
    { from: 0, unitPriceMicroUsd: 20_000, per: 1000 },
    { from: 10_000_000, unitPriceMicroUsd: 15_000, per: 1000 },
  ],
  policy: { adjustmentTiming: "on_crossing", rounding: "cumulative", tierPeriod: "month" },
};

export const Context = z.object({
  accountId: z.string(),
  /** From the CRM: percent off every price. */
  discountPct: z.number().min(0).max(100).optional(),
});
export type Context = z.infer<typeof Context>;

export function createGateway(db: SqliteLike) {
  const store = sqliteAdapter({ db }); // postpaid: no balance gate
  store.migrate();

  const metering = buildMetering()
    .context(Context)
    .refs(["request", "batch"])
    .meter("llm/credits")
    .meter("llm/input", { model: z.enum(MODELS) })
    .meter("llm/output", { model: z.enum(MODELS) }, { feeds: { "llm/credits": (d) => CREDIT_WEIGHT[d.model] } })
    .getRate(async (meter, dims, ctx, at) => {
      const discount = (r: Rate) => (ctx.discountPct ? applyDiscount({ rate: r, percent: ctx.discountPct }) : r);
      if (meter === "llm/input") {
        // lifetime quota: the counter spans all time
        const usedSoFar = store.usedSoFar({ account: ctx.accountId, meter, dims });
        return { rate: discount(perMillion(INPUT_PRICE[dims.model], `input-${dims.model}`)), usedSoFar };
      }
      if (meter === "llm/output") {
        // output tokens only count; money flows through credits
        return { rate: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0 }] } };
      }
      const { from, to } = monthWindow({ at });
      return { rate: discount(CREDIT_RATE), usedSoFar: store.usedSoFar({ account: ctx.accountId, meter, from, to }) };
    })
    .commit(store.commit);

  const buffer = new TokenBuffer();

  return {
    metering,
    store,
    /** Record one completion; nothing is priced until the minute is flushed. */
    record(i: { ctx: Context; model: Model; inputTokens: number; outputTokens: number; at: number }) {
      buffer.add(i);
    },
    /** Flush every minute that ended before `now`. Safe to call repeatedly: batch refs are idempotent. */
    async flush(now: number) {
      const results = [];
      for (const b of buffer.drain(now)) {
        const r = await metering.observe(
          [
            { meter: "llm/input", dims: { model: b.model }, quantity: b.inputTokens },
            { meter: "llm/output", dims: { model: b.model }, quantity: b.outputTokens },
          ],
          { type: "batch", id: `${b.ctx.accountId}:${b.model}:${b.minute}` },
          b.ctx,
          { at: b.minute },
        );
        if (!r.ok) buffer.restore(b); // try again on the next flush
        results.push({ batch: b, result: r });
      }
      return results;
    },
  };
}

interface Batch {
  ctx: Context;
  model: Model;
  minute: number;
  inputTokens: number;
  outputTokens: number;
}

/** Per-minute token buffer. In production this is a Durable Object or Redis; the pattern is the same. */
export class TokenBuffer {
  #batches = new Map<string, Batch>();

  add(i: { ctx: Context; model: Model; inputTokens: number; outputTokens: number; at: number }) {
    const minute = Math.floor(i.at / 60_000) * 60_000;
    const key = `${i.ctx.accountId}\u0000${i.model}\u0000${minute}`;
    const b = this.#batches.get(key) ?? { ctx: i.ctx, model: i.model, minute, inputTokens: 0, outputTokens: 0 };
    b.inputTokens += i.inputTokens;
    b.outputTokens += i.outputTokens;
    this.#batches.set(key, b);
  }

  drain(now: number): Batch[] {
    const out: Batch[] = [];
    for (const [k, b] of this.#batches) {
      if (b.minute + 60_000 <= now) {
        out.push(b);
        this.#batches.delete(k);
      }
    }
    return out.sort((a, b) => a.minute - b.minute);
  }

  restore(b: Batch) {
    this.#batches.set(`${b.ctx.accountId}\u0000${b.model}\u0000${b.minute}`, b);
  }

  get size() {
    return this.#batches.size;
  }
}
