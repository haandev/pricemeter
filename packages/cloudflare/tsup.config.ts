import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  target: "es2022",
  sourcemap: true,
  external: ["pricemeter"],
});
