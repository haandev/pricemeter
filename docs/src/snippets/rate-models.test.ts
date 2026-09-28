/** Code on the "Tariffs and models" page. Runs with `bun run test` in docs/. */
import { describe, expect, it } from "vitest";
// #region models
import { defineRate, rate, type Tier } from "pricemeter";

const tiers: Tier[] = [
  { from: 0, unitPriceMicroUsd: 50_000 },
  { from: 10_000, unitPriceMicroUsd: 45_000 },
];
const graduated = defineRate({ model: "graduated", tiers });
const volume = defineRate({ model: "volume", tiers, policy: { adjustmentTiming: "on_crossing" } });
const pkg = defineRate({ model: "package", packageSize: 1_000, tiers }); // price per block

rate({ rate: graduated, usedSoFar: 9_990, quantity: 20 }).totalMicroUsd; // 950_000
rate({ rate: volume, usedSoFar: 9_990, quantity: 20 }).totalMicroUsd; //    900_000
rate({ rate: volume, usedSoFar: 9_990, quantity: 20 }).adjustmentMicroUsd; // −49_950_000
rate({ rate: pkg, usedSoFar: 9_990, quantity: 20 }).totalMicroUsd; //        45_000 (1 new block)
// #endregion

// #region rounding
// $0.15 per 1M tokens = 0.15 micro-USD per token. 1,000 calls of 3 tokens each:
const perEvent = defineRate({ model: "graduated", tiers: [{ from: 0, unitPriceMicroUsd: 150_000, per: 1_000_000 }] });
const cumulative = defineRate({ ...perEvent, policy: { rounding: "cumulative" } });

let a = 0;
let b = 0;
for (let used = 0; used < 3_000; used += 3) {
  a += rate({ rate: perEvent, usedSoFar: used, quantity: 3 }).totalMicroUsd; //   each call rounds up to 1
  b += rate({ rate: cumulative, usedSoFar: used, quantity: 3 }).totalMicroUsd; // floor(T(u+q)) − floor(T(u))
}
// a === 1_000, b === 450 (exactly 3,000 × 0.15)
// #endregion

// #region clamp
// 2.9% + $0.30, at least $0.50, at most $5 per transaction (quantity = amount in micro-USD)
const card = defineRate({
  model: "graduated",
  tiers: [{ from: 0, unitPriceMicroUsd: 29_000, per: 1_000_000, flatMicroUsd: 300_000 }],
  policy: { perObservation: { minMicroUsd: 500_000, maxMicroUsd: 5_000_000 }, tierPeriod: "observation" },
});
rate({ rate: card, usedSoFar: 0, quantity: 1_000_000 }); //   { totalMicroUsd: 500_000,   clamped: "min" }
rate({ rate: card, usedSoFar: 0, quantity: 100_000_000 }); // { totalMicroUsd: 3_200_000 }
rate({ rate: card, usedSoFar: 0, quantity: 500_000_000 }); // { totalMicroUsd: 5_000_000, clamped: "max" }
// #endregion

// #region validate
import { validateRate } from "pricemeter";

validateRate({ model: "graduated", tiers: [{ from: 10, unitPriceMicroUsd: 1.5 }] });
// → { ok: false, errors: [
//      { code: "first_tier_from", path: ["tiers", 0, "from"], message: "the first tier must start at 0" },
//      { code: "invalid_price", path: ["tiers", 0, "unitPriceMicroUsd"], message: "unitPriceMicroUsd must be a non-negative integer" } ] }
// #endregion

describe("rate models page", () => {
  it("matches the worked example", () => {
    expect(rate({ rate: graduated, usedSoFar: 9_990, quantity: 20 }).totalMicroUsd).toBe(950_000);
    expect(rate({ rate: volume, usedSoFar: 9_990, quantity: 20 })).toMatchObject({ totalMicroUsd: 900_000, adjustmentMicroUsd: -49_950_000 });
    expect(rate({ rate: pkg, usedSoFar: 9_990, quantity: 20 }).totalMicroUsd).toBe(45_000);
    expect(rate({ rate: graduated, usedSoFar: 9_990, quantity: 20 }).holdUpperBound).toBe(1_000_000);
  });
  it("rounding", () => {
    expect([a, b]).toEqual([1_000, 450]);
  });
  it("clamps", () => {
    expect(rate({ rate: card, usedSoFar: 0, quantity: 1_000_000 })).toMatchObject({ totalMicroUsd: 500_000, clamped: "min" });
    expect(rate({ rate: card, usedSoFar: 0, quantity: 100_000_000 }).totalMicroUsd).toBe(3_200_000);
    expect(rate({ rate: card, usedSoFar: 0, quantity: 500_000_000 })).toMatchObject({ totalMicroUsd: 5_000_000, clamped: "max" });
  });
  it("validates", () => {
    const v = validateRate({ model: "graduated", tiers: [{ from: 10, unitPriceMicroUsd: 1.5 }] });
    expect(v).toMatchObject({ ok: false, errors: [{ code: "first_tier_from", path: ["tiers", 0, "from"] }, { code: "invalid_price", path: ["tiers", 0, "unitPriceMicroUsd"] }] });
  });
});
