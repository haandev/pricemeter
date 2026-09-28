# pricemeter

A dumb, typed pricing engine. It owns one question — **how much** — and nothing else.
You give it the tariff and the usage so far; it computes the amount and returns the plan to write.

```bash
npm i pricemeter
```

```ts
import { buildMetering } from "pricemeter";
import { memoryAdapters } from "pricemeter/testing";
import { z } from "zod";

const { getRate, commit } = memoryAdapters({
  rates: { "otp/sms": { model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 20_000 }, { from: 10_000, unitPriceMicroUsd: 15_000 }] } },
});

const metering = buildMetering()
  .context(z.object({ accountId: z.string() }))
  .refs(["otp_send"])
  .meter("otp/sms", { country: z.string().length(2) })
  .getRate(getRate) // yours: (meter, dims, ctx, at) => { rate, usedSoFar } | null
  .commit(commit); //  yours: all-or-nothing, idempotent on (refType, refId)

await metering.observe("otp/sms", { country: "TR" }, 2, { type: "otp_send", id: "msg_1" }, { accountId: "acme" });
// → { ok: true, charged: 40000, lines: [...] }
```

- `rate()` / `price()` — pure: three models (`graduated`, `volume`, `package`), `per`, flat fees, clamps, `per_event_up` or drift-free `cumulative` rounding, volume adjustments.
- `observe` / `hold` / `extend` / `capture` / `release` — `getRate` → `price` → `commit`; holds are value objects.
- Modules: `pricemeter/rates` (layered price table), `/gauge` (seats, GB), `/adjustments` (minimum commit, credits, true-up), `/calendar` (periods, billing cycles), `/testing` (memory adapters, `commitContract`).
- Zero dependencies. ESM + CJS. Node ≥ 20, Bun, Cloudflare Workers. Dimensions and context via any Standard Schema library (zod, valibot, arktype) or plain types.

Reference adapters: [`pricemeter-sqlite`](https://www.npmjs.com/package/pricemeter-sqlite), [`pricemeter-cloudflare`](https://www.npmjs.com/package/pricemeter-cloudflare).
Docs: https://haandev.github.io/pricemeter/
