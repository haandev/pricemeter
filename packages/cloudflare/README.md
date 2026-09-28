# pricemeter-cloudflare

Reference [pricemeter](https://www.npmjs.com/package/pricemeter) adapter for Cloudflare: one Durable Object per account holds the ledger, balance and `usedSoFar` counters in its SQLite storage; usage rows are shipped to D1 through an outbox.

```ts
// Durable Object
import { DurableObject } from "cloudflare:workers";
import { accountUsed, commitReply, d1UsageSink, flushOutbox, migrateAccount } from "pricemeter-cloudflare";

export class Account extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateAccount(ctx.storage.sql);
  }
  commit(plan: Plan) {
    const reply = commitReply(this.ctx.storage, plan, { prepaid: true, periodOf: (row) => monthKey({ at: row.at }) });
    this.ctx.waitUntil(flushOutbox(this.ctx.storage.sql, d1UsageSink(this.env.DB)));
    return reply;
  }
  used(meter: string, period: string) {
    return accountUsed(this.ctx.storage.sql, meter, period);
  }
}

// Worker
metering.bind({ getRate, commit: doCommit((id) => env.ACCOUNT.get(env.ACCOUNT.idFromName(id))) });
```

`applyPlan` runs in `transactionSync`: balance gate, idempotent ledger, counters and outbox are one atomic step. For embedded pricing, send `metering.plan.observe(...).lines` to the DO and re-price them there with `metering.price()` and fresh counters.
Full example: `examples/messaging` in the repository. Docs: https://haandev.github.io/pricemeter/
