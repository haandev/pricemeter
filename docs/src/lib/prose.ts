/** Minimal inline markdown for doc comments: paragraphs, `code` and **bold**. HTML is escaped. */
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function inline(s: string): string {
  return escape(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}

export function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const lines = p.split("\n");
      if (lines.every((l) => /^\s*[-•]\s/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-•]\s/, ""))}</li>`).join("")}</ul>`;
      return `<p>${inline(lines.join(" "))}</p>`;
    })
    .join("\n");
}

/** The markdown tables in `src` as rows of cells (header row first). Separator rows are dropped. */
export function tables(src: string): string[][][] {
  const out: string[][][] = [];
  let cur: string[][] | null = null;
  for (const line of src.split("\n")) {
    if (/^\s*\|/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
      (cur ??= []).push(cells);
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}
