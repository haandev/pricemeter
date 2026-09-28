import type { Commit, RateAnswer } from "../catalog.js";
import { InsufficientCredit, isInsufficientCredit } from "../errors.js";
import type { MicroUsd } from "../money.js";
import type { LedgerOp, Plan, UsageRow } from "../plan.js";
import type { Rate } from "../rate.js";

type RateSource = Rate | ((dims: any, ctx: any, at: number) => Rate | RateAnswer | null | undefined);

export interface MemoryAdapterOptions {
  /** meter → tariff, or a function of (dims, ctx, at). Meters not listed have no price. */
  rates?: Record<string, RateSource>;
  /** Enforce balances: charges beyond `balance − reserved` throw `InsufficientCredit`. Default false (postpaid). */
  prepaid?: boolean;
  /** Starting balances, account → micro-units. */
  balances?: Record<string, number>;
  /** Tier period of a timestamp; `usedSoFar` is counted per (account, meter, period). Default: one lifetime period "*". */
  periodOf?: (at: number) => string;
}

export interface AccountState {
  /** Credits minus charges and captures. */
  balance: number;
  /** Open hold reservations. */
  reserved: number;
}

export interface MemoryStore {
  readonly usage: UsageRow[];
  readonly ledger: LedgerOp[];
  account(id: string): AccountState;
  available(id: string): number;
  /** Units written for (account, meter) in the period of `at` (or a period key). */
  used(account: string, meter: string, period?: string | number): number;
  credit(account: string, amount: number): void;
  setRate(meter: string, rate: RateSource | undefined): void;
  /** Number of `commit` calls, including no-op retries. */
  commits: number;
}

export interface MemoryAdapters {
  getRate: (meter: string, dims: any, ctx: { accountId: string }, at: number) => Promise<RateAnswer | null>;
  commit: Commit;
  store: MemoryStore;
}

/**
 * In-memory `getRate` and `commit` following the adapter contract: all-or-nothing, idempotent on
 * `(refType, refId)`, `InsufficientCredit` when prepaid and short. For tests, examples and docs.
 */
export function memoryAdapters(opts: MemoryAdapterOptions = {}): MemoryAdapters {
  const rates = new Map<string, RateSource>(Object.entries(opts.rates ?? {}));
  const periodOf = opts.periodOf ?? (() => "*");
  const usage: UsageRow[] = [];
  const ledger: LedgerOp[] = [];
  const accounts = new Map<string, AccountState>();
  const counters = new Map<string, number>();
  const seen = new Set<string>();
  for (const [id, b] of Object.entries(opts.balances ?? {})) accounts.set(id, { balance: b, reserved: 0 });

  const acct = (id: string) => {
    let a = accounts.get(id);
    if (!a) accounts.set(id, (a = { balance: 0, reserved: 0 }));
    return a;
  };
  const counterKey = (account: string, meter: string, period: string) => `${account}\u0000${meter}\u0000${period}`;

  const store: MemoryStore = {
    usage,
    ledger,
    commits: 0,
    account: (id) => ({ ...acct(id) }),
    available: (id) => acct(id).balance - acct(id).reserved,
    used: (account, meter, period) =>
      counters.get(counterKey(account, meter, typeof period === "number" ? periodOf(period) : (period ?? periodOf(Date.now())))) ?? 0,
    credit: (account, amount) => {
      acct(account).balance += amount;
    },
    setRate: (meter, rate) => {
      if (rate === undefined) rates.delete(meter);
      else rates.set(meter, rate);
    },
  };

  const getRate: MemoryAdapters["getRate"] = async (meter, dims, ctx, at) => {
    const src = rates.get(meter);
    if (!src) return null;
    const out = typeof src === "function" ? src(dims, ctx, at) : src;
    if (!out) return null;
    const answer: RateAnswer = "model" in out ? { rate: out } : out;
    if (answer.usedSoFar === undefined) answer.usedSoFar = store.used(ctx.accountId, meter, periodOf(at));
    return answer;
  };

  const commit: Commit = async (plan: Plan) => {
    store.commits++;
    // stage on copies, apply only if everything passes
    const staged = new Map<string, AccountState>();
    const stagedAcct = (id: string) => {
      let a = staged.get(id);
      if (!a) staged.set(id, (a = { ...acct(id) }));
      return a;
    };
    const debits = new Map<string, number>();
    const keys: string[] = [];
    const newLedger: LedgerOp[] = [];
    for (const op of plan.ledger) {
      const k = `L\u0000${op.op}\u0000${op.refType}\u0000${op.refId}`;
      if (seen.has(k) || keys.includes(k)) continue;
      keys.push(k);
      newLedger.push(op);
      const a = stagedAcct(op.account);
      switch (op.op) {
        case "charge":
          a.balance -= op.amount;
          debits.set(op.account, (debits.get(op.account) ?? 0) + op.amount);
          break;
        case "hold":
        case "extend":
          a.reserved += op.amount;
          debits.set(op.account, (debits.get(op.account) ?? 0) + op.amount);
          break;
        case "capture":
          a.balance -= op.amount;
          a.reserved -= op.amount;
          break;
        case "release":
          a.reserved -= op.amount;
          break;
      }
    }
    if (opts.prepaid) {
      for (const [id, d] of debits) {
        const a = staged.get(id)!;
        if (d > 0 && a.balance - a.reserved < 0) {
          throw new InsufficientCredit(`account ${id} cannot cover ${d}`, { account: id, available: store.available(id), required: d });
        }
      }
    }
    const newUsage: UsageRow[] = [];
    for (const row of plan.usage) {
      const k = `U\u0000${row.refType}\u0000${row.refId}`;
      if (seen.has(k) || keys.includes(k)) continue;
      keys.push(k);
      newUsage.push(row);
    }
    // apply
    for (const k of keys) seen.add(k);
    for (const [id, a] of staged) accounts.set(id, a);
    ledger.push(...newLedger);
    usage.push(...newUsage);
    for (const row of newUsage) {
      const k = counterKey(row.account, row.meter, periodOf(row.at));
      counters.set(k, (counters.get(k) ?? 0) + row.quantity);
    }
  };

  return { getRate, commit, store };
}

