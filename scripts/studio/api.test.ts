import { mkdtempSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AIClient } from "@me/pipeline";
import { DEFAULT_SETTINGS, fakeModel, FILLER, hasPandoc, testVoice } from "../lib/fake-book";
import { createStudioHandler } from "./api";
import { markdownToHtml } from "./markdown";

function startStudio(ai: AIClient) {
  const outRoot = mkdtempSync(join(tmpdir(), "studio-"));
  const handler = createStudioHandler({
    outRoot,
    providerLabel: "Fake",
    makeConfig: (log) => ({ ai, settings: DEFAULT_SETTINGS, operator: { log, capDecision: async () => "stop" }, backoffMs: 0 }),
    examples: { input: "{}", voice: "{}" },
  });
  const server = createServer(handler);
  return new Promise<{ server: Server; base: string; handler: typeof handler; outRoot: string }>((res) =>
    server.listen(0, "127.0.0.1", () => res({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, handler, outRoot })),
  );
}

const newBook = {
  input: JSON.stringify({ working_title: "Weekly Outreach", lane: "BZ", author_name: "Pen Name", target_words: 11000, materials: { examples: ["Dana's first Friday Five"] } }),
  voice: JSON.stringify(testVoice),
};

describe("Studio API", () => {
  let s: Awaited<ReturnType<typeof startStudio>>;
  const get = (p: string) => fetch(s.base + p);
  const post = (p: string, body: unknown) => fetch(s.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const settle = () => s.handler.jobs.settle("weekly-outreach");
  const msg = async (r: Promise<Response>) => ((await (await r).json()) as { message: string }).message;

  beforeAll(async () => {
    s = await startStudio(fakeModel());
  });
  afterAll(() => s.server.close());

  it("serves the page and meta", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Manuscript Studio");
    expect(await (await get("/api/meta")).json()).toEqual({ provider: "Fake", examples: { input: "{}", voice: "{}" } });
  });

  it("answers only on localhost and only to JSON posts", async () => {
    const status = await new Promise<number>((res) => {
      const u = new URL(s.base);
      request({ host: u.hostname, port: u.port, path: "/api/books", headers: { host: "evil.example.com" } }, (r) => res(r.statusCode ?? 0)).end();
    });
    expect(status).toBe(403);
    const form = await fetch(s.base + "/api/books", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect(form.status).toBe(415);
  });

  it("validates and creates books", async () => {
    expect((await post("/api/books", { input: "not json", voice: newBook.voice })).status).toBe(400);
    expect((await post("/api/books", { input: newBook.input, voice: "{}" })).status).toBe(400);
    const created = await post("/api/books", newBook);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ slug: "weekly-outreach" });
    expect((await post("/api/books", newBook)).status).toBe(409);
    const list = (await (await get("/api/books")).json()) as { slug: string; stage: string }[];
    expect(list.map((b) => [b.slug, b.stage])).toEqual([["weekly-outreach", "New"]]);
  });

  it("rejects bad book ids and unknown routes", async () => {
    expect((await get("/api/books/..%2Fetc")).status).toBe(400);
    expect((await get("/api/books/nope")).status).toBe(404);
    expect((await get("/api/books/weekly-outreach/nothing")).status).toBe(404);
    expect((await get("/api/books/weekly-outreach/file/state.json")).status).toBe(404);
  });

  it.skipIf(!hasPandoc)("carries a book through the gates, the cap, and to a DOCX", async () => {
    // Brief
    expect((await post("/api/books/weekly-outreach/run", {})).status).toBe(202);
    expect((await settle())?.stage).toBe("brief_review");
    let book = (await (await get("/api/books/weekly-outreach")).json()) as { stage: string; brief: { data: unknown } };
    expect(book.stage).toBe("Brief review");
    expect((await post("/api/books/weekly-outreach/brief", { data: "{bad" })).status).toBe(400);
    const approved = (await (await post("/api/books/weekly-outreach/brief", { data: book.brief.data, approve: true })).json()) as { message: string };
    expect(approved.message).toContain("approved");

    // Outline
    await post("/api/books/weekly-outreach/run", {});
    expect((await settle())?.stage).toBe("outline_review");
    expect((await msg(post("/api/books/weekly-outreach/outline", { approve: true })))).toContain("3 chapters");

    // Draft and edit until the cap stops the developmental pass on chapter 2
    await post("/api/books/weekly-outreach/run", {});
    expect((await settle())?.stage).toBe("waiting_operator");
    const pending = (await (await get("/api/books/weekly-outreach/pending")).json()) as { sectionKey: string; diff: { op: string }[]; ratio: number };
    expect(pending.sectionKey).toBe("ch02");
    expect(pending.ratio).toBeGreaterThan(0.4);
    expect(pending.diff.some((h) => h.op === "add")).toBe(true);
    expect((await post("/api/books/weekly-outreach/resolve", { decision: "maybe" })).status).toBe(400);
    await post("/api/books/weekly-outreach/resolve", { decision: "skip" });
    expect(await (await get("/api/books/weekly-outreach/pending")).json()).toBeNull();

    await post("/api/books/weekly-outreach/run", {});
    expect((await settle())?.stage).toBe("done");
    book = (await (await get("/api/books/weekly-outreach")).json()) as typeof book & { files: { docx: boolean } };
    expect((book as unknown as { files: { docx: boolean } }).files.docx).toBe(true);
    expect((await get("/api/books/weekly-outreach/file/docx")).headers.get("content-type")).toContain("wordprocessingml");
    expect(await (await get("/api/books/weekly-outreach/file/report.md")).text()).toContain("Phase 0 report");

    // Read a section and its change logs
    const sec = (await (await get("/api/books/weekly-outreach/section/ch01")).json()) as { version: { n: number; source: string }; html: string; changeLogs: { id: string; pass: string }[] };
    expect(sec.version.source).toBe("line");
    expect(sec.html).toContain("<p>");
    const lineLog = sec.changeLogs.find((l) => l.pass === "line");

    // Revert one change, restore the draft, save a manual edit, flag final
    expect((await msg(post("/api/books/weekly-outreach/revert", { logId: lineLog?.id, n: 1 })))).toContain("version 3");
    const reverted = (await (await get("/api/books/weekly-outreach/section/ch01")).json()) as { version: { content: string } };
    expect(reverted.version.content).toContain(FILLER);
    expect((await post("/api/books/weekly-outreach/restore", { key: "ch01", n: 99 })).status).toBe(400);
    await post("/api/books/weekly-outreach/restore", { key: "ch01", n: 1 });
    expect(((await (await get("/api/books/weekly-outreach/section/ch01")).json()) as { version: { n: number } }).version.n).toBe(1);
    expect((await msg(post("/api/books/weekly-outreach/manual", { key: "ch01", content: "Hand edit \u2014 here.", note: "mine" })))).toContain("version 4");
    const manual = (await (await get("/api/books/weekly-outreach/section/ch01")).json()) as { version: { content: string; source: string } };
    expect(manual.version).toMatchObject({ source: "manual", content: "Hand edit: here." });
    expect((await post("/api/books/weekly-outreach/flag", { key: "ch01", flag: "final", value: true })).status).toBe(200);
    expect((await post("/api/books/weekly-outreach/flag", { key: "ch01", flag: "other", value: true })).status).toBe(400);

    // Claims
    const claims = ((await (await get("/api/books/weekly-outreach")).json()) as { claims: { status: string }[] }).claims;
    expect((await post("/api/books/weekly-outreach/claims", { claims: [{ ...claims[0], status: "Maybe" }] })).status).toBe(400);
    expect((await msg(post("/api/books/weekly-outreach/claims", { claims: claims.map((c) => ({ ...c, status: "Verified" })) })))).toContain("Saved");

    // Regenerate as a job, then rebuild the DOCX as a job
    expect((await post("/api/books/weekly-outreach/regen", { position: 0 })).status).toBe(400);
    expect((await post("/api/books/weekly-outreach/regen", { position: 2, note: "shorter" })).status).toBe(202);
    expect((await settle())?.result).toContain("regenerated");
    expect((await post("/api/books/weekly-outreach/docx", {})).status).toBe(202);
    expect((await settle())?.stage).toBe("done");
  });
});

describe("Studio API job lock", () => {
  it("refuses changes while a job runs for the book", async () => {
    const inner = fakeModel();
    const slow: AIClient = { complete: async (req) => (await new Promise((r) => setTimeout(r, 300)), inner.complete(req)) };
    const s = await startStudio(slow);
    try {
      const post = (p: string, body: unknown) => fetch(s.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await post("/api/books", newBook);
      expect((await post("/api/books/weekly-outreach/run", {})).status).toBe(202);
      expect((await post("/api/books/weekly-outreach/run", {})).status).toBe(409);
      expect((await post("/api/books/weekly-outreach/brief", { approve: true })).status).toBe(409);
      const job = (await (await fetch(s.base + "/api/books/weekly-outreach/job")).json()) as { status: string };
      expect(job.status).toBe("running");
      await s.handler.jobs.settle("weekly-outreach");
    } finally {
      s.server.close();
    }
  });
});

describe("markdownToHtml", () => {
  it("escapes model output and renders basic Markdown", () => {
    const html = markdownToHtml("## Head\n\nA **bold** and *italic* <script>x</script>.\n\n- one\n- two\n\n1. first\n2. second\n\n> quote");
    expect(html).toContain("<h3>Head</h3>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain("<blockquote>");
  });
});
