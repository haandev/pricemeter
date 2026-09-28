/**
 * Seat limits live in the application, not in pricemeter: a seat is a level that goes up and down
 * (remove one, add another), not an event counter. The check sits in the same transaction that adds
 * the seats; pricemeter only prices seat-time at cycle close (billing.ts).
 *
 * Compare `limit` from getRate (recipe B28): that is for event meters (OTPs, API calls) whose counters
 * only grow — there the check has to be atomic with the write, so it lives in `commit`.
 */
import type { Sample } from "pricemeter/gauge";

export type AddSeats = { ok: true; seats: number } | { ok: false; reason: "seat_limit"; purchased: number; current: number; remaining: number };

export class SeatRegistry {
  #seats = new Map<string, number>();
  /** Level changes, kept for `integrate()` at cycle close. */
  readonly samples = new Map<string, Sample[]>();

  constructor(private purchased: (accountId: string) => number) {}

  current(accountId: string): number {
    return this.#seats.get(accountId) ?? 0;
  }

  /** All or nothing: 9 of 10 used and 4 requested → refused, `remaining: 1` tells the UI what fits. */
  add(accountId: string, count: number, at: number): AddSeats {
    // in production: one DB transaction (SELECT … FOR UPDATE, or a Durable Object per account)
    const current = this.current(accountId);
    const purchased = this.purchased(accountId);
    if (current + count > purchased) return { ok: false, reason: "seat_limit", purchased, current, remaining: purchased - current };
    return this.#set(accountId, current + count, at);
  }

  remove(accountId: string, count: number, at: number): AddSeats {
    return this.#set(accountId, Math.max(0, this.current(accountId) - count), at);
  }

  #set(accountId: string, seats: number, at: number): AddSeats {
    this.#seats.set(accountId, seats);
    const s = this.samples.get(accountId) ?? [];
    s.push({ at, value: seats });
    this.samples.set(accountId, s);
    return { ok: true, seats };
  }
}
