// Generates a 500-meter catalog and checks that `tsc` stays under the budget (§10: < 2 s).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".tmp/type-budget");
const N = Number(process.env.METERS ?? 500);
const BUDGET = Number(process.env.BUDGET_MS ?? 2000);
mkdirSync(dir, { recursive: true });

let chain = "";
for (let i = 0; i < 10; i++) chain += `\n  .meter("pool/${i}")`;
for (let i = 0; i < N - 10; i++) {
  const kind = i % 4;
  if (kind === 0) chain += `\n  .meter("m/${i}", { country: z.string(), tier: z.enum(["a", "b"]) })`;
  else if (kind === 1) chain += `\n  .meter("m/${i}", ["region"], { feeds: { "pool/${i % 10}": 1 } })`;
  else if (kind === 2) chain += `\n  .meter("m/${i}", typed<{ sku: string }>())`;
  else chain += `\n  .meter("m/${i}", { model: z.string() }, { feeds: { "pool/${i % 10}": (d) => (d.model === "x" ? 2 : 1) } })`;
}

const src = `import { z } from "zod";
import { buildMetering, typed } from "pricemeter";

export const metering = buildMetering()
  .context(z.object({ accountId: z.string() }))
  .refs(["r"])${chain}
  .getRate(async (meter, dims, _ctx, _at) => (meter === "m/0" && dims.country === "TR" ? null : null))
  .commit(async () => {});

const ctx = { accountId: "a" };
export const a = metering.observe("m/0", { country: "TR", tier: "a" }, 1, { type: "r", id: "1" }, ctx);
export const b = metering.observe([{ meter: "m/3", dims: { model: "x" }, quantity: 1 }, { meter: "m/2", dims: { sku: "s" }, quantity: 2 }], { type: "r", id: "1" }, ctx);
export const c = metering.meters["m/${N - 11}"];
`;
writeFileSync(join(dir, "catalog.ts"), src);
writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify({
    extends: "../../tsconfig.base.json",
    compilerOptions: {
      noEmit: true,
      declaration: false,
      paths: { pricemeter: ["../../packages/core/src/index.ts"] },
    },
    files: ["catalog.ts"],
  }),
);

const tsc = join(root, "node_modules/typescript/bin/tsc");
const run = () => {
  const t = Date.now();
  const out = execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json"), "--extendedDiagnostics"], { encoding: "utf8" });
  return { ms: Date.now() - t, out };
};
run(); // warm the file cache
const { ms, out } = run();
const pick = (k) => out.match(new RegExp(`${k}:\\s+(\\S+)`))?.[1];
console.log(`${N} meters: wall ${ms} ms, check ${pick("Check time")}, instantiations ${pick("Instantiations")}, memory ${pick("Memory used")}`);
if (ms > BUDGET) {
  console.error(`over budget (${BUDGET} ms)`);
  process.exit(1);
}