// ---------------------------------------------------------------------------

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export interface ExpectedPlan {
  ledger?: DeepPartial<LedgerOp>[];
  usage?: DeepPartial<UsageRow>[];
}

function partialMismatch(actual: unknown, expected: unknown, path: string): string | null {
  if (expected === undefined) return null;
  if (typeof expected !== "object" || expected === null) {
    return Object.is(actual, expected) ? null : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }
  if (typeof actual !== "object" || actual === null) return `${path}: expected an object, got ${JSON.stringify(actual)}`;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length)
      return `${path}: expected ${expected.length} items, got ${Array.isArray(actual) ? actual.length : "none"}`;
  }
  for (const [k, v] of Object.entries(expected)) {
    const m = partialMismatch((actual as Record<string, unknown>)[k], v, `${path}.${k}`);
    if (m) return m;
  }
  return null;
}

/**
 * Asserts a plan, framework-free. Rows are compared in order and partially: only the fields you give are checked,
 * but the number of rows must match. Throws with the first difference.
 */
export function expectPlan(plan: Plan, expected: ExpectedPlan): void {
  for (const part of ["ledger", "usage"] as const) {
    const exp = expected[part];
    if (!exp) continue;
    const act = plan[part];
    if (act.length !== exp.length) {
      throw new Error(`plan.${part}: expected ${exp.length} rows, got ${act.length}\n${JSON.stringify(act, null, 2)}`);
    }
    exp.forEach((e, i) => {
      const m = partialMismatch(act[i], e, `plan.${part}[${i}]`);
      if (m) throw new Error(`${m}\n${JSON.stringify(act[i], null, 2)}`);
    });
  }
}

// ---------------------------------------------------------------------------

export interface ContractSubject {
  commit: Commit;
  /** Give `account` `amount` spendable micro-units. */
  seed(account: string, amount: number): Promise<void> | void;
  /** Counts of written rows and the spendable amount for `account`. */
  snapshot(account: string): Promise<{ usage: number; ledger: number; available: number }> | { usage: number; ledger: number; available: number };
}

export interface ContractOptions {
  /** Creates a fresh, empty adapter per check. */
  make: () => Promise<ContractSubject> | ContractSubject;
  /** Whether the adapter enforces balances. Default true. */
  prepaid?: boolean;
}

export interface ContractCheck {
  name: string;
  ok: boolean;
  error?: string;
}

const m = (n: number) => n as MicroUsd;

