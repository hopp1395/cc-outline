import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SESSION_VIEWS, readSessionView, saveSessionView } from "../src/sessionViews.js";
import { readJson, sessionViewsFile, writeJson } from "../src/transcript/locate.js";

const cwd = join(tmpdir(), "cco-views-project");
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-views-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("view per session", () => {
  it("keeps each session's last view", () => {
    expect(readSessionView(cwd, "a")).toBeUndefined();
    saveSessionView(cwd, "a", "git");
    saveSessionView(cwd, "b", "plan");
    saveSessionView(cwd, "a", "sessions");
    expect(readSessionView(cwd, "a")).toBe("sessions");
    expect(readSessionView(cwd, "b")).toBe("plan");
    expect(readSessionView(cwd, undefined)).toBeUndefined();
  });

  it("ignores unknown views", () => {
    writeJson(sessionViewsFile(cwd), { a: "diff", b: 3, c: "chat" });
    expect([readSessionView(cwd, "a"), readSessionView(cwd, "b"), readSessionView(cwd, "c")]).toEqual([undefined, undefined, "chat"]);
  });

  it("drops the sessions shown longest ago", () => {
    for (let i = 0; i < MAX_SESSION_VIEWS + 3; i++) saveSessionView(cwd, `s${i}`, "chat");
    saveSessionView(cwd, "s5", "git");
    saveSessionView(cwd, "new", "plan");
    const ids = Object.keys(readJson<Record<string, string>>(sessionViewsFile(cwd))!);
    expect(ids).toHaveLength(MAX_SESSION_VIEWS);
    // s0–s2 went when s500–s502 came, s3 when "new" came; s5 was shown again and stays.
    expect(ids).toContain("s5");
    expect(ids).not.toContain("s3");
    expect(ids).toContain("s4");
    expect(ids.at(-1)).toBe("new");
  });
});
