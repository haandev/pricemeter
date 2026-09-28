// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";

const page = (slug, tr, en) => ({ slug, label: tr, translations: { en } });

export default defineConfig({
  site: "https://haandev.github.io",
  base: "/pricemeter",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "pricemeter",
      description: "A dumb, typed pricing engine for TypeScript: it owns “how much” and nothing else.",
      defaultLocale: "root",
      locales: {
        root: { label: "Türkçe", lang: "tr" },
        en: { label: "English", lang: "en" },
      },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/haandev/pricemeter" }],
      lastUpdated: false,
      expressiveCode: { defaultProps: { wrap: true } },
      plugins: [
        starlightLinksValidator({ errorOnRelativeLinks: true, errorOnInvalidHashes: true }),
        starlightTypeDoc({
          entryPoints: [
            "./typedoc/pricemeter.ts",
            "./typedoc/rates.ts",
            "./typedoc/gauge.ts",
            "./typedoc/adjustments.ts",
            "./typedoc/calendar.ts",
            "./typedoc/testing.ts",
            "./typedoc/sqlite.ts",
            "./typedoc/cloudflare.ts",
          ],
          tsconfig: "./tsconfig.typedoc.json",
          output: "api",
          sidebar: { label: "API (English)", collapsed: true },
          typeDoc: {
            name: "pricemeter API",
            entryFileName: "index.md",
            disableSources: true,
            // type errors are CI's job (tsc -b); the docs should still build
            skipErrorChecking: true,
            excludeExternals: false,
            sort: ["kind", "alphabetical"],
            parametersFormat: "table",
            enumMembersFormat: "table",
          },
        }),
      ],
      sidebar: [
        {
          label: "Başla",
          translations: { en: "Start" },
          items: [
            page("getting-started", "Başlarken", "Getting started"),
            page("boundary", "“Ne kadar / ne zaman” sınırı", "The “how much / when” boundary"),
          ],
        },
        {
          label: "Kavramlar",
          translations: { en: "Concepts" },
          items: [
            page("catalog", "Katalog", "Catalog"),
            page("rate-models", "Tarife ve modeller", "Tariffs and models"),
            page("price-and-plan", "price() ve plan", "price() and the plan"),
            page("observe-and-hold", "observe ve hold", "observe and hold"),
          ],
        },
        page("recipes", "Tarifler", "Recipes"),
        {
          label: "Modüller",
          translations: { en: "Modules" },
          items: [
            page("modules/rates", "/rates", "/rates"),
            page("modules/gauge", "/gauge", "/gauge"),
            page("modules/adjustments", "/adjustments", "/adjustments"),
            page("modules/calendar", "/calendar", "/calendar"),
            page("modules/testing", "/testing", "/testing"),
          ],
        },
        page("adapters", "Adapter yazma", "Writing adapters"),
        {
          label: "Örnekler",
          translations: { en: "Examples" },
          items: [
            page("examples/messaging", "Mesajlaşma (Cloudflare)", "Messaging (Cloudflare)"),
            page("examples/llm-gateway", "LLM gateway (SQLite)", "LLM gateway (SQLite)"),
            page("examples/saas-seats", "SaaS koltuk (SQLite)", "SaaS seats (SQLite)"),
          ],
        },
        {
          label: "Referans",
          translations: { en: "Reference" },
          items: [page("api-overview", "API'ye genel bakış", "API overview"), typeDocSidebarGroup],
        },
        {
          label: "Proje",
          translations: { en: "Project" },
          items: [page("migration", "Göç", "Migration"), page("decisions", "Kararlar", "Decisions")],
        },
      ],
    }),
  ],
  vite: {
    // code excerpts are imported with ?raw from ../packages, ../examples and ../design
    server: { fs: { allow: [".."] } },
  },
});
