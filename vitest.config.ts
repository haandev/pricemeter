import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts", "examples/recipes/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      thresholds: { lines: 95, statements: 95, functions: 95 },
    },
  },
  resolve: {
    alias: [
      { find: /^pricemeter\/(.*)$/, replacement: new URL("./packages/core/src/$1/index.ts", import.meta.url).pathname },
      { find: /^pricemeter$/, replacement: new URL("./packages/core/src/index.ts", import.meta.url).pathname },
    ],
  },
});
