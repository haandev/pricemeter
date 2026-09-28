declare const microUsdBrand: unique symbol;

/**
 * An integer amount in micro-units (1 USD = 1_000_000). The name is historical:
 * a `Rate` carries no currency, so the same type holds micro-EUR for an EUR tariff.
 * 2^53 micro-units ≈ 9 billion major units.
 */
export type MicroUsd = number & { readonly [microUsdBrand]: true };

/** Brands an integer as `MicroUsd`. Throws on non-integers or unsafe integers. */
export function microUsd(n: number): MicroUsd {
  if (!Number.isSafeInteger(n)) throw new RangeError(`MicroUsd must be a safe integer, got ${n}`);
  return n as MicroUsd;
}

/** Converts major units to `MicroUsd`, rounding to the nearest micro-unit: `usd(0.05)` → 50_000. */
export function usd(major: number): MicroUsd {
  return microUsd(Math.round(major * 1_000_000));
}
