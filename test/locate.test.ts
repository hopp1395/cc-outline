import { describe, expect, it } from "vitest";
import { projectSlug } from "../src/transcript/locate.js";

const win = process.platform === "win32";

describe("projectSlug", () => {
  it("replaces every non-alphanumeric character", () => {
    expect(projectSlug(win ? "W:\\repos\\claude-code-markdown" : "/repos/claude-code-markdown")).toBe(
      win ? "W--repos-claude-code-markdown" : "-repos-claude-code-markdown",
    );
    expect(projectSlug(win ? "C:\\Kopfhörer" : "/Kopfhörer")).toMatch(/-Kopfh-rer$/);
  });
});
