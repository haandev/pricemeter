/** Exact non-float arithmetic for sub-micro amounts. Internal. */
export interface Q {
  readonly n: bigint;
  readonly d: bigint; // always > 0
}

const abs = (a: bigint) => (a < 0n ? -a : a);
function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

export function q(n: bigint | number, d: bigint | number = 1n): Q {
  let nn = BigInt(n);
  let dd = BigInt(d);
  if (dd === 0n) throw new RangeError("division by zero");
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  const g = gcd(nn, dd);
  return { n: nn / g, d: dd / g };
}

export const ZERO: Q = { n: 0n, d: 1n };

export const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
export const mulInt = (a: Q, k: bigint | number): Q => q(a.n * BigInt(k), a.d);
export const cmp = (a: Q, b: Q): number => {
  const x = a.n * b.d - b.n * a.d;
  return x < 0n ? -1 : x > 0n ? 1 : 0;
};

export function floor(a: Q): bigint {
  const r = a.n / a.d; // truncates toward zero
  return a.n < 0n && r * a.d !== a.n ? r - 1n : r;
}
export function ceil(a: Q): bigint {
  const r = a.n / a.d;
  return a.n > 0n && r * a.d !== a.n ? r + 1n : r;
}
/** Fractional part in [0, 1). */
export const frac = (a: Q): Q => sub(a, q(floor(a)));

export function toNumber(b: bigint): number {
  const n = Number(b);
  if (!Number.isSafeInteger(n)) throw new RangeError(`amount ${b} exceeds safe integer range`);
  return n;
}

/** Converts a float carry in [0,1) to an exact rational with 1e-12 resolution. */
export function fromCarry(c: number): Q {
  if (!(c >= 0 && c < 1)) throw new RangeError(`carry must be in [0, 1), got ${c}`);
  return q(BigInt(Math.round(c * 1e12)), 1_000_000_000_000n);
}
export const toCarry = (a: Q): number => Number(a.n) / Number(a.d);
