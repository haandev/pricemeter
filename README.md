# pricemeter

A dumb, typed pricing engine. It owns one question — **how much** — and nothing else.

You give it the tariff and the usage so far; it computes the amount and returns the plan to write.
*When*, *where* and *who* — counting, storage, calendars, buffers, queues, balances, HTTP, UI — stay in your application.

```ts
import { buildMetering } from "pricemeter";
import { z } from "zod";

export const metering = buildMetering()
  .context(z.object({ accountId: z.string() }))
  .refs(["otp_send"])
  .meter("msg/free_pool")
  .meter("otp/sms", { country: z.string().length(2) }, { feeds: { "msg/free_pool": 1 } })
  .getRate(async (meter, dims, ctx, at) => ({ rate: await myTariff(meter, dims, ctx, at), usedSoFar: await myCounter(ctx, meter) }))
  .commit(async (plan) => myLedger.apply(plan)); // all-or-nothing, idempotent on (refType, refId)

const r = await metering.observe("otp/sms", { country: "TR" }, 2, { type: "otp_send", id: msgId }, { accountId });
// { ok: true, charged: 40000, lines: [...] }  or  { ok: false, reason: "insufficient_credit" | "no_price" | ... }
```

- **Three models:** `graduated`, `volume` (with `on_crossing` adjustments), `package`; per-tier `per`, flat fees, min/max per observation, `per_event_up` or drift-free `cumulative` rounding.
- **Pure core:** `rate()` and `price()` do no I/O. `observe` is a thin wrapper: `getRate` → `price` → `commit`.
- **Holds:** multi-line reservations as value objects, partial captures, extend, release.
- **Typed catalog:** meter ids, dimensions (zod / valibot / arktype via Standard Schema), pools (`feeds`) — checked at compile time; 500 meters type-check in under a second.

| Package | |
| --- | --- |
| [`pricemeter`](packages/core) | core + `/rates`, `/gauge`, `/adjustments`, `/calendar`, `/testing` |
| [`pricemeter-sqlite`](packages/sqlite) | reference `commit` for SQLite (`node:sqlite`, `bun:sqlite`, better-sqlite3) |
| [`pricemeter-cloudflare`](packages/cloudflare) | Durable Object ledger + D1 usage sink |

Docs: https://haandev.github.io/pricemeter/ · Design: [`design/spec.md`](design/spec.md), [`design/decisions.md`](design/decisions.md)

## Development

```bash
bun install
bun run test          # vitest
bun run test:types    # tsc over tests (@ts-expect-error must fire)
bun run test:bench-types  # 500-meter catalog type-check budget
bun run build
```

MIT
