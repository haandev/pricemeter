# pricemeter recipes

One runnable test per scenario in the scenario matrix (spec, appendix B). Each file opens with a
short note: the scenario, which layer handles it (core, recipe, module, or out of scope), and how
you would build it. Every amount is asserted in micro-units, and the arithmetic is in the comments.

```sh
bunx vitest run examples/recipes
bunx tsc --noEmit -p examples/recipes/tsconfig.json
```

| # | Scenario | How | Layer | File |
| --- | --- | --- | --- | --- |
| B1 | SMS by country, discount above 10k | graduated, dims `country` | core | [b01-sms-country-tiers](b01-sms-country-tiers.test.ts) |
| B2 | LLM $0.15 / 1M tokens | graduated, `per: 1M`, `cumulative` | core | [b02-llm-tokens-per-million](b02-llm-tokens-per-million.test.ts) |
| B3 | First 500 per month free | graduated `[0: 0, 500: p]` | core | [b03-monthly-free-allowance](b03-monthly-free-allowance.test.ts) |
| B4 | SMS + WhatsApp shared quota | `feeds` pool | core | [b04-shared-quota-pool](b04-shared-quota-pool.test.ts) |
| B5 | Blocks of 1,000 | package | core | [b05-package-blocks](b05-package-blocks.test.ts) |
| B6 | Volume: crossing a threshold reprices the month | volume `on_crossing` or `volumeTrueUp` | core / module | [b06-volume-reprice-month](b06-volume-reprice-month.test.ts) |
| B7 | Conversation priced at close by length | app classifies, `dims.tier` | recipe | [b07-conversation-by-length](b07-conversation-by-length.test.ts) |
| B8 | Per conversation-minute | `quantity: minutes` | core | [b08-per-minute](b08-per-minute.test.ts) |
| B9 | Seat $10/mo, prorated mid-month | `integrate` + `per: monthSeconds` | module | [b09-seats-prorated](b09-seats-prorated.test.ts) |
| B10 | Storage: month's max GB | `integrate({ mode: "max" })` | module | [b10-storage-monthly-max](b10-storage-monthly-max.test.ts) |
| B11 | Dedicated IP $50/mo flat | single tier `flatMicroUsd` | core | [b11-flat-monthly-fee](b11-flat-monthly-fee.test.ts) |
| B12 | Monthly minimum commitment | `minimumCommit` | module | [b12-minimum-commit](b12-minimum-commit.test.ts) |
| B13 | Night rate / campaign | `getRate(at)` | recipe | [b13-night-rate-campaign](b13-night-rate-campaign.test.ts) |
| B14 | Enterprise: group price, account more specific | `layeredRates` | recipe / module | [b14-enterprise-layered-rates](b14-enterprise-layered-rates.test.ts) |
| B15 | One request, two meters, one hold | multi-line `hold` | core | [b15-one-hold-two-meters](b15-one-hold-two-meters.test.ts) |
| B16 | Lifetime first 1,000 free | lifetime `usedSoFar` counter (`LIFETIME`) | recipe | [b16-lifetime-free-tier](b16-lifetime-free-tier.test.ts) |
| B17 | EUR tariff | getRate by currency; `Rate` has no currency | recipe | [b17-eur-tariff](b17-eur-tariff.test.ts) |
| B18 | Expiring credits | ledger adapter; `flatCredit` + expiry charge | out of scope | [b18-expiring-credits](b18-expiring-credits.test.ts) |
| B19 | Customer-specific price, three ways | account row, plan row, `applyDiscount` | recipe | [b19-customer-specific-price](b19-customer-specific-price.test.ts) |
| B20 | Custom price → list; open hold keeps old tariff | tariff embedded in hold | core | [b20-hold-keeps-tariff](b20-hold-keeps-tariff.test.ts) |
| B21 | Flat fee per tier | `Tier.flatMicroUsd` | core | [b21-flat-fee-per-tier](b21-flat-fee-per-tier.test.ts) |
| B22 | Percent + fixed per transaction + cap | `per: 1M` + `flatMicroUsd` + `perObservation`, `usedSoFar: 0` | core | [b22-percent-fixed-cap](b22-percent-fixed-cap.test.ts) |
| B23 | Per-event price (route cost) | `getRate(at)` per observation | recipe | [b23-per-event-route-cost](b23-per-event-route-cost.test.ts) |
| B24 | MAU | app counts uniques, one `observe` | recipe | [b24-monthly-active-users](b24-monthly-active-users.test.ts) |
| B25 | Reseller → customer → list | three layers in getRate | recipe | [b25-reseller-layers](b25-reseller-layers.test.ts) |
| B26 | Postpaid | commit doesn't check balance | recipe | [b26-postpaid](b26-postpaid.test.ts) |
| B27 | Coupon-like credit | `flatCredit` | module | [b27-coupon-credit](b27-coupon-credit.test.ts) |
| B28 | Hard quota: stop the free plan at 1,000 a month | `limit` from `getRate` → `quota_exceeded`, enforced atomically in `commit` | core | [b28-hard-quota](b28-hard-quota.test.ts) |
| L1 | Lago standard / graduated / volume / package | the three models | core | [l01-lago-charge-models](l01-lago-charge-models.test.ts) |
| L2 | Lago percentage, graduated_percentage | like B22 | core | [l02-lago-percentage](l02-lago-percentage.test.ts) |
| L3 | Lago dynamic | like B23 | recipe | [l03-lago-dynamic](l03-lago-dynamic.test.ts) |
| L4 | Lago custom (code computes the fee) | code builds a `Rate` instead | out of scope | [l04-lago-custom-out-of-scope](l04-lago-custom-out-of-scope.test.ts) |
| L5 | Lago progressive billing | prepaid gate instead | out of scope | [l05-lago-progressive-billing](l05-lago-progressive-billing.test.ts) |
| L6 | Lago count / sum / max / latest / weighted_sum | quantity from app; `integrate` | core / module | [l06-lago-aggregations](l06-lago-aggregations.test.ts) |
| L7 | Lago unique_count | like B24, per dimension | recipe | [l07-lago-unique-count](l07-lago-unique-count.test.ts) |
| L8 | Lago filters, grouped_by, pricing_group_keys | dimensions, `layeredRates` | core | [l08-lago-filters-grouping](l08-lago-filters-grouping.test.ts) |
| L9 | Lago min_amount_cents, pay_in_advance, prorated | `minimumCommit`; `observe` at event time; `per` | module / core | [l09-lago-min-advance-prorated](l09-lago-min-advance-prorated.test.ts) |
| L10 | Lago fixed charge graduated / volume | `integrate` result into any model | core | [l10-lago-fixed-charge-tiers](l10-lago-fixed-charge-tiers.test.ts) |
| L11 | Lago plan / subscription / trial / wallet / coupon / invoice | one touch point each | out of scope | [l11-lago-billing-objects-out-of-scope](l11-lago-billing-objects-out-of-scope.test.ts) |
