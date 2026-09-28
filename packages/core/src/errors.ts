/**
 * Thrown by `commit` when the account cannot cover the plan. The library turns it into
 * `{ ok: false, reason: "insufficient_credit" }`. Matched by `name` too, so it survives realms and RPC.
 */
export class InsufficientCredit extends Error {
  override name = "InsufficientCredit";
  constructor(
    message = "insufficient credit",
    readonly details?: { account?: string; available?: number; required?: number },
  ) {
    super(message);
  }
}

export function isInsufficientCredit(e: unknown): boolean {
  return e instanceof InsufficientCredit || (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "InsufficientCredit");
}
