/**
 * Cloudflare reference adapter.
 *
 * - One Durable Object per account holds the ledger, the balance and the `usedSoFar` counters in its SQLite
 *   storage. `applyPlan` runs inside `transactionSync`: balance check + ledger + counters are one atomic step.
 * - Usage rows go to an outbox in the same transaction and are drained to D1 later (`waitUntil`, alarm),
 *   idempotently (`d1UsageSink`).
 * - The Worker binds `doCommit(...)` as the metering `commit`. For embedded pricing, the Worker sends
 *   `plan.observe(...).lines` and the DO re-prices them with fresh counters via `metering.price()`.
 */
import { InsufficientCredit, type Commit, type Plan, type UsageRow } from "pricemeter";

// Minimal structural types for Durable Object SQLite storage and D1 (no dependency on workers-types).
export interface SqlCursor {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}
/** Non-generic on purpose: Cloudflare's generic `exec<T>` is assignable to it, a generic one would not be. */
export interface SqlStorage {
  exec(query: string, ...bindings: any[]): SqlCursor;
}
export interface DurableStorageLike {
  sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
}
export interface D1Like {
  prepare(query: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<unknown>;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS pm_ledger (type TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, amount INTEGER NOT NULL, hold_id TEXT, at INTEGER NOT NULL, PRIMARY KEY (type, ref_type, ref_id))`,
  `CREATE TABLE IF NOT EXISTS pm_usage_seen (ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, PRIMARY KEY (ref_type, ref_id))`,
  `CREATE TABLE IF NOT EXISTS pm_counters (meter TEXT NOT NULL, period TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (meter, period))`,
  `CREATE TABLE IF NOT EXISTS pm_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, row TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pm_account (id INTEGER PRIMARY KEY CHECK (id = 1), balance INTEGER NOT NULL, reserved INTEGER NOT NULL)`,
  `INSERT INTO pm_account (id, balance, reserved) VALUES (1, 0, 0) ON CONFLICT DO NOTHING`,
];

/** Creates the account tables. Call once from the DO constructor (inside `blockConcurrencyWhile`). */
export function migrateAccount(sql: SqlStorage): void {
  for (const q of DDL) sql.exec(q);
}

export interface ApplyOptions {
  /** Enforce `balance − reserved ≥ 0`. Default false. */
  prepaid?: boolean;
  /** Counter period for a usage row; `usedSoFar` is read per (meter, period). Default: one lifetime period `"*"`. */
  periodOf?: (row: UsageRow) => string;
}

export interface AccountState {
  balance: number;
  reserved: number;
  available: number;
}

export function accountState(sql: SqlStorage): AccountState {
  const r = sql.exec(`SELECT balance, reserved FROM pm_account WHERE id = 1`).one() as { balance: number; reserved: number };
  const balance = Number(r.balance);
  const reserved = Number(r.reserved);
  return { balance, reserved, available: balance - reserved };
}

/** Units counted for `meter` in `period` in this account. The `usedSoFar` source. */
export function accountUsed(sql: SqlStorage, meter: string, period = "*"): number {
  const rows = sql.exec(`SELECT used FROM pm_counters WHERE meter = ? AND period = ?`, meter, period).toArray() as { used: number }[];
  return Number(rows[0]?.used ?? 0);
}

/** Tops the account up. */
export function creditAccount(sql: SqlStorage, amount: number): void {
  if (!Number.isSafeInteger(amount)) throw new RangeError("amount must be an integer");
  sql.exec(`UPDATE pm_account SET balance = balance + ? WHERE id = 1`, amount);
}

/**
 * Applies a plan atomically inside the account's DO. Repeated `(refType, refId)` rows are skipped.
 * Throws `InsufficientCredit` (nothing written) when prepaid and short.
 */
export function applyPlan(storage: DurableStorageLike, plan: Plan, opts: ApplyOptions = {}): void {
  const { sql } = storage;
  const periodOf = opts.periodOf ?? (() => "*");
  storage.transactionSync(() => {
    let balance = 0;
    let reserved = 0;
    let debit = 0;
    for (const op of plan.ledger) {
      const seen = sql.exec(`SELECT 1 AS x FROM pm_ledger WHERE type = ? AND ref_type = ? AND ref_id = ?`, op.op, op.refType, op.refId).toArray();
      if (seen.length) continue;
      sql.exec(
        `INSERT INTO pm_ledger (type, ref_type, ref_id, amount, hold_id, at) VALUES (?, ?, ?, ?, ?, ?)`,
        op.op,
        op.refType,
        op.refId,
        op.amount,
        op.op === "charge" ? null : op.holdId,
        op.at,
      );
      switch (op.op) {
        case "charge":
          balance -= op.amount;
          debit += op.amount;
          break;
        case "hold":
        case "extend":
          reserved += op.amount;
          debit += op.amount;
          break;
        case "capture":
          balance -= op.amount;
          reserved -= op.amount;
          break;
        case "release":
          reserved -= op.amount;
          break;
      }
    }
    if (balance || reserved) sql.exec(`UPDATE pm_account SET balance = balance + ?, reserved = reserved + ? WHERE id = 1`, balance, reserved);
    if (opts.prepaid && debit > 0) {
      const s = accountState(sql);
      // throwing inside transactionSync rolls everything back
      if (s.available < 0) throw new InsufficientCredit(`short by ${-s.available}`, { available: s.available + debit, required: debit });
    }
    for (const row of plan.usage) {
      const seen = sql.exec(`SELECT 1 AS x FROM pm_usage_seen WHERE ref_type = ? AND ref_id = ?`, row.refType, row.refId).toArray();
      if (seen.length) continue;
      sql.exec(`INSERT INTO pm_usage_seen (ref_type, ref_id) VALUES (?, ?)`, row.refType, row.refId);
      if (row.quantity) {
        sql.exec(
          `INSERT INTO pm_counters (meter, period, used) VALUES (?, ?, ?) ON CONFLICT (meter, period) DO UPDATE SET used = used + excluded.used`,
          row.meter,
          periodOf(row),
          row.quantity,
        );
      }
      sql.exec(`INSERT INTO pm_outbox (row) VALUES (?)`, JSON.stringify(row));
    }
  });
}

/** Result of the DO's commit RPC. Errors don't survive RPC reliably, so insufficiency is a value. */
export type CommitReply = { ok: true } | { ok: false; reason: "insufficient_credit"; message: string };

/** Wraps `applyPlan` for an RPC method: returns a `CommitReply` instead of throwing `InsufficientCredit`. */
export function commitReply(storage: DurableStorageLike, plan: Plan, opts?: ApplyOptions): CommitReply {
  try {
    applyPlan(storage, plan, opts);
    return { ok: true };
  } catch (e) {
    if (e instanceof InsufficientCredit || (e as Error)?.name === "InsufficientCredit")
      return { ok: false, reason: "insufficient_credit", message: (e as Error).message };
    throw e;
  }
}

/**
 * The Worker-side `commit`: routes the plan to its account's DO. `stub(accountId)` returns something
 * with `commit(plan): Promise<CommitReply>` (e.g. `env.ACCOUNT.get(env.ACCOUNT.idFromName(id))`).
 */
export function doCommit(stub: (accountId: string) => { commit(plan: Plan): Promise<CommitReply> }): Commit {
  return async (plan) => {
    const accounts = new Set([...plan.ledger.map((o) => o.account), ...plan.usage.map((u) => u.account)]);
    if (accounts.size > 1) throw new Error("doCommit: a plan must belong to one account");
    const [account] = accounts;
    if (account === undefined) return;
    const reply = await stub(account).commit(plan);
    if (!reply.ok) throw new InsufficientCredit(reply.message);
  };
}

/** Oldest outbox rows, for shipping to D1. Pass the returned `upTo` to `ackOutbox` once written. */
export function readOutbox(sql: SqlStorage, limit = 100): { rows: UsageRow[]; upTo: number } {
  const rs = sql.exec(`SELECT seq, row FROM pm_outbox ORDER BY seq LIMIT ?`, limit).toArray() as { seq: number; row: string }[];
  return { rows: rs.map((r) => JSON.parse(r.row) as UsageRow), upTo: rs.length ? Number(rs[rs.length - 1]!.seq) : 0 };
}

export function ackOutbox(sql: SqlStorage, upTo: number): void {
  sql.exec(`DELETE FROM pm_outbox WHERE seq <= ?`, upTo);
}

/** D1 DDL for the usage table (same shape as the SQLite reference schema). */
export const D1_USAGE_SCHEMA = `CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, meter TEXT NOT NULL, dims TEXT NOT NULL, quantity INTEGER NOT NULL, amount_micro_usd INTEGER NOT NULL, rate_id TEXT, detail TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (ref_type, ref_id))`;

/** Writes usage rows to D1 in one batch; duplicates are ignored, so retries are safe. */
export function d1UsageSink(db: D1Like): (rows: readonly UsageRow[]) => Promise<void> {
  return async (rows) => {
    if (!rows.length) return;
    const stmt = db.prepare(
      `INSERT INTO usage_events (id, account_id, meter, dims, quantity, amount_micro_usd, rate_id, detail, ref_type, ref_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    await db.batch(
      rows.map((u) =>
        stmt.bind(`${u.refType}:${u.refId}`, u.account, u.meter, JSON.stringify(u.dims), u.quantity, u.amount, u.rateId ?? null, JSON.stringify(u.detail), u.refType, u.refId, u.at),
      ),
    );
  };
}

/** Moves one outbox batch to D1. Call from `alarm()` or `ctx.waitUntil`. Returns the number of rows shipped. */
export async function flushOutbox(sql: SqlStorage, sink: (rows: readonly UsageRow[]) => Promise<void>, limit = 100): Promise<number> {
  const { rows, upTo } = readOutbox(sql, limit);
  if (!rows.length) return 0;
  await sink(rows);
  ackOutbox(sql, upTo);
  return rows.length;
}
