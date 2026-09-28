import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createBilling, type Context } from "../src/billing.js";
import { SeatRegistry } from "../src/seats.js";

const d = (s: string) => Date.parse(s);

describe("seat limit (app side)", () => {
  it("10 purchased: +6, +3, then +4 is refused; +1 fits; removing frees a seat", () => {
    const seats = new SeatRegistry(() => 10);
    expect(seats.add("acme", 6, 1)).toEqual({ ok: true, seats: 6 });
    expect(seats.add("acme", 3, 2)).toEqual({ ok: true, seats: 9 });
    expect(seats.add("acme", 4, 3)).toEqual({ ok: false, reason: "seat_limit", purchased: 10, current: 9, remaining: 1 });
    expect(seats.add("acme", 1, 4)).toEqual({ ok: true, seats: 10 });
    expect(seats.add("acme", 1, 5)).toMatchObject({ ok: false, remaining: 0 });
    seats.remove("acme", 1, 6);
    expect(seats.add("acme", 1, 7)).toEqual({ ok: true, seats: 10 });
  });

  it("the samples it keeps are what billing integrates at cycle close", async () => {
    const seats = new SeatRegistry(() => 10);
    seats.add("acme", 6, d("2026-09-15T00:00:00Z"));
    seats.add("acme", 3, d("2026-09-30T00:00:00Z")); // halfway through the 30-day cycle
    expect(seats.add("acme", 4, d("2026-10-01T00:00:00Z")).ok).toBe(false); // refused: never billed
    const ctx: Context = { accountId: "acme", plan: "team", currency: "USD", cycleAnchor: d("2026-08-15T00:00:00Z") };
    const b = createBilling(new DatabaseSync(":memory:"));
    const r = await b.closeCycle({ ctx, at: d("2026-09-20T00:00:00Z"), seats: seats.samples.get("acme")!, storageGb: [] });
    expect(r.usage).toMatchObject({ ok: true, charged: 6 * 10_000_000 + 3 * 5_000_000 }); // 6 full + 3 half seats at $10
  });
});
