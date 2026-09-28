/**
 * The per-account Durable Object's logic, independent of the `DurableObject` base class so it can be
 * tested without workerd. `do.ts` is the thin wrapper Cloudflare instantiates.
 */
import type { Plan, Result } from "pricemeter";
import { monthKey } from "pricemeter/calendar";
import {
  accountState,
  accountUsed,
  commitReply,
  creditAccount,
  flushOutbox,
  migrateAccount,
  type AccountState,
  type CommitReply,
  type DurableStorageLike,
} from "pricemeter/cloudflare";
import type { UsageRow } from "pricemeter";
import { catalog, type CatalogLine, type CatalogRef, type Context } from "./catalog.js";

/** The RPC surface the Worker calls on an account's DO. */
export interface AccountApi {
  commit(plan: Plan): Promise<CommitReply>;
  used(meter: string, period: string): Promise<number>;
  /** Embedded pricing: re-price lines with this DO's counters and apply atomically. */
  observeEmbedded(lines: CatalogLine[], ref: CatalogRef, ctx: Context): Promise<Result>;
  credit(amountMicroUsd: number): Promise<void>;
  state(): Promise<AccountState>;
  /** Ships pending usage rows to D1; returns how many. */
  flush(): Promise<number>;
}

/** Counters are monthly: every `tierPeriod` in this catalog is "month". */
export const periodOf = (row: { at: number }) => monthKey({ at: row.at });

export class AccountCore implements AccountApi {
  constructor(
    private storage: DurableStorageLike,
    private sink: (rows: readonly UsageRow[]) => Promise<void>,
    private opts: { prepaid: boolean } = { prepaid: true },
  ) {
    migrateAccount(storage.sql);
  }

  async commit(plan: Plan): Promise<CommitReply> {
    return commitReply(this.storage, plan, { prepaid: this.opts.prepaid, periodOf });
  }

  async used(meter: string, period: string): Promise<number> {
    return accountUsed(this.storage.sql, meter, period);
  }

  async observeEmbedded(lines: CatalogLine[], ref: CatalogRef, ctx: Context): Promise<Result> {
    // Nothing awaits between reading counters and writing: the DO's input gate makes this atomic.
    const fresh = lines.map((l) => ({ ...l, usedSoFar: accountUsed(this.storage.sql, l.meter, periodOf({ at: l.at ?? Date.now() })) }));
    const { result, plan } = catalog.price(fresh, ref, ctx);
    if (!result.ok) return result;
    const reply = commitReply(this.storage, plan, { prepaid: this.opts.prepaid, periodOf });
    return reply.ok ? result : { ok: false, reason: "insufficient_credit" };
  }

  async credit(amountMicroUsd: number): Promise<void> {
    creditAccount(this.storage.sql, amountMicroUsd);
  }

  async state(): Promise<AccountState> {
    return accountState(this.storage.sql);
  }

  async flush(): Promise<number> {
    let total = 0;
    for (let n = -1; n !== 0; total += n) n = await flushOutbox(this.storage.sql, this.sink);
    return total;
  }
}
