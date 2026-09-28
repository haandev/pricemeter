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

export interface QuotaDetails {
  meter: string;
  limit: number;
  /** Units already counted in the period when the check ran. */
  used: number;
  requested: number;
  account?: string;
}

/**
 * Thrown by `commit` when a usage row that carries a `limit` would push its counter past it.
 * The library turns it into `{ ok: false, reason: "quota_exceeded" }`. Matched by `name` too.
 */
export class QuotaExceeded extends Error {
  override name = "QuotaExceeded";
  constructor(readonly details: QuotaDetails) {
    super(`quota exceeded for ${details.meter}: ${details.used} used + ${details.requested} requested > ${details.limit}`);
  }
}

export function isQuotaExceeded(e: unknown): e is { name: "QuotaExceeded"; details?: QuotaDetails } {
  return e instanceof QuotaExceeded || (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "QuotaExceeded");
}
