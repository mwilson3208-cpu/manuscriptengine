/**
 * Minimal Markdown to HTML for reading chapters in the Studio: headings,
 * paragraphs, lists, block quotes, bold, italics. Everything is escaped first,
 * so model output can never inject markup into the page.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|\W)_(?!\s)(.+?)_(?=\W|$)/g, "$1<em>$2</em>");
}

export function markdownToHtml(md: string): string {
  const blocks = md.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  const out: string[] = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    const lines = block.split("\n");
    const h = /^(#{1,6})\s+(.*)$/.exec(lines[0] ?? "");
    if (h && lines.length === 1) {
      const level = Math.min(6, (h[1] ?? "#").length + 1);
      out.push(`<h${level}>${inline(h[2] ?? "")}</h${level}>`);
      continue;
    }
    if (lines.every((l) => /^\s*[-*+]\s+/.test(l))) {
      out.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*+]\s+/, ""))}</li>`).join("")}</ul>`);
      continue;
    }
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      out.push(`<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`);
      continue;
    }
    if (lines.every((l) => /^\s*>/.test(l))) {
      out.push(`<blockquote><p>${inline(lines.map((l) => l.replace(/^\s*>\s?/, "")).join(" "))}</p></blockquote>`);
      continue;
    }
    if (h) {
      const level = Math.min(6, (h[1] ?? "#").length + 1);
      out.push(`<h${level}>${inline(h[2] ?? "")}</h${level}>`, `<p>${lines.slice(1).map(inline).join("<br>")}</p>`);
      continue;
    }
    out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");
}
