import { InsufficientCredit, type Commit, type Plan } from "pricemeter";

/** The subset of a synchronous SQLite driver we use. `node:sqlite`, `bun:sqlite` and better-sqlite3 all fit. */
export interface SqliteLike {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
}
export interface SqliteStatement {
  run(...params: any[]): { changes: number | bigint };
  get(...params: any[]): unknown;
  all(...params: any[]): unknown[];
}

export interface SqliteAdapterOptions {
  db: SqliteLike;
  /** Enforce `balance − reserved ≥ 0` inside the commit transaction. Default false (postpaid). */
  prepaid?: boolean;
  /** Prefix for table names. Default `""`. */
  prefix?: string;
}

export interface AccountBalance {
  balance: number;
  reserved: number;
  available: number;
}

export interface SqliteAdapter {
  /** Creates tables and indexes if missing. */
  migrate(): void;
  /** All-or-nothing (`ON CONFLICT DO NOTHING` only skips duplicates; bad rows still fail), idempotent on `(refType, refId)`, throws `InsufficientCredit` when prepaid and short. */
  commit: Commit;
  /** Units written for (account, meter) in `[from, to)`; optionally for exact dims. The `usedSoFar` source. */
  usedSoFar(i: { account: string; meter: string; from?: number; to?: number; dims?: Record<string, unknown> }): number;
  /** Money written in `[from, to)` (charges + captures), e.g. for `minimumCommit`. */
  spent(i: { account: string; from?: number; to?: number }): number;
  balance(account: string): AccountBalance;
  /** Tops up an account (outside the ledger's metering rows). */
  credit(account: string, amountMicroUsd: number): void;
}

/** Canonical JSON: sorted keys, so equal dims compare equal in SQL. */
export function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function schema(prefix = ""): string {
  return `
CREATE TABLE IF NOT EXISTS ${prefix}usage_events (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, meter TEXT NOT NULL, dims TEXT NOT NULL, quantity INTEGER NOT NULL,
  amount_micro_usd INTEGER NOT NULL, rate_id TEXT, detail TEXT NOT NULL, ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
  at INTEGER NOT NULL, UNIQUE (ref_type, ref_id));
CREATE INDEX IF NOT EXISTS ${prefix}usage_events_account_meter_at ON ${prefix}usage_events (account_id, meter, at);
CREATE TABLE IF NOT EXISTS ${prefix}ledger_entries (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, type TEXT NOT NULL, amount_micro_usd INTEGER NOT NULL, hold_id TEXT,
  ref_type TEXT NOT NULL, ref_id TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (type, ref_type, ref_id));
CREATE INDEX IF NOT EXISTS ${prefix}ledger_entries_account_at ON ${prefix}ledger_entries (account_id, at);
CREATE TABLE IF NOT EXISTS ${prefix}accounts (
  id TEXT PRIMARY KEY, balance_micro_usd INTEGER NOT NULL DEFAULT 0, reserved_micro_usd INTEGER NOT NULL DEFAULT 0);
`;
}

/** Reference `commit` (and counters) over SQLite. One transaction per plan. */
export function sqliteAdapter(o: SqliteAdapterOptions): SqliteAdapter {
  const { db } = o;
  const p = o.prefix ?? "";
  let st: ReturnType<typeof prepareAll> | undefined;
  const prepareAll = () => ({
    ledger: db.prepare(
      `INSERT INTO ${p}ledger_entries (id, account_id, type, amount_micro_usd, hold_id, ref_type, ref_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ),
    usage: db.prepare(
      `INSERT INTO ${p}usage_events (id, account_id, meter, dims, quantity, amount_micro_usd, rate_id, detail, ref_type, ref_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ),
    ensure: db.prepare(`INSERT INTO ${p}accounts (id) VALUES (?) ON CONFLICT DO NOTHING`),
    move: db.prepare(`UPDATE ${p}accounts SET balance_micro_usd = balance_micro_usd + ?, reserved_micro_usd = reserved_micro_usd + ? WHERE id = ?`),
    get: db.prepare(`SELECT balance_micro_usd AS balance, reserved_micro_usd AS reserved FROM ${p}accounts WHERE id = ?`),
  });
  const s = () => (st ??= prepareAll());

  const balance = (account: string): AccountBalance => {
    const row = s().get.get(account) as { balance: number | bigint; reserved: number | bigint } | undefined;
    const b = Number(row?.balance ?? 0);
    const r = Number(row?.reserved ?? 0);
    return { balance: b, reserved: r, available: b - r };
  };

  const commit: Commit = (plan: Plan) => {
    const q = s();
    db.exec("BEGIN IMMEDIATE");
    try {
      const moves = new Map<string, { balance: number; reserved: number; debit: number }>();
      const move = (a: string) => {
        let m = moves.get(a);
        if (!m) moves.set(a, (m = { balance: 0, reserved: 0, debit: 0 }));
        return m;
      };
      for (const op of plan.ledger) {
        const holdId = op.op === "charge" ? null : op.holdId;
        const r = q.ledger.run(`${op.op}:${op.refType}:${op.refId}`, op.account, op.op, op.amount, holdId, op.refType, op.refId, op.at);
        if (Number(r.changes) === 0) continue; // retry: already written
        const m = move(op.account);
        switch (op.op) {
          case "charge":
            m.balance -= op.amount;
            m.debit += op.amount;
            break;
          case "hold":
          case "extend":
            m.reserved += op.amount;
            m.debit += op.amount;
            break;
          case "capture":
            m.balance -= op.amount;
            m.reserved -= op.amount;
            break;
          case "release":
            m.reserved -= op.amount;
            break;
        }
      }
      for (const [account, m] of moves) {
        q.ensure.run(account);
        q.move.run(m.balance, m.reserved, account);
        if (o.prepaid && m.debit > 0) {
          const b = balance(account);
          if (b.available < 0) throw new InsufficientCredit(`account ${account} is short by ${-b.available}`, { account, available: b.available + m.debit, required: m.debit });
        }
      }
      for (const u of plan.usage) {
        q.usage.run(
          `${u.refType}:${u.refId}`,
          u.account,
          u.meter,
          canonicalJson(u.dims),
          u.quantity,
          u.amount,
          u.rateId ?? null,
          JSON.stringify(u.detail),
          u.refType,
          u.refId,
          u.at,
        );
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  return {
    migrate: () => void db.exec(schema(p)),
    commit,
    usedSoFar: (i) => {
      const dims = i.dims === undefined ? null : canonicalJson(i.dims);
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(quantity), 0) AS n FROM ${p}usage_events WHERE account_id = ? AND meter = ? AND at >= ? AND at < ? AND (? IS NULL OR dims = ?)`,
        )
        .get(i.account, i.meter, i.from ?? Number.MIN_SAFE_INTEGER, i.to ?? Number.MAX_SAFE_INTEGER, dims, dims) as { n: number | bigint };
      return Number(row.n);
    },
    spent: (i) => {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(amount_micro_usd), 0) AS n FROM ${p}ledger_entries WHERE account_id = ? AND type IN ('charge', 'capture') AND at >= ? AND at < ?`,
        )
        .get(i.account, i.from ?? Number.MIN_SAFE_INTEGER, i.to ?? Number.MAX_SAFE_INTEGER) as { n: number | bigint };
      return Number(row.n);
    },
    balance,
    credit: (account, amount) => {
      if (!Number.isSafeInteger(amount)) throw new RangeError("amount must be an integer");
      s().ensure.run(account);
      s().move.run(amount, 0, account);
    },
  };
}
