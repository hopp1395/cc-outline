import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectDir } from "../src/transcript/locate.js";
import { displayPath, formatDuration, insideProject, SessionIndex, SessionReader } from "../src/transcript/sessions.js";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const prompt = (uuid: string, time: string, text: string, branch = "main") =>
  line({
    type: "user",
    uuid,
    timestamp: `2026-09-26T${time}:00.000Z`,
    gitBranch: branch,
    cwd: "/repo",
    message: { role: "user", content: text },
  });
const tool = (id: string, time: string, name: string, input: unknown) =>
  line({
    type: "assistant",
    uuid: `a-${id}`,
    timestamp: `2026-09-26T${time}:00.000Z`,
    message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
const result = (id: string, isError: boolean) =>
  line({
    type: "user",
    uuid: `r-${id}`,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "" }] },
  });

describe("SessionReader", () => {
  it("summarizes title, prompts, plans, changed files, branch and time span", () => {
    const reader = new SessionReader(join(tmpdir(), "s1.jsonl"));
    const s = reader.push(
      line({ type: "custom-title", customTitle: "orders", sessionId: "s1" }) +
        prompt("u1", "09:00", "Plan the validation") +
        tool("p1", "09:02", "ExitPlanMode", { plan: "# Validate orders" }) +
        result("p1", false) +
        tool("e1", "09:05", "Edit", { file_path: "/repo/src/a.cs" }) +
        tool("e2", "09:06", "Write", { file_path: "/repo/src/b.cs" }) +
        tool("e3", "09:07", "Edit", { file_path: "/repo/src/a.cs" }) +
        tool("r1", "09:08", "Read", { file_path: "/repo/src/c.cs" }) +
        prompt("u2", "10:30", "Run the tests", "feature/x"),
    );
    expect(s).toMatchObject({
      id: "s1",
      title: "orders",
      prompts: [
        { text: "Plan the validation", timestamp: "2026-09-26T09:00:00.000Z" },
        { text: "Run the tests", timestamp: "2026-09-26T10:30:00.000Z" },
      ],
      files: ["/repo/src/a.cs", "/repo/src/b.cs"],
      branch: "feature/x",
      cwd: "/repo",
      start: "2026-09-26T09:00:00.000Z",
      end: "2026-09-26T10:30:00.000Z",
    });
    expect(s.plans.map((p) => p.status)).toEqual(["approved"]);
  });

  it("ignores subagent entries", () => {
    const s = new SessionReader("x.jsonl").push(
      prompt("u1", "09:00", "Go") +
        line({ ...JSON.parse(tool("e1", "11:00", "Edit", { file_path: "/sub.cs" })), isSidechain: true }),
    );
    expect(s.files).toEqual([]);
    expect(s.end).toBe("2026-09-26T09:00:00.000Z");
  });
});

describe("SessionIndex", () => {
  let saved: string | undefined;
  const cwd = join(tmpdir(), "cco-sessions-project");
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-sessions-"));
    mkdirSync(projectDir(cwd), { recursive: true });
  });
  afterEach(() => {
    process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it("lists sessions with prompts oldest first, skipping bookkeeping files", async () => {
    const dir = projectDir(cwd);
    writeFileSync(join(dir, "late.jsonl"), prompt("u1", "12:00", "Later"));
    writeFileSync(join(dir, "early.jsonl"), prompt("u1", "08:00", "Earlier"));
    writeFileSync(join(dir, "bridge.jsonl"), line({ type: "bridge-session", sessionId: "bridge" }));
    // Only slash commands, nothing changed: left out.
    writeFileSync(join(dir, "resume.jsonl"), prompt("u1", "09:00", "<command-name>/resume</command-name>"));
    // A slash command that changed files counts.
    writeFileSync(
      join(dir, "cmd.jsonl"),
      prompt("u1", "10:00", "<command-name>/fix</command-name>") + tool("e1", "10:01", "Edit", { file_path: "/a.cs" }),
    );
    const sessions = await new SessionIndex(cwd).scan();
    expect(sessions.map((s) => s.id)).toEqual(["early", "cmd", "late"]);
  });

  it("reads only what was appended to a growing transcript", async () => {
    const file = join(projectDir(cwd), "live.jsonl");
    writeFileSync(file, prompt("u1", "09:00", "First"));
    const index = new SessionIndex(cwd);
    expect((await index.scan())[0].prompts).toHaveLength(1);
    // Written in two parts, the second completing a line split mid-way.
    const next = prompt("u2", "09:10", "Second");
    appendFileSync(file, next.slice(0, 20));
    expect((await index.scan())[0].prompts).toHaveLength(1);
    appendFileSync(file, next.slice(20));
    const [s] = await index.scan();
    expect(s.prompts.map((p) => p.text)).toEqual(["First", "Second"]);
    expect(s.end).toBe("2026-09-26T09:10:00.000Z");
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatDuration("2026-09-26T09:00:00Z", "2026-09-26T09:00:20Z")).toBe("< 1 min");
    expect(formatDuration("2026-09-26T09:00:00Z", "2026-09-26T09:12:00Z")).toBe("12 min");
    expect(formatDuration("2026-09-26T09:00:00Z", "2026-09-26T11:05:00Z")).toBe("2 h 05 min");
    expect(formatDuration(undefined, "2026-09-26T11:05:00Z")).toBeUndefined();
  });

  it("shows paths inside the project relative to it", () => {
    const cwd = join(tmpdir(), "proj");
    expect(displayPath(join(cwd, "src", "a.cs"), cwd)).toBe("src/a.cs");
    expect(displayPath(join(homedir(), "notes", "b.md"), cwd)).toBe("~/notes/b.md");
    expect(insideProject(join(cwd, "src", "a.cs"), cwd)).toBe(true);
    expect(insideProject(join(cwd, "..", "other", "b.cs"), cwd)).toBe(false);
  });
});
