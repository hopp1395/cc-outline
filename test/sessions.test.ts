import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectDir } from "../src/transcript/locate.js";
import { displayPath, formatDuration, insideProject, lastActive, SessionIndex, SessionReader } from "../src/transcript/sessions.js";

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
/** Writes a transcript and dates its last write to `time` of the day the entries are from. */
const transcript = (path: string, text: string, time: string) => {
  writeFileSync(path, text);
  const at = new Date(`2026-09-26T${time}:00.000Z`);
  utimesSync(path, at, at);
};
const result = (id: string, isError: boolean) =>
  line({
    type: "user",
    uuid: `r-${id}`,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "" }] },
  });

describe("SessionReader", () => {
  it("lists subagents and leaves task notifications out of the prompts", () => {
    const reader = new SessionReader(join(tmpdir(), "s-agents.jsonl"));
    const s = reader.push(
      prompt("u1", "09:00", "Map the repo") +
        tool("t1", "09:01", "Agent", { description: "Map", subagent_type: "Explore", run_in_background: true }) +
        line({
          type: "user",
          uuid: "n1",
          message: {
            role: "user",
            content:
              "<task-notification>\n<tool-use-id>t1</tool-use-id>\n<status>completed</status>\n<summary>Agent \"Map\" finished</summary>\n<usage><duration_ms>65000</duration_ms></usage>\n</task-notification>",
          },
        }),
    );
    expect(s.prompts.map((p) => p.text)).toEqual(["Map the repo"]);
    expect(s.agents).toEqual([
      { description: "Map", type: "Explore", status: "completed", started: "2026-09-26T09:01:00.000Z", durationMs: 65000 },
    ]);
  });

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
    transcript(join(dir, "late.jsonl"), prompt("u1", "12:00", "Later"), "12:00");
    transcript(join(dir, "early.jsonl"), prompt("u1", "08:00", "Earlier"), "08:00");
    writeFileSync(join(dir, "bridge.jsonl"), line({ type: "bridge-session", sessionId: "bridge" }));
    // Only slash commands, nothing changed: left out.
    writeFileSync(join(dir, "resume.jsonl"), prompt("u1", "09:00", "<command-name>/resume</command-name>"));
    // A slash command that changed files counts.
    transcript(join(dir, "cmd.jsonl"), prompt("u1", "10:00", "<command-name>/fix</command-name>") + tool("e1", "10:01", "Edit", { file_path: "/a.cs" }), "10:01");
    const sessions = await new SessionIndex().scan(cwd);
    expect(sessions.map((s) => s.id)).toEqual(["early", "cmd", "late"]);
  });

  it("orders sessions by their transcript's last write, whatever wrote it", async () => {
    const dir = projectDir(cwd);
    // Started first, written to last.
    transcript(join(dir, "long.jsonl"), prompt("u1", "08:00", "Start") + prompt("u2", "13:00", "Go on"), "13:00");
    // Asked early, but Claude worked late and a slash command came later still: that counts too.
    transcript(
      join(dir, "busy.jsonl"),
      prompt("u1", "11:00", "Work") + tool("e1", "14:00", "Edit", { file_path: "/a.cs" }) + prompt("u2", "15:00", "<command-name>/rename</command-name>"),
      "15:00",
    );
    // Imported just now: the last write, not the entries' time.
    transcript(join(dir, "cmd.jsonl"), prompt("u1", "10:00", "<command-name>/fix</command-name>") + tool("e1", "12:00", "Edit", { file_path: "/b.cs" }), "16:00");
    const sessions = await new SessionIndex().scan(cwd);
    expect(sessions.map((s) => s.id)).toEqual(["long", "busy", "cmd"]);
    expect(sessions.map(lastActive)).toEqual(["2026-09-26T13:00:00.000Z", "2026-09-26T15:00:00.000Z", "2026-09-26T16:00:00.000Z"]);
  });

  it("dates a session without a readable last write by its last entry", () => {
    const s = new SessionReader("x.jsonl").push(prompt("u1", "09:00", "Go") + tool("e1", "09:30", "Edit", { file_path: "/a.cs" }));
    expect(lastActive(s)).toBe("2026-09-26T09:30:00.000Z");
  });

  it("reads only the transcripts written since a time, and the rest later", async () => {
    const dir = projectDir(cwd);
    writeFileSync(join(dir, "old.jsonl"), prompt("u1", "08:00", "Old"));
    writeFileSync(join(dir, "new.jsonl"), prompt("u1", "09:00", "New"));
    const since = Date.now() - 86_400_000;
    const old = new Date(since - 86_400_000);
    utimesSync(join(dir, "old.jsonl"), old, old);
    const index = new SessionIndex();
    expect((await index.scan(cwd, undefined, since)).map((s) => s.id)).toEqual(["new"]);
    expect((await index.scan(cwd)).map((s) => s.id)).toEqual(["old", "new"]);
  });

  it("lists the sessions of all projects without a cwd", async () => {
    transcript(join(projectDir(cwd), "here.jsonl"), prompt("u1", "09:00", "Here"), "09:00");
    const other = join(tmpdir(), "cco-sessions-other");
    mkdirSync(projectDir(other), { recursive: true });
    transcript(join(projectDir(other), "there.jsonl"), prompt("u1", "08:00", "There"), "08:00");
    const index = new SessionIndex();
    expect((await index.scan(cwd)).map((s) => s.id)).toEqual(["here"]);
    const seen: number[] = [];
    const all = await index.scan(undefined, (_s, done) => seen.push(done));
    expect(all.map((s) => s.id)).toEqual(["there", "here"]);
  });

  it("keeps no answer text in memory, only what the overview shows", () => {
    const reader = new SessionReader("x.jsonl");
    reader.push(prompt("u1", "09:00", "Go") + tool("e1", "09:01", "Edit", { file_path: "/a.cs" }));
    const s = reader.push(tool("e2", "09:02", "Write", { file_path: "/b.cs" }));
    expect(s.files).toEqual(["/a.cs", "/b.cs"]);
    // The parser's turns carry no blocks any more.
    expect((reader as unknown as { parser: { turns: { blocks: unknown[] }[] } }).parser.turns[0].blocks).toEqual([]);
  });

  it("reads only what was appended to a growing transcript", async () => {
    const file = join(projectDir(cwd), "live.jsonl");
    writeFileSync(file, prompt("u1", "09:00", "First"));
    const index = new SessionIndex();
    expect((await index.scan(cwd))[0].prompts).toHaveLength(1);
    // Written in two parts, the second completing a line split mid-way.
    const next = prompt("u2", "09:10", "Second");
    appendFileSync(file, next.slice(0, 20));
    expect((await index.scan(cwd))[0].prompts).toHaveLength(1);
    appendFileSync(file, next.slice(20));
    const [s] = await index.scan(cwd);
    expect(s.prompts.map((p) => p.text)).toEqual(["First", "Second"]);
    expect(s.end).toBe("2026-09-26T09:10:00.000Z");
  });

  it("shows a session that went on under another id as one, with the later id", async () => {
    const dir = projectDir(cwd);
    const compact = prompt("c", "09:30", "<command-name>/compact</command-name>");
    writeFileSync(
      join(dir, "old.jsonl"),
      prompt("u1", "09:00", "Plan it") +
        tool("e1", "09:05", "Edit", { file_path: "/a.cs" }) +
        compact +
        line({ type: "continued-in", continuedInSessionId: "new" }),
    );
    // Starts with the compact boundary and a copy of the last entry, then only a slash command.
    writeFileSync(
      join(dir, "new.jsonl"),
      line({ type: "system", subtype: "compact_boundary", uuid: "b", timestamp: "2026-09-26T09:31:00.000Z" }) +
        compact +
        prompt("u2", "10:00", "<command-name>/model</command-name>"),
    );
    const sessions = await new SessionIndex().scan(cwd);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "new",
      continues: ["old"],
      files: ["/a.cs"],
      start: "2026-09-26T09:00:00.000Z",
      end: "2026-09-26T10:00:00.000Z",
    });
    expect(sessions[0].prompts.map((p) => p.text)).toEqual(["Plan it", "/compact", "/model"]);
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
