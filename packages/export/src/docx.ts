import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REFERENCE_DOCX = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/reference-6x9.docx");

export interface ManuscriptSection {
  kind: "intro" | "chapter" | "conclusion" | "page";
  title: string;
  markdown: string;
}

export interface ManuscriptInput {
  title: string;
  subtitle?: string;
  author: string;
  language: string;
  sections: ManuscriptSection[];
}

/** Markdown with a Pandoc YAML title block and every section heading at level 1. */
export function buildManuscriptMarkdown(m: ManuscriptInput): string {
  const meta = [
    "---",
    `title: ${yamlString(m.title)}`,
    ...(m.subtitle ? [`subtitle: ${yamlString(m.subtitle)}`] : []),
    `author: ${yamlString(m.author)}`,
    `lang: ${yamlString(m.language)}`,
    "---",
  ].join("\n");
  let chapterNo = 0;
  const body = m.sections.map((s) => {
    const heading = s.kind === "chapter" ? `Chapter ${++chapterNo}: ${s.title}` : s.title;
    return `# ${heading}\n\n${demoteHeadings(s.markdown.trim())}`;
  });
  return `${meta}\n\n${body.join("\n\n")}\n`;
}

/** Section bodies may use their own headings; push them below level 1 so only section titles are level 1. */
export function demoteHeadings(md: string): string {
  return md.replace(/^(#{1,5})(\s)/gm, (_m, hashes: string, sp: string) => `${hashes.length === 1 ? "##" : `${hashes}#`}${sp}`);
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

export interface PandocResult {
  stdout: string;
  stderr: string;
}

export function runPandoc(args: string[], input?: string, pandocPath = process.env.PANDOC_PATH || "pandoc"): Promise<PandocResult> {
  return new Promise((res, rej) => {
    const p = spawn(pandocPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("error", (e) => rej(new Error(`Could not run pandoc (${pandocPath}): ${e.message}`)));
    p.on("close", (code) => (code === 0 ? res({ stdout, stderr }) : rej(new Error(`pandoc exited with ${code}: ${stderr.trim()}`))));
    p.stdin.end(input ?? "");
  });
}

/**
 * pandoc --to docx --reference-doc reference-6x9.docx. Smart quotes stay on so
 * straight quotes become curly; the sanitizer guarantees no "--" sequences
 * remain, so Pandoc never produces a dash from them.
 */
export async function renderDocx(markdown: string, outPath: string, referenceDoc = REFERENCE_DOCX): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "me-docx-"));
  try {
    const src = join(dir, "manuscript.md");
    await writeFile(src, markdown, "utf8");
    await runPandoc(["--from", "markdown", "--to", "docx", "--reference-doc", referenceDoc, "--toc", "--toc-depth=1", "-o", outPath, src]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
