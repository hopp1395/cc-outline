import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdown, stripBoxes } from "../src/render/markdown.js";
import { TranscriptParser, turnMarkdown } from "../src/transcript/parse.js";
import { toolMarkdown, toolOutcome } from "../src/transcript/tools.js";

// Paths as the transcripts of this system hold them.
const cwd = resolve("/work/repo");

describe("toolOutcome", () => {
  it("Bash: status, line count and the end of the output", () => {
    const stdout = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = toolOutcome("Bash", { command: "npm test" }, { stdout, stderr: "warn: x", interrupted: false }, stdout, false);
    expect(out.summary).toBe("✓ · 14 lines");
    expect(out.detail).toContain("*… 4 lines above*");
    expect(out.detail).toContain("line 5\n");
    expect(out.detail).not.toContain("line 4\n");
    expect(out.detail).toContain("*stderr:*");
    expect(toolOutcome("Bash", {}, { stdout: "", interrupted: true }, "", false).summary).toBe("⊘ interrupted");
    expect(toolOutcome("Bash", {}, { stdout: "", backgroundTaskId: "b1" }, "", false).summary).toBe("⏱ background");
  });

  it("errors and denials", () => {
    const failed = toolOutcome("Bash", {}, "Error: Exit code 1", "Exit code 1\nnpm ERR! missing script", true);
    expect(failed).toMatchObject({ status: "error", summary: "✗ Exit code 1" });
    const denied = toolOutcome("Edit", {}, undefined, "The user doesn't want to proceed with this tool use. The tool use was rejected. the user said:\nuse a map", true);
    expect(denied).toMatchObject({ status: "denied", summary: "⊘ denied", feedback: "use a map" });
  });

  it("Read, Edit and Write", () => {
    const read = (file: object) => toolOutcome("Read", {}, { type: "text", file }, "", false).summary;
    expect(read({ startLine: 85, numLines: 61, totalLines: 300 })).toBe("lines 85–145 of 300");
    expect(read({ startLine: 1, numLines: 40, totalLines: 40 })).toBe("40 lines");
    expect(toolOutcome("Read", {}, { type: "image", file: {} }, "", false).summary).toBe("image");
    const patch = [{ lines: [" a", "-b", "+c", "+d"] }];
    expect(toolOutcome("Edit", {}, { structuredPatch: patch }, "", false).summary).toBe("+2 −1");
    expect(toolOutcome("Write", { content: "x\ny\n" }, { type: "create", structuredPatch: [] }, "", false).summary).toBe("created, 2 lines");
    expect(toolOutcome("Write", {}, { type: "update", structuredPatch: patch }, "", false).summary).toBe("+2 −1");
  });

  it("Grep, Glob, WebSearch and ToolSearch", () => {
    const files = [join(cwd, "src", "a.ts"), join(cwd, "src", "b.ts")];
    const grep = toolOutcome("Grep", {}, { mode: "files_with_matches", filenames: files, numFiles: 2 }, "", false, cwd);
    expect(grep.summary).toBe("2 files");
    expect(grep.detail).toBe("- `src/a.ts`\n- `src/b.ts`");
    expect(toolOutcome("Grep", {}, { mode: "count", numFiles: 3, numMatches: 1 }, "", false).summary).toBe("1 match in 3 files");
    expect(toolOutcome("Grep", {}, { mode: "content", numFiles: 0, numLines: 0 }, "", false).summary).toBe("no matches");
    expect(toolOutcome("Glob", {}, { filenames: [], numFiles: 0 }, "", false).summary).toBe("no files");
    expect(toolOutcome("Grep", {}, { mode: "count", numFiles: 1, numMatches: 5 }, "", false).summary).toBe("5 matches in 1 file");
    const glob = toolOutcome("Glob", {}, { filenames: Array(7).fill("x.ts"), numFiles: 7, truncated: false }, "", false);
    expect(glob.summary).toBe("7 files");
    expect(glob.detail).toContain("*… 2 more*");
    const search = toolOutcome("WebSearch", {}, { results: [{ content: [{ title: "Ink docs", url: "https://ink.dev" }] }, "summary"] }, "", false);
    expect(search.summary).toBe("1 result");
    expect(search.detail).toBe("- Ink docs  \n  https://ink.dev");
    expect(toolOutcome("ToolSearch", {}, { matches: ["WebFetch", "mcp__chrome__navigate"] }, "", false).summary).toBe("loaded WebFetch, chrome · navigate");
  });
});

