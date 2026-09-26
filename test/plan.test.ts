import { describe, expect, it } from "vitest";
import { diffLines } from "../src/git/linediff.js";
import { TranscriptParser } from "../src/transcript/parse.js";
import { draftPlan, planTitle } from "../src/tui/PlanView.js";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const prompt = (uuid: string, text: string) =>
  line({ type: "user", uuid, timestamp: "2026-09-26T08:00:00.000Z", message: { role: "user", content: text } });
const exitPlan = (id: string, plan: string) =>
  line({
    type: "assistant",
    uuid: `a-${id}`,
    timestamp: "2026-09-26T08:01:00.000Z",
    message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name: "ExitPlanMode", input: { plan } }] },
  });
const result = (id: string, isError: boolean, text: string) =>
  line({
    type: "user",
    uuid: `r-${id}`,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] },
  });

describe("plans in the transcript", () => {
  it("collects presented plans with their status and feedback", () => {
    const parser = new TranscriptParser();
    parser.push(prompt("u1", "Plan the cache"));
    parser.push(exitPlan("t1", "# Cache\n\n1. Add Redis"));
    expect(parser.plans).toEqual([
      { id: "t1", text: "# Cache\n\n1. Add Redis", timestamp: "2026-09-26T08:01:00.000Z", prompt: "Plan the cache", status: "pending" },
    ]);

    const changed = parser.push(
      result(
        "t1",
        true,
        "The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\nuse an in-memory cache",
      ),
    );
    expect(changed).toBe(true);
    expect(parser.plans[0]).toMatchObject({ status: "rejected", feedback: "use an in-memory cache" });

    parser.push(exitPlan("t2", "# Cache\n\n1. Add MemoryCache"));
    parser.push(result("t2", false, "User has approved your plan. You can now start coding."));
    expect(parser.plans.map((p) => [p.id, p.status])).toEqual([
      ["t1", "rejected"],
      ["t2", "approved"],
    ]);
    // Tool results are not prompts: the turn list is unchanged.
    expect(parser.turns).toHaveLength(1);
  });

  it("keeps a rejection without feedback plain", () => {
    const parser = new TranscriptParser();
    parser.push(exitPlan("t1", "Plan"));
    parser.push(result("t1", true, "User rejected tool use"));
    expect(parser.plans[0].status).toBe("rejected");
    expect(parser.plans[0].feedback).toBeUndefined();
  });
});

describe("planTitle", () => {
  it("uses the first heading, else the first line", () => {
    expect(planTitle("Intro\n\n# Cache plan\n\n## Steps")).toBe("Cache plan");
    expect(planTitle("\nJust text\nmore")).toBe("Just text");
  });
});

describe("diffLines", () => {
  it("finds added and removed lines with numbers and context", () => {
    const letters = "abcdefghijklmnop".split("");
    const oldText = letters.join("\n");
    const newText = [...letters.slice(0, 4), "E", ...letters.slice(5), "q"].join("\n");
    const { hunks } = diffLines(oldText, newText);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].header).toBe("@@ -2,7 +2,7 @@");
    expect(hunks[0].lines.filter((l) => l.kind !== "ctx")).toEqual([
      { kind: "del", text: "e", oldNo: 5 },
      { kind: "add", text: "E", newNo: 5 },
    ]);
    expect(hunks[1].header).toBe("@@ -14,3 +14,4 @@");
    expect(hunks[1].lines.filter((l) => l.kind !== "ctx")).toEqual([{ kind: "add", text: "q", newNo: 17 }]);
  });

  it("merges changes whose context overlaps into one hunk", () => {
    const { hunks } = diffLines("a\nb\nc\nd\ne\nf", "a\nB\nc\nd\nE\nf");
    expect(hunks).toHaveLength(1);
  });

  it("returns no hunks for equal texts", () => {
    expect(diffLines("a\nb\n", "a\nb").hunks).toEqual([]);
  });
});

describe("plan mode", () => {
  const attachment = (type: string, extra: Record<string, unknown> = {}, time = "08:00") =>
    line({ type: "attachment", timestamp: `2026-09-26T${time}:00.000Z`, attachment: { type, ...extra } });

  it("follows plan mode and its plan file from start to exit", () => {
    const parser = new TranscriptParser();
    parser.push(attachment("plan_mode", { planFilePath: "/plans/a.md", isSubAgent: false }, "08:00"));
    parser.push(prompt("u1", "Plan the cache"));
    expect(parser.planMode).toEqual({ file: "/plans/a.md", since: "2026-09-26T08:00:00.000Z", prompt: "Plan the cache" });
    // A repeated reminder keeps the start.
    parser.push(attachment("plan_mode", { planFilePath: "/plans/a.md" }, "08:30"));
    expect(parser.planMode?.since).toBe("2026-09-26T08:00:00.000Z");
    parser.push(attachment("plan_mode_exit", { planFilePath: "/plans/a.md" }));
    expect(parser.planMode).toBeUndefined();
  });

  it("ignores the plan mode of subagents", () => {
    const parser = new TranscriptParser();
    parser.push(attachment("plan_mode", { planFilePath: "/plans/a.md", isSubAgent: true }));
    expect(parser.planMode).toBeUndefined();
  });
});

describe("draftPlan", () => {
  const mode = { file: "/plans/a.md", since: "2026-09-26T08:00:00.000Z", prompt: "Plan the cache" };
  const at = (time: string) => Date.parse(`2026-09-26T${time}:00.000Z`);
  const presented = (text: string, time: string) => ({
    id: "t1",
    text,
    timestamp: `2026-09-26T${time}:00.000Z`,
    status: "rejected" as const,
  });

  it("shows the plan file written in plan mode", () => {
    expect(draftPlan(mode, { text: "# Cache\n\n1. Redis", mtime: at("08:05") }, [])).toMatchObject({
      id: "draft",
      status: "draft",
      text: "# Cache\n\n1. Redis",
      prompt: "Plan the cache",
    });
  });

  it("shows nothing outside plan mode, for an older file or an empty one", () => {
    const file = { text: "# Cache", mtime: at("08:05") };
    expect(draftPlan(undefined, file, [])).toBeUndefined();
    expect(draftPlan(mode, { text: "# Old plan", mtime: at("07:00") }, [])).toBeUndefined();
    expect(draftPlan(mode, { text: "  \n", mtime: at("08:05") }, [])).toBeUndefined();
  });

  it("hides a draft that is the plan presented last, and shows the rewrite", () => {
    const rejected = presented("# Cache\n\n1. Redis", "08:06");
    expect(draftPlan(mode, { text: "# Cache\n\n1. Redis\n", mtime: at("08:05") }, [rejected])).toBeUndefined();
    expect(draftPlan(mode, { text: "# Cache\n\n1. MemoryCache", mtime: at("08:10") }, [rejected])?.status).toBe("draft");
  });
});
