import { body, files, leadingDoc } from "./sources";

export interface Recipe {
  /** "B1", "L11" */
  id: string;
  group: "B" | "L";
  n: number;
  /** HTML anchor, e.g. "b01" */
  anchor: string;
  path: string;
  title: string;
  layer: string;
  /** Doc comment after the title and layer lines. */
  prose: string;
  code: string;
  /** "How" and "Layer" columns of examples/recipes/README.md, when the scenario has a row there. */
  how?: string;
  layerShort?: string;
}

/** Rows of the scenario table in examples/recipes/README.md, by id. */
function readmeRows(): Map<string, { how: string; layer: string }> {
  const out = new Map<string, { how: string; layer: string }>();
  const readme = files("examples/recipes/README.md")[0]?.[1] ?? "";
  for (const line of readme.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    // | # | Scenario | How | Layer | File |
    if (cells.length >= 6 && /^[BL]\d+$/.test(cells[1]!)) out.set(cells[1]!, { how: cells[3]!, layer: cells[4]! });
  }
  return out;
}

/** One entry per file in examples/recipes, sorted B1…B27, L1…L11. New files appear automatically. */
export function recipes(): Recipe[] {
  const out: Recipe[] = [];
  const table = readmeRows();
  for (const [path, src] of files("examples/recipes/")) {
    const name = path.slice("examples/recipes/".length);
    const m = name.match(/^([bl])(\d+)[-_.]/i);
    if (!m) continue;
    const group = m[1]!.toUpperCase() as "B" | "L";
    const n = Number(m[2]);
    const doc = leadingDoc(src);
    const lines = doc.split("\n");
    const head = (lines[0] ?? "").replace(/^[BL]\d+\s*[—–-]\s*/i, "").trim();
    const layerIdx = lines.findIndex((l) => /^Layer:/i.test(l.trim()));
    const layer = layerIdx >= 0 ? lines[layerIdx]!.trim().replace(/^Layer:\s*/i, "").replace(/\.$/, "") : "";
    const rest = lines.filter((_, i) => i !== 0 && i !== layerIdx).join("\n").trim();
    const row = table.get(`${group}${n}`);
    out.push({
      ...(row ? { how: row.how, layerShort: row.layer } : {}),
      id: `${group}${n}`,
      group,
      n,
      anchor: `${group.toLowerCase()}${String(n).padStart(2, "0")}`,
      path,
      title: head || name,
      layer,
      prose: rest,
      code: body(src),
    });
  }
  return out.sort((a, b) => (a.group === b.group ? a.n - b.n : a.group.localeCompare(b.group)));
}

/** The layer words ("core / module"), without the parenthesised detail; translated for Turkish. */
export function layerLabel(r: Recipe, lang: "tr" | "en"): string {
  const short = (r.layerShort ?? r.layer.split(/[(—–]/)[0]!).trim();
  if (lang === "en") return short;
  return short
    .replace(/out of scope/gi, "kapsam dışı")
    .replace(/\bcore\b/gi, "çekirdek")
    .replace(/\bmodule\b/gi, "modül")
    .replace(/\brecipe\b/gi, "tarif");
}