describe("toolMarkdown", () => {
  const question = {
    questions: [
      {
        question: "Where should it open?",
        header: "Place",
        options: [
          { label: "Right (Recommended)", description: "as today" },
          { label: "Left", description: "swap" },
        ],
      },
    ],
  };

  it("shows a question block with its options and the answer, even with tools off", () => {
    const outcome = toolOutcome("AskUserQuestion", question, { answers: { "Where should it open?": "Left" }, annotations: { "Where should it open?": { notes: "keep it simple" } } }, "", false);
    const md = toolMarkdown("AskUserQuestion", question, outcome, "off");
    // Badge with the header, the chosen option marked and bold, the others dimmed, the answer as "You:".
    expect(md).toContain("\u001b[7m\u001b[33m\u00a0Place\u00a0\u001b[39m\u001b[27m Where should it open?");
    expect(md).toContain("- \u001b[2m○ Right (Recommended) — as today\u001b[22m");
    expect(md).toContain("- \u001b[32m●\u001b[39m **Left** — *swap*");
    expect(md).toContain("\u001b[32m┃ You: Left\u001b[39m");
    expect(md).toContain("note: keep it simple");
    expect(stripBoxes(md)).toBe(" Place  Where should it open?\n\n- ○ Right (Recommended) — as today\n- ● **Left** — *swap*\n\n┃ You: Left  \n┃ note: keep it simple");
    const unanswered = toolOutcome("AskUserQuestion", question, undefined, "The user doesn't want to proceed", true);
    expect(stripBoxes(toolMarkdown("AskUserQuestion", question, unanswered, "off"))).toContain("┃ not answered");
  });

  it("numbers several questions, separates them, and marks a typed answer", () => {
    const two = { questions: [{ question: "A?", header: "One", options: [{ label: "x" }] }, { question: "B?", options: [{ label: "y" }] }] };
    const md = stripBoxes(toolMarkdown("AskUserQuestion", two, toolOutcome("AskUserQuestion", two, { answers: { "A?": "x", "B?": "something else" } }, "", false), "off"));
    expect(md).toBe(" 1/2 One  A?\n\n- ● **x**\n\n┃ You: x\n\n---\n\n 2/2  B?\n\n- ○ y\n\n┃ You: something else (own answer)");
  });

  it("compact: one line with the result; full: command and output", () => {
    const input = { command: "npm test", description: "Run the tests" };
    const outcome = toolOutcome("Bash", input, { stdout: "ok" }, "ok", false);
    expect(toolMarkdown("Bash", input, outcome, "off")).toBe("");
    expect(toolMarkdown("Bash", input, outcome, "compact")).toBe("**⚙ Bash** *Run the tests* · ✓ · 1 line");
    expect(toolMarkdown("Bash", input, outcome, "full")).toBe("**⚙ Bash** *Run the tests* · ✓ · 1 line\n\n```sh\nnpm test\n```\n\n```\nok\n```");
    const read = toolOutcome("Read", {}, { type: "text", file: { startLine: 1, numLines: 3, totalLines: 3 } }, "", false);
    expect(toolMarkdown("Read", { file_path: join(cwd, "src", "open.ts") }, read, "compact", cwd)).toBe("**⚙ Read** `src/open.ts` · 3 lines");
    expect(toolMarkdown("mcp__chrome__navigate", { url: "https://x.io" }, undefined, "compact")).toBe("**⚙ chrome · navigate** `https://x.io`");
  });

  it("ExitPlanMode: the decision", () => {
    expect(toolMarkdown("ExitPlanMode", {}, { status: "ok" }, "compact")).toBe("**▤ Plan presented** → approved *(3 Plan view)*");
    expect(toolMarkdown("ExitPlanMode", {}, { status: "denied", feedback: "smaller" }, "compact")).toBe("**▤ Plan presented** → rejected: smaller *(3 Plan view)*");
  });
});

describe("parser", () => {
  const line = (e: object) => JSON.stringify(e) + "\n";

  it("gives a tool call its outcome when the result arrives, and shows questions with tools off", () => {
    const q = { questions: [{ question: "Go?", header: "Go", options: [{ label: "Yes" }] }] };
    const p = new TranscriptParser();
    p.push(
      line({ type: "user", uuid: "u", message: { role: "user", content: "start" } }) +
        line({ type: "assistant", cwd, message: { id: "m", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: join(cwd, "a.ts") } }] } }) +
        line({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "AskUserQuestion", input: q }] } }),
    );
    expect(p.turns[0].blocks.map((b) => (b.kind === "tool" ? b.outcome : "x"))).toEqual([undefined, undefined]);
    const changed = p.push(
      line({ type: "user", toolUseResult: { type: "text", file: { startLine: 1, numLines: 2, totalLines: 2 } }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "…" }] } }) +
        line({ type: "user", toolUseResult: { answers: { "Go?": "Yes" } }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "…" }] } }),
    );
    expect(changed).toBe(true);
    expect(stripBoxes(turnMarkdown(p.turns[0], { tools: "off", thinking: false }))).toBe(" Go  Go?\n\n- ● **Yes**\n\n┃ You: Yes");
    expect(turnMarkdown(p.turns[0], { tools: "compact", thinking: false })).toContain("**⚙ Read** `a.ts` · 2 lines");
  });
});

describe("framed questions", () => {
  const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

  it("draws the question in a frame, narrower than the pane, between the text around it", () => {
    const md = "Before.\n\nClaude asks\n**? Go** — Go?\n\n**→ Yes**\n\n\nAfter.";
    expect(renderMarkdown(md, 30).map(strip)).toEqual([
      "Before.",
      "",
      "╭─ Claude asks ───────────────",
      "│ ? Go — Go?",
      "│ ",
      "│ → Yes",
      "╰─────────────────────────────",
      "",
      "After.",
    ]);
    expect(stripBoxes(md)).toBe("Before.\n\n**? Go** — Go?\n\n**→ Yes**\n\nAfter.");
  });
});
