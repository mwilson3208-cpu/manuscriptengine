import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { wordDiff, type Claim } from "@me/pipeline";
import { BookInput, VoiceProfile } from "@me/shared";
import { BookStore, currentVersion, section, type BookState } from "../lib/book-state";
import {
  approve,
  buildOutputs,
  initBook,
  isBookDir,
  manualEdit,
  regenChapter,
  resolvePending,
  restoreVersion,
  revertLoggedChange,
  runBook,
  setFlag,
  slugify,
  type Operator,
  type RunConfig,
} from "../lib/orchestrator";
import { JobRegistry } from "./jobs";
import { markdownToHtml } from "./markdown";
import { STUDIO_PAGE } from "./page";

export interface StudioOptions {
  /** Directory that holds one folder per book (the Phase 0 `out/`). */
  outRoot: string;
  /** Builds the run config for a job. The operator's capDecision always stops, so the page decides. */
  makeConfig: (log: (m: string) => void) => RunConfig;
  /** Text shown in the header, for example which AI provider is in use. */
  providerLabel: string;
  /** Prefill for the New Book form. */
  examples?: { input: string; voice: string };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const DOWNLOADS: Record<string, string> = {
  "report.md": "text/markdown; charset=utf-8",
  "change-log.md": "text/markdown; charset=utf-8",
  "manuscript.md": "text/markdown; charset=utf-8",
  "claims.json": "application/json; charset=utf-8",
  "ai-use-log.json": "application/json; charset=utf-8",
  "style-sheet.md": "text/markdown; charset=utf-8",
};

export function createStudioHandler(opts: StudioOptions) {
  const jobs = new JobRegistry();
  mkdirSync(opts.outRoot, { recursive: true });

  const bookStore = (slug: string): BookStore => {
    if (!SLUG_RE.test(slug)) throw new HttpError(400, "Invalid book id");
    const dir = join(opts.outRoot, slug);
    if (!isBookDir(dir)) throw new HttpError(404, `No book "${slug}"`);
    return new BookStore(dir);
  };
  const idle = (slug: string) => {
    if (jobs.isRunning(slug)) throw new HttpError(409, "A job is running for this book. Wait for it to finish.");
  };
  const operatorFor = (log: (m: string) => void): Operator => ({ log, capDecision: async () => "stop" });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";

    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(res, 200, STUDIO_PAGE, "text/html; charset=utf-8");
    }
    if (parts[0] !== "api") throw new HttpError(404, "Not found");

    // /api/meta
    if (parts[1] === "meta" && method === "GET") {
      return json(res, { provider: opts.providerLabel, examples: opts.examples ?? null });
    }

    // /api/books
    if (parts[1] === "books" && parts.length === 2) {
      if (method === "GET") return json(res, listBooks(opts.outRoot, jobs));
      if (method === "POST") {
        const body = await readJson(req);
        const input = parseOrThrow(() => JSON.parse(String(body.input ?? "")) as Record<string, unknown>, "Book input is not valid JSON");
        const voice = parseOrThrow(() => VoiceProfile.parse(JSON.parse(String(body.voice ?? ""))), "Voice profile is not valid");
        const merged = { ...input, voice_profile: voice };
        const parsed = BookInput.safeParse(merged);
        if (!parsed.success) throw new HttpError(400, `Book input is not valid: ${parsed.error.message}`);
        const slug = parsed.data.slug ?? slugify(parsed.data.working_title);
        if (!SLUG_RE.test(slug)) throw new HttpError(400, "Working title must contain letters or numbers");
        if (isBookDir(join(opts.outRoot, slug))) throw new HttpError(409, `A book "${slug}" already exists`);
        const inputsDir = join(opts.outRoot, "_inputs");
        mkdirSync(inputsDir, { recursive: true });
        const inputPath = join(inputsDir, `${slug}.json`);
        writeFileSync(inputPath, JSON.stringify(merged, null, 2));
        initBook(inputPath, opts.outRoot);
        return json(res, { slug }, 201);
      }
    }

    if (parts[1] !== "books" || !parts[2]) throw new HttpError(404, "Not found");
    const slug = parts[2];
    const store = bookStore(slug);
    const action = parts[3] ?? "";

