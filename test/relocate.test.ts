import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportSessions, importArchive, importSummary } from "../src/export/archive.js";
import { moveSession } from "../src/export/move.js";
import { relocatePath, relocateText, type Relocation } from "../src/export/relocate.js";
import { readFavorites, toggleFavorite } from "../src/favorites.js";
import { readSessionView, saveSessionView } from "../src/sessionViews.js";
import { claudeDir, projectDir, projectSlug } from "../src/transcript/locate.js";
import { SessionReader } from "../src/transcript/sessions.js";

const line = (entry: object) => JSON.stringify(entry) + "\n";
const base = (r: Partial<Relocation>): Relocation => ({ to: "D:\\src\\shop", claudeTo: "D:\\home\\.claude", slugFrom: "old", slugTo: "new", ids: new Map(), ...r });

describe("relocateText", () => {
  it("rewrites every spelling of a Windows folder into the same spelling of the new one, whole parts only", () => {
    const r = base({ from: "C:\\Workspace\\shop" });
    const json = JSON.stringify({ cwd: "C:\\Workspace\\shop", file: "c:\\workspace\\SHOP\\src\\a.cs", other: "C:\\Workspace\\shop2\\x", slash: "C:/Workspace/shop/b.cs", bash: "cd /c/Workspace/shop && ls" });
    expect(JSON.parse(relocateText(json, r, true))).toEqual({
      cwd: "D:\\src\\shop",
      file: "D:\\src\\shop\\src\\a.cs",
      other: "C:\\Workspace\\shop2\\x",
      slash: "D:/src/shop/b.cs",
      bash: "cd /d/src/shop && ls",
    });
  });

  it("goes from Windows to POSIX and back", () => {
    const toPosix = base({ from: "C:\\Workspace\\shop", to: "/home/me/shop" });
    expect(JSON.parse(relocateText(JSON.stringify({ cwd: "C:\\Workspace\\shop", f: "/c/Workspace/shop/a" }), toPosix, true))).toEqual({ cwd: "/home/me/shop", f: "/home/me/shop/a" });
    const toWindows = base({ from: "/home/me/shop" });
    expect(JSON.parse(relocateText(JSON.stringify({ cwd: "/home/me/shop", f: "/home/me/shop/a", g: "/x/home/me/shop" }), toWindows, true))).toEqual({
      cwd: "D:\\src\\shop",
      f: "D:\\src\\shop/a",
      g: "/x/home/me/shop",
    });
  });

  it("rewrites ~/.claude before the folder, the slug below projects and the ids", () => {
    const r = base({ from: "C:\\Users\\me", to: "D:\\me", claudeFrom: "C:\\Users\\me\\.claude", claudeTo: "D:\\me\\.claude", ids: new Map([["id-1", "id-2"]]) });
    const json = JSON.stringify({ sessionId: "id-1", path: "C:\\Users\\me\\.claude\\projects\\old\\id-1\\tool-results\\a.jpg", cwd: "C:\\Users\\me", slug: "old" });
    expect(JSON.parse(relocateText(json, r, true))).toEqual({ sessionId: "id-2", path: "D:\\me\\.claude\\projects\\new\\id-2\\tool-results\\a.jpg", cwd: "D:\\me", slug: "old" });
  });

  it("puts files below the new slug and ids", () => {
    const r = base({ ids: new Map([["id-1", "id-2"]]) });
    expect(relocatePath("projects/old/id-1.jsonl", r)).toBe("projects/new/id-2.jsonl");
    expect(relocatePath("projects/old/id-1/subagents/agent-a.jsonl", r)).toBe("projects/new/id-2/subagents/agent-a.jsonl");
    expect(relocatePath("file-history/id-1/v1", r)).toBe("file-history/id-2/v1");
    expect(relocatePath("uploads/x.png", r)).toBe("uploads/x.png");
  });
});

