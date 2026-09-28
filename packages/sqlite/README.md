# pricemeter-sqlite

Reference [pricemeter](https://www.npmjs.com/package/pricemeter) adapter for SQLite: one transaction per plan, idempotent on `(refType, refId)`, optional prepaid balance gate, and the counters `getRate` needs for `usedSoFar`.

Works with any synchronous driver exposing `exec` and `prepare(...).run/get/all`: `node:sqlite`, `bun:sqlite`, better-sqlite3.

```ts
import { DatabaseSync } from "node:sqlite";
import { sqliteAdapter } from "pricemeter-sqlite";

const store = sqliteAdapter({ db: new DatabaseSync("billing.db"), prepaid: true });
store.migrate();
store.credit("acme", 10_000_000);

const metering = buildMetering()
  /* … meters … */
  .getRate(async (meter, dims, ctx, at) => ({ rate: myTariff(meter, dims), usedSoFar: store.usedSoFar({ account: ctx.accountId, meter, ...monthWindow({ at }) }) }))
  .commit(store.commit);
```

`store.balance(account)`, `store.spent({ account, from, to })` (for `minimumCommit`), `store.usedSoFar({ account, meter, from, to, dims })`.
Docs: https://haandev.github.io/pricemeter/