function samplePlan(account: string, refId: string, amount: number): Plan {
  return {
    ledger: [{ op: "charge", account, amount: m(amount), refType: "contract", refId, at: 0 }],
    usage: [
      { account, meter: "contract/meter", dims: { k: "v" }, quantity: 3, amount: m(amount), detail: { breakdown: [] }, refType: "contract", refId, at: 0 },
    ],
  };
}

/** Runs the adapter contract every `commit` must satisfy. Returns one entry per check. */
export async function commitContract(opts: ContractOptions): Promise<{ ok: boolean; checks: ContractCheck[] }> {
  const prepaid = opts.prepaid ?? true;
  const checks: ContractCheck[] = [];
  const check = async (name: string, fn: (s: ContractSubject) => Promise<void>) => {
    try {
      await fn(await opts.make());
      checks.push({ name, ok: true });
    } catch (e) {
      checks.push({ name, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  await check("writes ledger and usage rows", async (s) => {
    await s.seed("a", 1000);
    await s.commit(samplePlan("a", "r1", 100));
    const snap = await s.snapshot("a");
    assert(snap.usage === 1 && snap.ledger === 1, `expected 1 usage and 1 ledger row, got ${snap.usage}/${snap.ledger}`);
    assert(snap.available === 900, `expected available 900, got ${snap.available}`);
  });

  await check("repeated (refType, refId) is a silent no-op", async (s) => {
    await s.seed("a", 1000);
    await s.commit(samplePlan("a", "r1", 100));
    await s.commit(samplePlan("a", "r1", 100));
    const snap = await s.snapshot("a");
    assert(snap.usage === 1 && snap.ledger === 1, `expected rows once, got ${snap.usage}/${snap.ledger}`);
    assert(snap.available === 900, `expected available 900 after retry, got ${snap.available}`);
  });

  await check("negative charges credit the account", async (s) => {
    await s.seed("a", 1000);
    await s.commit(samplePlan("a", "r1", 100));
    await s.commit({
      ledger: [{ op: "charge", account: "a", amount: m(-40), refType: "contract", refId: "r1:adj", at: 0 }],
      usage: [],
    });
    const snap = await s.snapshot("a");
    assert(snap.available === 940, `expected available 940, got ${snap.available}`);
  });

  await check("hold reserves, capture charges, release frees", async (s) => {
    await s.seed("a", 1000);
    const base = { account: "a", refType: "contract", holdId: "contract:h", at: 0 } as const;
    await s.commit({ ledger: [{ ...base, op: "hold", amount: m(300), refId: "contract:h:hold" }], usage: [] });
    let snap = await s.snapshot("a");
    assert(snap.available === 700, `after hold expected 700, got ${snap.available}`);
    await s.commit({ ledger: [{ ...base, op: "capture", amount: m(120), refId: "contract:h:x:capture:1" }], usage: [] });
    snap = await s.snapshot("a");
    assert(snap.available === 700, `capture must not change available, got ${snap.available}`);
    await s.commit({ ledger: [{ ...base, op: "release", amount: m(180), refId: "contract:h:release" }], usage: [] });
    snap = await s.snapshot("a");
    assert(snap.available === 880, `after release expected 880, got ${snap.available}`);
  });

  if (prepaid) {
    await check("insufficient credit throws InsufficientCredit and writes nothing", async (s) => {
      await s.seed("a", 50);
      let thrown: unknown;
      try {
        await s.commit(samplePlan("a", "r1", 100));
      } catch (e) {
        thrown = e;
      }
      assert(isInsufficientCredit(thrown), `expected InsufficientCredit, got ${String(thrown)}`);
      const snap = await s.snapshot("a");
      assert(snap.usage === 0 && snap.ledger === 0, `expected no rows, got ${snap.usage}/${snap.ledger}`);
      assert(snap.available === 50, `expected available unchanged at 50, got ${snap.available}`);
    });

    await check("a hold larger than available is refused", async (s) => {
      await s.seed("a", 50);
      let thrown: unknown;
      try {
        await s.commit({
          ledger: [{ op: "hold", account: "a", amount: m(100), refType: "contract", refId: "contract:h:hold", holdId: "contract:h", at: 0 }],
          usage: [],
        });
      } catch (e) {
        thrown = e;
      }
      assert(isInsufficientCredit(thrown), `expected InsufficientCredit, got ${String(thrown)}`);
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