describe("importing and moving into another folder", () => {
  let saved: string | undefined;
  let out: string;
  const from = join(tmpdir(), "cco-relocate-from");
  const to = join(tmpdir(), "cco-relocate-to");
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-relocate-"));
    out = mkdtempSync(join(tmpdir(), "cco-relocate-out-"));
    mkdirSync(projectDir(from), { recursive: true });
  });
  afterEach(() => {
    process.env.CLAUDE_CONFIG_DIR = saved;
  });

  function writeSession(id: string) {
    const path = join(projectDir(from), `${id}.jsonl`);
    writeFileSync(
      path,
      line({ type: "user", uuid: "u1", sessionId: id, timestamp: "2026-10-02T10:00:00.000Z", cwd: from, message: { role: "user", content: `Fix ${join(from, "a.cs")}` } }) +
        line({ type: "assistant", uuid: "a1", sessionId: id, timestamp: "2026-10-02T10:01:00.000Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" } }),
    );
    mkdirSync(join(projectDir(from), id, "subagents"), { recursive: true });
    writeFileSync(join(projectDir(from), id, "subagents", "agent-x.jsonl"), line({ type: "user", uuid: "s1", isSidechain: true, cwd: from, message: { role: "user", content: "go" } }));
    mkdirSync(join(claudeDir(), "file-history", id), { recursive: true });
    writeFileSync(join(claudeDir(), "file-history", id, "v1"), `kept ${from}`);
    return new SessionReader(path).update();
  }

  it("imports into the current folder with its paths rewritten, under new ids when they are taken elsewhere", async () => {
    const s = writeSession("aaaaaaaa-1111");
    toggleFavorite(from, "turns", "u1");
    const { file } = await exportSessions([s], { tools: "compact", thinking: false, agents: "reports", stats: true }, { viewerCwd: from, dir: out });
    const result = importArchive(file, to);
    expect(result.imported).toHaveLength(1);
    const { id, from: was } = result.imported[0]!;
    expect(was).toBe("aaaaaaaa-1111");
    expect(id).not.toBe(was);
    expect(importSummary(result)).toBe("imported 1 session · 1 with a new id");
    const text = readFileSync(join(projectDir(to), `${id}.jsonl`), "utf8");
    expect(text).not.toContain(was);
    const first = JSON.parse(text.split("\n")[0]!);
    expect(first.cwd).toBe(to);
    expect(first.sessionId).toBe(id);
    expect(first.message.content).toBe(`Fix ${join(to, "a.cs")}`);
    expect(JSON.parse(readFileSync(join(projectDir(to), id, "subagents", "agent-x.jsonl"), "utf8")).cwd).toBe(to);
    // The file history moves to the new id, as it was.
    expect(readFileSync(join(claudeDir(), "file-history", id, "v1"), "utf8")).toBe(`kept ${from}`);
    expect(readFavorites(to, "turns")).toEqual(["u1"]);
    // Imported again into the same folder: there already.
    expect(importArchive(file, to).skipped.map((x) => x.reason)).toEqual(["already there"]);
  });

  it("keeps the ids on another machine, where they are free", async () => {
    const s = writeSession("bbbbbbbb-2222");
    const { file } = await exportSessions([s], { tools: "compact", thinking: false, agents: "reports", stats: true }, { viewerCwd: from, dir: out });
    rmSync(claudeDir(), { recursive: true, force: true });
    const result = importArchive(file, to);
    expect(result.imported).toEqual([{ id: "bbbbbbbb-2222", title: expect.any(String) }]);
    expect(JSON.parse(readFileSync(join(projectDir(to), "bbbbbbbb-2222.jsonl"), "utf8").split("\n")[0]!).cwd).toBe(to);
    expect(importArchive(file, to).skipped.map((x) => x.reason)).toEqual(["already there"]);
  });

  it("moves a session into another folder with its ids, marks and view, and leaves nothing behind", () => {
    const s = writeSession("cccccccc-3333");
    toggleFavorite(from, "turns", "u1");
    saveSessionView(from, s.id, "plan");
    moveSession(s, to);
    expect(existsSync(projectDir(from))).toBe(false);
    const text = readFileSync(join(projectDir(to), "cccccccc-3333.jsonl"), "utf8");
    expect(JSON.parse(text.split("\n")[0]!).cwd).toBe(to);
    expect(existsSync(join(projectDir(to), "cccccccc-3333", "subagents", "agent-x.jsonl"))).toBe(true);
    expect(readFileSync(join(claudeDir(), "file-history", "cccccccc-3333", "v1"), "utf8")).toBe(`kept ${from}`);
    expect(readFavorites(to, "turns")).toEqual(["u1"]);
    expect(readFavorites(from, "turns")).toEqual([]);
    expect(readSessionView(to, s.id)).toBe("plan");
    expect(readSessionView(from, s.id)).toBeUndefined();
    expect(projectSlug(to)).not.toBe(projectSlug(from));
  });
});
