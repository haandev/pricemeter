import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "rates/index": "src/rates/index.ts",
    "gauge/index": "src/gauge/index.ts",
    "adjustments/index": "src/adjustments/index.ts",
    "testing/index": "src/testing/index.ts",
    "calendar/index": "src/calendar/index.ts",
  },
  format: ["esm", "cjs"],
  // tsup sets baseUrl for the d.ts build, which TypeScript 6 deprecates
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  splitting: true,
  treeshake: true,
  target: "es2022",
  sourcemap: true,
});
