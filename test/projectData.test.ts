import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toggleFavorite } from "../src/favorites.js";
import { readPositions, savePositions, suspendPositionWrites } from "../src/positions.js";
import { clearProjectData, projectData } from "../src/projectData.js";
import { saveSessionView } from "../src/sessionViews.js";
import { settingsFile, updateSettings } from "../src/settings.js";
import { activeFile, writeJson } from "../src/transcript/locate.js";

const cwd = join(tmpdir(), "cco-data-project");
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-data-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
  suspendPositionWrites(false);
});

describe("project data reset", () => {
  it("deletes marks, positions, views and restore state, and keeps settings and hook state", () => {
    toggleFavorite(cwd, "turns", "t1");
    savePositions(cwd, "chat", { selected: "t1", scroll: {} });
    saveSessionView(cwd, "s1", "git");
    updateSettings({ marquee: false });
    writeJson(activeFile(cwd), { session_id: "s1" });
    expect(projectData(cwd).map((d) => d.name)).toHaveLength(3);

    expect(clearProjectData(cwd)).toHaveLength(3);
    expect(projectData(cwd)).toEqual([]);
    expect(readPositions(cwd, "chat")).toEqual({ scroll: {} });
    expect(existsSync(settingsFile())).toBe(true);
    expect(existsSync(activeFile(cwd))).toBe(true);
  });

  it("does not write positions while suspended", () => {
    suspendPositionWrites(true);
    savePositions(cwd, "chat", { selected: "t1", scroll: {} });
    expect(projectData(cwd)).toEqual([]);
    suspendPositionWrites(false);
    savePositions(cwd, "chat", { selected: "t1", scroll: {} });
    expect(readPositions(cwd, "chat").selected).toBe("t1");
  });
});