    if (method === "GET") {
      switch (action) {
        case "":
          return json(res, bookView(store, jobs));
        case "job":
          return json(res, jobs.get(slug));
        case "section": {
          const key = parts[4] ?? "";
          const state = store.load();
          const s = section(state, key);
          const n = parts[5] ? Number(parts[5]) : (currentVersion(s)?.n ?? 0);
          const v = s.versions.find((x) => x.n === n);
          if (!v) throw new HttpError(404, `${key} has no version ${n}`);
          const logs = state.changeLogs.filter((l) => l.sectionKey === key);
          return json(res, { key, title: s.title, version: v, currentN: currentVersion(s)?.n ?? null, html: markdownToHtml(v.content), changeLogs: logs });
        }
        case "pending": {
          const state = store.load();
          const p = state.pending;
          if (!p) return json(res, null);
          const current = currentVersion(section(state, p.sectionKey))?.content ?? "";
          return json(res, { ...p, log: { ...p.log, diff: undefined }, diff: wordDiff(current, p.revised), revisedHtml: markdownToHtml(p.revised) });
        }
        case "file": {
          const name = parts[4] ?? "";
          if (name === "docx") {
            const docx = store.read("state.json") ? join(store.dir, `${store.load().slug}.docx`) : "";
            if (!docx || !existsSync(docx)) throw new HttpError(404, "No DOCX yet");
            res.writeHead(200, {
              "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "content-disposition": `attachment; filename="${slug}.docx"`,
            });
            res.end(readFileSync(docx));
            return;
          }
          const type = DOWNLOADS[name];
          const content = type ? store.read(name) : null;
          if (!type || content === null) throw new HttpError(404, `No ${name}`);
          return send(res, 200, content, type);
        }
        default:
          throw new HttpError(404, "Not found");
      }
    }

    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    idle(slug);
    const body = await readJson(req);
    switch (action) {
      case "run": {
        const job = jobs.start(slug, "run", async (log) => {
          const out = await runBook(store, { ...opts.makeConfig(log), operator: operatorFor(log) });
          return { message: out.message, stage: out.stage };
        });
        return json(res, job, 202);
      }
      case "brief":
      case "outline": {
        if (body.data !== undefined) {
          const text = typeof body.data === "string" ? body.data : JSON.stringify(body.data);
          parseOrThrow(() => JSON.parse(text) as unknown, `${action}.json is not valid JSON`);
          store.write(`${action}.json`, JSON.stringify(JSON.parse(text), null, 2));
        }
        if (body.approve) {
          const settings = opts.makeConfig(() => {}).settings;
          return json(res, { message: wrap400(() => approve(store, action, settings, body.force === true)) });
        }
        return json(res, { message: `Saved ${action}.json` });
      }
      case "resolve": {
        if (body.decision !== "apply" && body.decision !== "skip") throw new HttpError(400, "decision must be apply or skip");
        return json(res, { message: await resolvePending(store, body.decision) });
      }
      case "regen": {
        const position = Number(body.position);
        if (!Number.isInteger(position) || position < 1) throw new HttpError(400, "position must be a chapter number");
        const note = String(body.note ?? "");
        const job = jobs.start(slug, "regen", async (log) => ({ message: await regenChapter(store, { ...opts.makeConfig(log), operator: operatorFor(log) }, position, note) }));
        return json(res, job, 202);
      }
      case "manual":
        return json(res, { message: wrap400(() => manualEdit(store, String(body.key ?? ""), String(body.content ?? ""), String(body.note ?? "manual edit"))) });
      case "restore":
        return json(res, { message: wrap400(() => restoreVersion(store, String(body.key ?? ""), Number(body.n))) });
      case "revert":
        return json(res, { message: wrap400(() => revertLoggedChange(store, String(body.logId ?? ""), Number(body.n))) });
      case "flag": {
        if (body.flag !== "pinned" && body.flag !== "final") throw new HttpError(400, "flag must be pinned or final");
        return json(res, { message: wrap400(() => setFlag(store, String(body.key ?? ""), body.flag as "pinned" | "final", body.value === true)) });
      }
      case "claims": {
        const claims = body.claims as Claim[] | undefined;
        if (!Array.isArray(claims)) throw new HttpError(400, "claims must be an array");
        for (const c of claims) {
          if (!["Verified", "Needs source", "Cut"].includes(c.status)) throw new HttpError(400, `Invalid claim status "${String(c.status)}"`);
        }
        store.write("claims.json", JSON.stringify(claims, null, 2));
        const state = store.load();
        state.claims = claims;
        store.save(state);
        return json(res, { message: `Saved ${claims.length} claims` });
      }
      case "docx": {
        const job = jobs.start(slug, "docx", async (log) => {
          const out = await buildOutputs(store, operatorFor(log));
          return { message: out.message, stage: out.stage };
        });
        return json(res, job, 202);
      }
      default:
        throw new HttpError(404, "Not found");
    }
  }

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    // Local-only guards. A Host check blocks DNS rebinding from a web page; requiring
    // JSON on POST forces a CORS preflight, which this server never answers, so other
    // sites cannot submit forms to it.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
      json(res, { error: "The Studio only answers on localhost" }, 403);
      return;
    }
    if (req.method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
      json(res, { error: "POST requests must be application/json" }, 415);
      return;
    }
    route(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) json(res, { error: (err as Error).message }, status);
      else res.end();
    });
  };
  return Object.assign(handler, { jobs });
}

