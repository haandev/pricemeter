/**
 * Every code excerpt on the site comes from a real file in the repository, imported with `?raw`
 * at build time, so the docs cannot drift from the code. Paths are relative to the repository root.
 */
const raw = import.meta.glob(
  [
    "../../../packages/*/src/**/*.ts",
    "../../../examples/*/src/**/*.ts",
    "../../../examples/*/test/**/*.ts",
    "../../../examples/recipes/*.test.ts",
    "../../../examples/recipes/README.md",
    "../../../design/*.md",
    "../../../README.md",
    "../snippets/*.ts",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const byPath = new Map<string, string>();
for (const [k, v] of Object.entries(raw)) {
  byPath.set(k.startsWith("../snippets/") ? `docs/src/snippets/${k.slice("../snippets/".length)}` : k.replace(/^(\.\.\/){3}/, ""), v);
}

/** Contents of a repository file, e.g. `file("examples/llm-gateway/src/gateway.ts")`. Throws when missing. */
export function file(path: string): string {
  const src = byPath.get(path);
  if (src === undefined) throw new Error(`docs: no source file "${path}" (known: ${[...byPath.keys()].join(", ")})`);
  return src;
}

/** All known files whose path starts with `prefix`. */
export function files(prefix: string): [path: string, source: string][] {
  return [...byPath].filter(([p]) => p.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
}

function dedent(lines: string[]): string {
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length);
  const n = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(n)).join("\n").replace(/\s+$/, "");
}

/** Lines between `// #region name` and `// #endregion`. Throws when the region is missing. */
export function region(src: string, name: string): string {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.trim() === `// #region ${name}`);
  if (start < 0) throw new Error(`docs: region "${name}" not found`);
  const end = lines.findIndex((l, i) => i > start && l.trim().startsWith("// #endregion"));
  return dedent(lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => !/^\s*\/\/ #(end)?region\b/.test(l)));
}

/**
 * A top-level declaration (function, const, class, interface, type) with its JSDoc, up to the closing
 * line at column 0. Throws when it cannot be found, so a renamed symbol breaks the build instead of the docs.
 */
export function declaration(src: string, name: string, opts: { doc?: boolean } = {}): string {
  const lines = src.split("\n");
  const re = new RegExp(`^(export )?(default )?(declare )?(async )?(function\\*?|const|let|class|interface|type|abstract class) ${name.replace(/[$]/g, "\\$")}\\b`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) throw new Error(`docs: declaration "${name}" not found`);
  let from = start;
  if (opts.doc !== false && lines[start - 1]?.trim().endsWith("*/")) {
    while (from > 0 && !lines[from - 1]!.trim().startsWith("/**")) from--;
    from--;
  }
  const first = lines[start]!;
  const opens = (first.match(/[{([]/g) ?? []).length;
  const closes = (first.match(/[})\]]/g) ?? []).length;
  if (opens <= closes && /;\s*$/.test(first)) return lines.slice(from, start + 1).join("\n");
  let end = start + 1;
  while (end < lines.length && !/^[})\]]/.test(lines[end]!)) end++;
  return lines.slice(from, end + 1).join("\n");
}

/** Removes the leading `/** … *\/` block and the import lines that follow it. */
export function body(src: string, opts: { imports?: boolean } = {}): string {
  let s = src.replace(/^\/\*\*[\s\S]*?\*\/\s*/, "");
  if (opts.imports === false) s = s.replace(/^(import [\s\S]*?;\s*\n)+/, "");
  return s.trimEnd();
}

/** The text of the leading `/** … *\/` comment, without the stars. */
export function leadingDoc(src: string): string {
  const m = src.match(/^\/\*\*([\s\S]*?)\*\//);
  if (!m) return "";
  return m[1]!
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

/** The `n`-th (0-based) fenced code block of a markdown file, optionally only blocks of `lang`. */
export function fence(src: string, n = 0, lang?: string): string {
  const blocks = [...src.matchAll(/^```(\w*)\n([\s\S]*?)^```/gm)].filter((m) => lang === undefined || m[1] === lang);
  const b = blocks[n];
  if (!b) throw new Error(`docs: code block #${n}${lang ? ` (${lang})` : ""} not found`);
  return b[2]!.trimEnd();
}

/**
 * From the first line containing `from` to the first later line matching the regex `to` (inclusive), dedented.
 * For excerpts that are not top-level declarations. Throws when either end is missing.
 */
export function slice(src: string, from: string, to: string): string {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.includes(from));
  if (start < 0) throw new Error(`docs: no line containing "${from}"`);
  const re = new RegExp(to);
  const end = lines.findIndex((l, i) => i > start && re.test(l));
  if (end < 0) throw new Error(`docs: no line matching /${to}/ after "${from}"`);
  let s = start;
  if (lines[start - 1]?.trim().endsWith("*/")) {
    while (s > 0 && !lines[s - 1]!.trim().startsWith("/**")) s--;
    s--;
  }
  return dedent(lines.slice(s, end + 1));
}
