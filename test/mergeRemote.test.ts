import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/transcript/sessions.js";
import type { RunningSession } from "../src/transcript/trash.js";
import { bridgeKey, mergeRemote } from "../src/tui/useSessionData.js";

const local = (id: string, bridgeIds?: string[]): SessionSummary => ({ id, path: `${id}.jsonl`, prompts: [], plans: [], files: [], ...(bridgeIds && { bridgeIds }) }) as SessionSummary;
const remote = (id: string, refs?: string[]): SessionSummary => ({ id, path: id, prompts: [], plans: [], files: [], remote: { refs } }) as unknown as SessionSummary;

describe("mergeRemote", () => {
  it("strips the prefix of a bridge id", () => {
    expect(bridgeKey("session_01DBk")).toBe("01DBk");
    expect(bridgeKey("cse_01DBk")).toBe("01DBk");
  });

  it("takes a transcript's bridge id without a running Claude Code", () => {
    const { twins, merged } = mergeRemote([local("a", ["cse_1"])], [remote("cse_1")]);
    expect(twins.get("a")?.id).toBe("cse_1");
    expect(merged.map((s) => s.id)).toEqual(["a"]);
  });

  // A session continued from Ended wrote the other one's bridge id into its transcript: both showed its question.
  it("gives a remote session only to the Claude Code that names it connected", () => {
    const read = [local("connected", ["cse_1"]), local("continued", ["cse_0", "cse_1"])];
    const running = new Map<string, RunningSession>([
      ["connected", { pid: 1, bridge: "session_1" }],
      ["continued", { pid: 2 }],
    ]);
    const { twins } = mergeRemote(read, [remote("cse_1", ["continued"])], running);
    expect(twins.get("connected")?.id).toBe("cse_1");
    expect(twins.has("continued")).toBe(false);
  });

  it("leaves a session connected elsewhere out of the transcripts' twins", () => {
    const read = [local("a", ["cse_1"])];
    const running = new Map<string, RunningSession>([["a", { pid: 1, bridge: "session_2" }]]);
    const { twins, merged } = mergeRemote(read, [remote("cse_1"), remote("cse_2")], running);
    expect(twins.get("a")?.id).toBe("cse_2");
    expect(merged.map((s) => s.id).sort()).toEqual(["a", "cse_1"]);
  });
});
