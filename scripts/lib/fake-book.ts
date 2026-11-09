import { execFileSync } from "node:child_process";
import { DEFAULT_SETTINGS, FakeAI, routeByTask, type AIRequest } from "@me/pipeline";
import { testBrief, testOutline, testVoice } from "../../packages/pipeline/src/fixtures";

/** Test helpers shared by the orchestrator and Studio tests. Not used at runtime. */
export { DEFAULT_SETTINGS, testBrief, testOutline, testVoice };

export const hasPandoc = (() => {
  try {
    execFileSync("pandoc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

export const FILLER = "Honestly, the thing is that you basically just need to start.";

function chapterBody(n: number): string {
  return [
    `You open your laptop on a Friday in week ${n} and the list is still empty.`,
    `Dana wrote down 5 names and sent the first note to Priya before lunch.`,
    FILLER,
    `Write the names on a card today.`,
  ].join("\n\n");
}

export function sectionText(req: AIRequest): string {
  const m = /\nSection: [^\n]*\n\n([\s\S]*?)\n\nRun the /.exec(req.user);
  if (!m?.[1]) throw new Error("no section text in request");
  return m[1];
}

function editResponse(text: string, changes: unknown[] = [], flags: unknown[] = []): string {
  return JSON.stringify({ revised_markdown: text, changes, flags });
}

/** A fake model: line pass removes the filler sentence; dev pass rewrites chapter 2 wholesale (over the cap). */
export function fakeModel(opts: { banned?: boolean } = {}) {
  return new FakeAI(
    routeByTask({
      brief: () => JSON.stringify(testBrief),
      outline: () => JSON.stringify(testOutline),
      chapter: (req) => {
        const n = Number(/You are writing chapter (\d+)\./.exec(req.user)?.[1] ?? 0);
        const body = chapterBody(n);
        return opts.banned && n === 3 ? `${body}\n\nThis is a game-changer.` : body;
      },
      summary: (req) => `Summary through chapter ${/New chapter (\d+)/.exec(req.user)?.[1]}.`,
      matter: () => JSON.stringify({ introduction_markdown: "You have tried events. This book gives you a routine.", conclusion_markdown: "You now run the routine.", companion_course_markdown: "Get the templates at [COURSE URL]." }),
      "edit-dev": (req) => {
        const text = sectionText(req);
        if (req.user.includes("Section: Chapter 2:")) return editResponse("A wholly new chapter with different words everywhere, Dana 5 Priya Friday 2.");
        return editResponse(text, [], [{ type: "example", location: "paragraph 2", note: "Example is thin" }]);
      },
      "edit-line": (req) => {
        const text = sectionText(req);
        if (!text.includes(FILLER)) return editResponse(text);
        return editResponse(text.replace(`${FILLER}\n\n`, ""), [{ type: "filler", location: "paragraph 3", before: `${FILLER}\n\n`, after: "", reason: "filler" }]);
      },
      "edit-copy": (req) => editResponse(sectionText(req)),
      "edit-proof": (req) => editResponse(sectionText(req)),
    }),
  );
}