/* ------------------------------------------------------------------ */

function listBooks(outRoot: string, jobs: JobRegistry) {
  if (!existsSync(outRoot)) return [];
  return readdirSync(outRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SLUG_RE.test(d.name) && isBookDir(join(outRoot, d.name)))
    .map((d) => {
      const state = new BookStore(join(outRoot, d.name)).load();
      return {
        slug: state.slug,
        title: state.brief?.data.title ?? state.input.working_title,
        lane: state.input.lane,
        author: state.input.author_name,
        stage: stageOf(state),
        words: state.sections.reduce((n, s) => n + (currentVersion(s)?.wordCount ?? 0), 0),
        target: state.input.target_words,
        job: jobs.get(state.slug)?.status ?? null,
        updated: lastActivity(state),
      };
    })
    .sort((a, b) => (a.updated < b.updated ? 1 : -1));
}

function bookView(store: BookStore, jobs: JobRegistry) {
  const state = store.load();
  const passes = ["dev", "line", "copy", "proof"];
  return {
    slug: state.slug,
    input: state.input,
    voiceName: state.voice.name,
    stage: stageOf(state),
    brief: state.brief,
    outline: state.outline,
    sections: [...state.sections]
      .sort((a, b) => a.position - b.position)
      .map((s) => {
        const v = currentVersion(s);
        return {
          key: s.key,
          kind: s.kind,
          position: s.position,
          title: s.title,
          wordTarget: s.wordTarget,
          pinned: s.pinned,
          final: s.final,
          current: v ? { n: v.n, source: v.source, wordCount: v.wordCount, flags: v.flags } : null,
          versions: s.versions.map((x) => ({ n: x.n, source: x.source, note: x.note, wordCount: x.wordCount, createdAt: x.createdAt, flags: x.flags })),
          passes: passes.map((p) => state.passUnits.find((u) => u.pass === p && u.sectionKey === s.key)?.status ?? null),
          openFlags: state.changeLogs.filter((l) => l.sectionKey === s.key).reduce((n, l) => n + l.flags.length, 0),
        };
      }),
    pending: state.pending ? { pass: state.pending.pass, sectionKey: state.pending.sectionKey, ratio: state.pending.ratio, summary: state.pending.summary } : null,
    claims: state.claims,
    files: {
      docx: existsSync(join(store.dir, `${state.slug}.docx`)),
      report: existsSync(join(store.dir, "report.md")),
      changeLog: existsSync(join(store.dir, "change-log.md")),
      qaFailed: existsSync(join(store.dir, "qa.json")) && !existsSync(join(store.dir, `${state.slug}.docx`)),
    },
    usage: {
      calls: state.aiLog.length,
      tokensIn: state.aiLog.reduce((n, e) => n + e.tokensIn, 0),
      tokensOut: state.aiLog.reduce((n, e) => n + e.tokensOut, 0),
    },
    job: jobs.get(state.slug),
  };
}

export function stageOf(state: BookState): string {
  if (state.pending) return "Waiting: 40 percent cap";
  if (!state.brief || state.brief.status !== "approved") return state.brief ? "Brief review" : "New";
  if (!state.outline || state.outline.status !== "approved") return state.outline ? "Outline review" : "Brief approved";
  const drafted = state.sections.filter((s) => s.versions.length > 0).length;
  if (drafted < state.sections.length) return `Drafting (${drafted} of ${state.sections.length})`;
  const units = state.passUnits.length;
  if (units === 0) return "Drafted";
  const editable = state.sections.length * 4 - state.sections.filter((s) => s.kind === "page").length * 2;
  if (units < editable) return `Editing (${units} of ${editable})`;
  return "Edited";
}

function lastActivity(state: BookState): string {
  const times = [state.createdAt, ...state.sections.flatMap((s) => s.versions.map((v) => v.createdAt)), ...state.passUnits.map((u) => u.at)];
  return times.sort().pop() ?? state.createdAt;
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 10 * 1024 * 1024) throw new HttpError(413, "Request too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

function parseOrThrow<T>(fn: () => T, message: string): T {
  try {
    return fn();
  } catch (e) {
    throw new HttpError(400, `${message}: ${(e as Error).message}`);
  }
}

function wrap400<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}
