import { describe, expect, it } from "vitest";
import { paneOf, parsePanes, resumeHereMethod, resumeSlashCommand } from "../src/switchSession.js";

describe("switching to a running session", () => {
  const panes = parsePanes("100 %1\n200 %2\n\n");

  it("reads tmux's panes by process id", () => {
    expect(panes).toEqual(new Map([[100, "%1"], [200, "%2"]]));
  });

  it("finds the pane of the process or of its nearest ancestor", async () => {
    const parents = new Map([[300, 250], [250, 200], [200, 1]]);
    const parentOf = async (pid: number) => parents.get(pid);
    expect(await paneOf(100, panes, parentOf)).toBe("%1");
    expect(await paneOf(300, panes, parentOf)).toBe("%2");
    expect(await paneOf(400, panes, parentOf)).toBeUndefined();
  });
});

describe("continuing a session in the viewer's Claude Code", () => {
  it("types the command in under tmux and on Windows, else copies it", () => {
    expect(resumeHereMethod("tmux", "linux")).toBe("keys");
    expect(resumeHereMethod("wt", "win32")).toBe("keys");
    expect(resumeHereMethod(undefined, "win32")).toBe("keys");
    expect(resumeHereMethod(undefined, "darwin")).toBe("clipboard");
    expect(resumeSlashCommand("abc")).toBe("/resume abc");
  });
});
