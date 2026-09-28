import { defineConfig } from "vitest/config";

const src = (p: string) => new URL(`../packages/${p}`, import.meta.url).pathname;

// Runs the code shown in the docs (src/snippets) against the library sources.
export default defineConfig({
  test: { include: ["src/snippets/**/*.test.ts"] },
  resolve: {
    alias: [
      { find: /^pricemeter\/(.*)$/, replacement: src("core/src/$1/index.ts") },
      { find: /^pricemeter$/, replacement: src("core/src/index.ts") },
    ],
  },
});
