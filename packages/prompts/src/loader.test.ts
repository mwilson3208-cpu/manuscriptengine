import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareSemver, listTasks, listVersions, loadTemplate, parseTemplate, renderTemplate, TemplateError } from "./loader";

const REQUIRED_TASKS = [
  "brief",
  "chapter",
  "edit-copy",
  "edit-dev",
  "edit-line",
  "edit-proof",
  "matter",
  "metadata",
  "outline",
  "pain-queries",
  "summary",
];

const HOUSE_RULES = [
  "Do not use em dashes or en dashes.",
  "Do not use emojis.",
  "Write in paragraphs by default. Use a list only when the content is a list.",
  "No generic motivational language. Every claim ties to an action or an example.",
  "Name each framework once, then use it by name.",
];

describe("repository templates", () => {
  it("includes every template task CLAUDE.md lists", () => {
    expect(listTasks()).toEqual(REQUIRED_TASKS);
  });

  for (const task of REQUIRED_TASKS) {
    it(`${task}: parses and carries the house rules`, () => {
      const t = loadTemplate(task);
      expect(t.version).toBe("1.0.0");
      for (const rule of HOUSE_RULES) expect(t.system).toContain(rule);
    });
  }

  for (const task of ["edit-dev", "edit-line", "edit-copy", "edit-proof"]) {
    it(`${task}: requires changes[] with the revised text and protects examples and frameworks`, () => {
      const t = loadTemplate(task);
      expect(t.output).toBe("json");
      expect(t.schema).toBe("EditOutput");
      expect(t.system).toContain("in the same response as the revised text");
      expect(t.system).toMatch(/never rewrite, replace, or reword an example, a story, or a framework name/i);
      expect(t.system).toContain("Do not change more than 40 percent");
      expect(t.system).toContain("Read the style sheet first");
    });
  }
});

const SAMPLE = `---
task: sample
version: 1.2.0
model: sonnet
slots: [name]
optional_slots: [note]
output: markdown
---
# System

Rules for {{name}}.

# User

Hello {{name}}.
{{#note}}
Note: {{note}}
{{/note}}
Done.
`;

describe("parseTemplate and renderTemplate", () => {
  it("fills slots and renders conditional blocks only when set", () => {
    const t = parseTemplate(SAMPLE);
    expect(t.id).toBe("sample@1.2.0");
    const without = renderTemplate(t, { name: "Ada" });
    expect(without.user).toBe("Hello Ada.\n\nDone.");
    const withNote = renderTemplate(t, { name: "Ada", note: "be brief" });
    expect(withNote.user).toContain("Note: be brief");
    expect(withNote.system).toBe("Rules for Ada.");
    expect(withNote.promptVersion).toBe("sample@1.2.0");
  });

  it("stringifies objects as JSON", () => {
    const t = parseTemplate(SAMPLE);
    expect(renderTemplate(t, { name: { a: 1 } }).system).toContain('"a": 1');
  });

  it("rejects missing, empty, and unknown slots", () => {
    const t = parseTemplate(SAMPLE);
    expect(() => renderTemplate(t, {})).toThrow(/missing required slots: name/);
    expect(() => renderTemplate(t, { name: "  " })).toThrow(/missing required slots/);
    expect(() => renderTemplate(t, { name: "x", other: "y" })).toThrow(/unknown slots: other/);
  });

  it("rejects undeclared placeholders, unused required slots, bad blocks, and unknown schemas", () => {
    expect(() => parseTemplate(SAMPLE.replace("Hello {{name}}.", "Hello {{name}} {{who}}."))).toThrow(/"who" is not declared/);
    expect(() => parseTemplate(SAMPLE.replace("slots: [name]", "slots: [name, extra]"))).toThrow(/"extra" is never used/);
    expect(() => parseTemplate(SAMPLE.replace("{{/note}}", ""))).toThrow(TemplateError);
    expect(() => parseTemplate(SAMPLE.replace("output: markdown", "output: json\nschema: Nope"))).toThrow(/unknown schema/);
    expect(() => parseTemplate("# System\nx\n# User\ny")).toThrow(/front matter/);
  });
});

describe("versions", () => {
  it("compares semantic versions numerically", () => {
    expect(["1.10.0", "1.2.0", "1.2.10", "1.2.9"].sort(compareSemver)).toEqual(["1.2.0", "1.2.9", "1.2.10", "1.10.0"]);
  });

  it("loads the latest version by default and a pinned version on request", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompts-"));
    mkdirSync(join(dir, "sample"));
    writeFileSync(join(dir, "sample", "1.2.0.md"), SAMPLE);
    writeFileSync(join(dir, "sample", "1.10.0.md"), SAMPLE.replace("version: 1.2.0", "version: 1.10.0"));
    expect(listVersions("sample", dir)).toEqual(["1.2.0", "1.10.0"]);
    expect(loadTemplate("sample", undefined, dir).version).toBe("1.10.0");
    expect(loadTemplate("sample", "1.2.0", dir).version).toBe("1.2.0");
    expect(() => loadTemplate("sample", "9.9.9", dir)).toThrow(/not found/);
  });
});
