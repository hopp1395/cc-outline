import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentStatusLine, taskNotification, TranscriptParser, turnMarkdown } from "../src/transcript/parse.js";
import { subagentDir, subagentFile } from "../src/transcript/subagents.js";
import { spinnerMarks, turnAgents } from "../src/tui/ChatView.js";

const line = (entry: object) => JSON.stringify(entry) + "\n";
const prompt = (uuid: string, text: string) => line({ type: "user", uuid, message: { role: "user", content: text } });
const agentCall = (id: string, input: object) =>
  line({ type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name: "Agent", input }], stop_reason: "tool_use" } });
const toolResult = (id: string, text: string, toolUseResult: object, isError = false) =>
  line({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] }] },
    toolUseResult,
  });
const notificationText = (toolUseId: string, status = "completed") =>
  [
    "<task-notification>",
    "<task-id>a1</task-id>",
    `<tool-use-id>${toolUseId}</tool-use-id>`,
    `<status>${status}</status>`,
    '<summary>Agent "Map the repo" finished</summary>',
    "<result>Found 12 projects.</result>",
    "<usage><subagent_tokens>138765</subagent_tokens><tool_uses>30</tool_uses><duration_ms>189686</duration_ms></usage>",
    "</task-notification>",
  ].join("\n");

describe("subagents in the transcript", () => {
  it("follows a background agent from its launch to its notification", () => {
    const p = new TranscriptParser();
    p.push(
      prompt("u1", "map the repo") +
        agentCall("t1", { description: "Map the repo", subagent_type: "Explore", prompt: "List all projects", run_in_background: true }) +
        toolResult("t1", "Async agent launched", { isAsync: true, status: "async_launched", agentId: "abc", resolvedModel: "claude-sonnet-5" }),
    );
    const [agent] = p.agents;
    expect(agent).toMatchObject({ id: "t1", description: "Map the repo", type: "Explore", background: true, agentId: "abc", status: "running" });
    expect(agent.model).toBe("claude-sonnet-5");
    expect(p.turns[0].blocks).toEqual([{ kind: "agent", agent }]);

    p.push(line({ type: "user", uuid: "n1", origin: { kind: "task-notification" }, message: { role: "user", content: notificationText("t1") } }));
    expect(p.turns.map((t) => t.prompt)).toEqual(["map the repo", 'Agent "Map the repo" finished']);
    expect(p.turns[1].notification).toMatchObject({ status: "completed", toolUseId: "t1", result: "Found 12 projects." });
    expect(agent).toMatchObject({ status: "completed", result: "Found 12 projects.", tokens: 138765, toolUses: 30, durationMs: 189686 });
    expect(agentStatusLine(agent)).toBe("✓ completed · 3 min 10 s · 30 tool uses · 139k tokens");
  });

  it("takes a notification Claude reads mid-turn as a turn too", () => {
    const p = new TranscriptParser();
    p.push(
      prompt("u1", "go") +
        agentCall("t1", { description: "Map the repo" }) +
        line({ type: "attachment", uuid: "q1", attachment: { type: "queued_command", prompt: notificationText("t1", "failed"), commandMode: "task-notification" } }),
    );
    expect(p.turns[1]).toMatchObject({ prompt: 'Agent "Map the repo" finished', notification: { status: "failed" } });
    expect(p.agents[0].status).toBe("failed");
  });

  it("stops an agent the previous process left running, named by its task id alone", () => {
    const p = new TranscriptParser();
    p.push(
      prompt("u1", "map the repo") +
        agentCall("t1", { description: "Map the repo", run_in_background: true }) +
        toolResult("t1", "Async agent launched", { isAsync: true, status: "async_launched", agentId: "abc" }),
    );
    const content = [
      "<task-notification>",
      "<task-id>abc</task-id>",
      "<status>stopped</status>",
      '<summary>Background agent "Map the repo" didn\'t finish before the previous session ended</summary>',
      "</task-notification>",
    ].join("\n");
    p.push(line({ type: "user", uuid: "n1", origin: { kind: "task-notification" }, message: { role: "user", content } }));
    expect(p.agents[0].status).toBe("killed");
    expect(p.turns[1].notification).toMatchObject({ taskId: "abc", toolUseId: "t1" });
    expect(turnAgents(p.turns[1], p.agents).map((a) => a.id)).toEqual(["t1"]);
  });

  it("completes a foreground agent with its result", () => {
    const p = new TranscriptParser();
    p.push(
      prompt("u1", "go") +
        agentCall("t1", { description: "Check", subagent_type: "Plan" }) +
        toolResult("t1", "The plan is fine.", { agentId: "x", totalTokens: 900, totalToolUseCount: 1, totalDurationMs: 4000 }),
    );
    expect(p.agents[0]).toMatchObject({ status: "completed", result: "The plan is fine.", tokens: 900, toolUses: 1, durationMs: 4000, agentId: "x" });
  });

  it("names background commands that stopped, without an agent", () => {
    const n = taskNotification("<task-notification>\n<task-id>b7</task-id>\n<status>failed</status>\n<summary>Background command \"npm test\" failed with exit code 1</summary>\n</task-notification>");
    expect(n).toMatchObject({ taskId: "b7", status: "failed", summary: 'Background command "npm test" failed with exit code 1' });
    expect(taskNotification("hello")).toBeUndefined();
  });

  it("shows agents in the answer only when asked to", () => {
    const p = new TranscriptParser();
    p.push(prompt("u1", "go") + agentCall("t1", { description: "Map *the* repo", subagent_type: "Explore", model: "sonnet" }));
    const turn = p.turns[0];
    expect(turnMarkdown(turn, { tools: "compact", thinking: false })).toBe("");
    expect(turnMarkdown(turn, { tools: "off", thinking: false, agents: true })).toBe(
      "**◆ Explore · Map \\*the\\* repo · sonnet**  \n⠿ running",
    );
  });

  it("reads a subagent's own transcript of sidechain entries", () => {
    const side = (entry: object) => line({ ...entry, isSidechain: true, agentId: "abc" });
    const text =
      side({ type: "user", uuid: "s1", message: { role: "user", content: "List all projects" } }) +
      side({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "12 projects." }], stop_reason: "end_turn" } });
    const main = new TranscriptParser();
    main.push(text);
    expect(main.turns).toEqual([]);
    const sub = new TranscriptParser({ sidechains: true });
    sub.push(text);
    expect(sub.turns.map((t) => [t.prompt, t.blocks])).toEqual([["List all projects", [{ kind: "text", text: "12 projects." }]]]);
  });
});

