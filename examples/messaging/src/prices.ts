/**
 * Where prices come from:
 * - a layered table (account > plan > list) — in production D1 rows edited by admins;
 * - per-event route cost for SMS countries without a table row: the carrier's cost at `at` plus margin;
 * - Meta's WhatsApp window prices, which may be published late (no row yet → `no_price` → queue).
 */
import type { Rate } from "pricemeter";
import { resolveLayered, type PriceVersion } from "pricemeter/rates";
import type { Context } from "./catalog.js";

const flat = (p: number): Rate => ({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: p }] });

export const PRICE_ROWS: PriceVersion[] = [
  // SMS: Turkey gets cheaper above 10k/month (B1)
  {
    id: "sms-tr-list",
    meter: "otp/sms",
    scope: "list",
    dims: { country: "TR" },
    effectiveFrom: 0,
    rate: {
      model: "graduated",
      tiers: [
        { from: 0, unitPriceMicroUsd: 20_000 },
        { from: 10_000, unitPriceMicroUsd: 15_000 },
      ],
      policy: { tierPeriod: "month" },
    },
  },
  { id: "sms-pro", meter: "otp/sms", scope: "plan:pro", dims: { country: "TR" }, effectiveFrom: 0, rate: flat(18_000) },
  { id: "wa-list", meter: "otp/whatsapp", scope: "list", effectiveFrom: 0, rate: flat(10_000) },
  { id: "verify-list", meter: "otp/verify", scope: "list", effectiveFrom: 0, rate: flat(5_000) },
  // platform fee per message after 1,000 free each month, across channels (B4)
  {
    id: "pool-list",
    meter: "msg/free_pool",
    scope: "list",
    effectiveFrom: 0,
    rate: {
      model: "graduated",
      tiers: [
        { from: 0, unitPriceMicroUsd: 0 },
        { from: 1000, unitPriceMicroUsd: 2_000 },
      ],
      policy: { tierPeriod: "month" },
    },
  },
  // WhatsApp conversation windows, per country, as Meta publishes them
  { id: "wa-window-tr", meter: "wa/window", scope: "list", dims: { country: "TR" }, effectiveFrom: 0, rate: flat(9_000) },
  // Dedicated IP: $50 once per month, whatever else happens (B11)
  {
    id: "ip-list",
    meter: "ip/dedicated",
    scope: "list",
    effectiveFrom: 0,
    rate: { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 0, flatMicroUsd: 50_000_000 }], policy: { tierPeriod: "month" } },
  },
];

/** Carrier cost per SMS by country, over time. In production a feed you cache. */
export interface RouteCost {
  country: string;
  from: number;
  costMicroUsd: number;
}

export const ROUTE_MARGIN = 1.25;

export function routeRate(routes: readonly RouteCost[], countryCode: string, at: number): Rate | null {
  const current = routes.filter((r) => r.country === countryCode && r.from <= at).sort((a, b) => b.from - a.from)[0];
  if (!current) return null;
  return { id: `route-${countryCode}-${current.from}`, model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: Math.ceil(current.costMicroUsd * ROUTE_MARGIN) }] };
}

export const scopesFor = (ctx: Context) => [`account:${ctx.accountId}`, `plan:${ctx.plan}`, "list"];

/** Table first, then route cost for SMS. */
export function findRate(i: { rows: readonly PriceVersion[]; routes: readonly RouteCost[]; meter: string; dims: Record<string, unknown>; ctx: Context; at: number }): Rate | null {
  const fromTable = resolveLayered({ rows: i.rows, scopes: scopesFor(i.ctx), dims: i.dims, at: i.at, meter: i.meter });
  if (fromTable) return fromTable;
  if (i.meter === "otp/sms") return routeRate(i.routes, String(i.dims.country), i.at);
  return null;
}
