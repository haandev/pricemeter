import { DatabaseSync } from "node:sqlite";
import type { DurableStorageLike, SqlCursor } from "pricemeter-cloudflare";

/** Durable Object SQLite storage over node:sqlite, for tests. */
export function fakeStorage(): DurableStorageLike & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  return {
    db,
    sql: {
      exec(query: string, ...bindings: unknown[]): SqlCursor {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
            return rows[0]!;
          },
        };
      },
    },
    transactionSync<T>(fn: () => T): T {
      const sp = `sp${depth++}`;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        const out = fn();
        db.exec(`RELEASE ${sp}`);
        return out;
      } catch (e) {
        db.exec(`ROLLBACK TO ${sp}`);
        db.exec(`RELEASE ${sp}`);
        throw e;
      } finally {
        depth--;
      }
    },
  };
}

/** A D1 stand-in over node:sqlite. */
export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    prepare: (q: string) => ({ bind: (...v: unknown[]) => ({ q, v }) }),
    batch: async (stmts: { q: string; v: unknown[] }[]) => {
      db.exec("BEGIN");
      try {
        for (const s of stmts) db.prepare(s.q).run(...(s.v as never[]));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