describe("finding a subagent's transcript", () => {
  it("by agentId, else by the tool call id in its meta.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "cco-sub-"));
    const transcript = join(dir, "sess.jsonl");
    const subs = subagentDir(transcript);
    expect(subs).toBe(join(dir, "sess", "subagents"));
    mkdirSync(subs, { recursive: true });
    writeFileSync(join(subs, "agent-abc.jsonl"), "");
    writeFileSync(join(subs, "agent-def.jsonl"), "");
    writeFileSync(join(subs, "agent-def.meta.json"), JSON.stringify({ toolUseId: "t2" }));
    const agent = (id: string, agentId?: string) => ({ id, agentId, description: "x", status: "running" as const });
    expect(subagentFile(transcript, agent("t1", "abc"))).toBe(join(subs, "agent-abc.jsonl"));
    expect(subagentFile(transcript, agent("t2"))).toBe(join(subs, "agent-def.jsonl"));
    expect(subagentFile(transcript, agent("t3"))).toBeUndefined();
    expect(subagentFile(join(dir, "other.jsonl"), agent("t1", "abc"))).toBeUndefined();
  });
});

describe("chat helpers", () => {
  it("finds the running marks to spin", () => {
    expect(spinnerMarks(["plain", "\u001b[1m◆ Explore\u001b[22m", "  ⠿ running", "\u001b[2m⠿ Claude is working…\u001b[22m"])).toEqual([
      { line: 2, col: 2 },
      { line: 3, col: 0 },
    ]);
  });

  it("gives a notification the agent it reports on", () => {
    const p = new TranscriptParser();
    p.push(prompt("u1", "go") + agentCall("t1", { description: "Map" }) + prompt("u2", notificationText("t1")));
    expect(turnAgents(p.turns[0], p.agents).map((a) => a.id)).toEqual(["t1"]);
    expect(turnAgents(p.turns[1], p.agents).map((a) => a.id)).toEqual(["t1"]);
    expect(turnAgents(undefined, p.agents)).toEqual([]);
  });
});
