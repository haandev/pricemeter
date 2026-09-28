/**
 * SaaS seats and storage, billed per billing cycle on SQLite.
 *
 * - Seats and storage are levels, not events: the app keeps samples and, at cycle close, turns them into
 *   one quantity each with `integrate()` (seat-seconds; max GB).
 * - Proration is `per`: a seat's monthly price is spread over the cycle's seconds, so a seat added
 *   halfway costs half.
 * - Prices come from a layered table (`layeredRates`): account > plan > list, per currency (EUR accounts
 *   read EUR rows; the `Rate` itself has no currency).
 * - Enterprise plans have a monthly minimum commitment, settled with `minimumCommit` after the usage.
 * - The cycle is anchored on the subscription day (`cycleWindow`/`cycleKey`), not the calendar month.
 */
import { buildMetering, type Rate } from "pricemeter";
import { minimumCommit } from "pricemeter/adjustments";
import { cycleKey, cycleWindow } from "pricemeter/calendar";
import { integrate, type Sample } from "pricemeter/gauge";
import { layeredRates, type PriceVersion } from "pricemeter/rates";
import { sqliteAdapter, type SqliteLike } from "pricemeter-sqlite";
import { z } from "zod";

export const Context = z.object({
  accountId: z.string(),
  plan: z.enum(["team", "enterprise"]),
  currency: z.enum(["USD", "EUR"]),
  /** Subscription start: the billing cycle renews on this day of month. */
  cycleAnchor: z.number(),
});
export type Context = z.infer<typeof Context>;

/** Monthly minimum commitment per plan (in the account's currency's micro-units). */
export const MINIMUM: Record<Context["plan"], number> = { team: 0, enterprise: 500_000_000 };

const seat = (monthly: number): Rate => ({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: monthly }] });
const storage = (perGb: number): Rate => ({
  model: "graduated",
  tiers: [
    { from: 0, unitPriceMicroUsd: 0 }, // first 10 GB included
    { from: 10, unitPriceMicroUsd: perGb },
  ],
});

/** The price table. In production these are rows in your database, edited by an admin UI. */
export const PRICE_ROWS: PriceVersion[] = [
  { id: "seat-list-usd", meter: "seats", scope: "list:USD", effectiveFrom: 0, rate: seat(10_000_000) },
  { id: "seat-list-eur", meter: "seats", scope: "list:EUR", effectiveFrom: 0, rate: seat(9_000_000) },
  { id: "seat-ent-usd", meter: "seats", scope: "plan:enterprise:USD", effectiveFrom: 0, rate: seat(8_000_000) },
  { id: "gb-list-usd", meter: "storage/gb", scope: "list:USD", effectiveFrom: 0, rate: storage(250_000) },
  { id: "gb-list-eur", meter: "storage/gb", scope: "list:EUR", effectiveFrom: 0, rate: storage(230_000) },
];

export function createBilling(db: SqliteLike, rows: PriceVersion[] = PRICE_ROWS) {
  const store = sqliteAdapter({ db });
  store.migrate();

  const table = layeredRates<Context>({
    loadRows: (meter) => rows.filter((r) => r.meter === meter),
    scopes: (ctx) => [`account:${ctx.accountId}`, `plan:${ctx.plan}:${ctx.currency}`, `list:${ctx.currency}`],
    cacheMs: 60_000,
  });

  const metering = buildMetering()
    .context(Context)
    .refs(["period", "adjustment"])
    .meter("seats")
    .meter("storage/gb")
    .getRate(async (meter, dims, ctx, at) => {
      const found = await table(meter, dims, ctx, at);
      if (!found) return null;
      const cycle = cycleWindow({ at, anchor: ctx.cycleAnchor });
      const usedSoFar = store.usedSoFar({ account: ctx.accountId, meter, from: cycle.from, to: cycle.to });
      if (meter === "seats") {
        // prorate: the monthly price is per seat per cycle, quantity is seat-seconds
        const seconds = (cycle.to - cycle.from) / 1000;
        return { rate: { ...found.rate, tiers: found.rate.tiers.map((t) => ({ ...t, per: seconds })) }, usedSoFar };
      }
      return { rate: found.rate, usedSoFar };
    })
    .commit(store.commit);

  return {
    metering,
    store,
    /**
     * Closes the cycle that contains `at` (normally called by a cron right after the cycle ends).
     * Idempotent: the refs are keyed by account and cycle.
     */
    async closeCycle(i: { ctx: Context; at: number; seats: readonly Sample[]; storageGb: readonly Sample[] }) {
      const cycle = cycleWindow({ at: i.at, anchor: i.ctx.cycleAnchor });
      const key = cycleKey({ at: i.at, anchor: i.ctx.cycleAnchor });
      const seatSeconds = integrate({ samples: i.seats, window: cycle, mode: "time_weighted", unit: "s" });
      const maxGb = integrate({ samples: i.storageGb, window: cycle, mode: "max" });
      const at = cycle.to - 1;

      const usage = await metering.observe(
        [
          { meter: "seats", quantity: seatSeconds },
          { meter: "storage/gb", quantity: maxGb },
        ],
        { type: "period", id: `${i.ctx.accountId}:${key}` },
        i.ctx,
        { at },
      );
      if (!usage.ok) return { cycle: key, usage, minimum: null };

      const spent = store.spent({ account: i.ctx.accountId, from: cycle.from, to: cycle.to });
      const plan = minimumCommit({
        account: i.ctx.accountId,
        minimumMicroUsd: MINIMUM[i.ctx.plan],
        spentMicroUsd: spent,
        period: `${i.ctx.accountId}:${key}`,
        at,
        refType: "adjustment",
      });
      const minimum = await metering.commit(plan);
      return { cycle: key, usage, minimum, shortfall: plan.ledger[0]?.amount ?? 0 };
    },
  };
}
