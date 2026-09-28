import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { peerText, TranscriptParser } from "../src/transcript/parse.js";
import { answerLines, turnAgents } from "../src/tui/ChatView.js";

const line = (entry: object) => JSON.stringify(entry) + "\n";
const PREAMBLE =
  "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:\n";
const launch = (id: string, agentId: string, description: string) =>
  line({
    type: "assistant",
    message: { id: `m-${id}`, content: [{ type: "tool_use", id, name: "Agent", input: { description, run_in_background: true } }], stop_reason: "tool_use" },
  }) +
  line({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "Async agent launched" }] }] },
    toolUseResult: { status: "async_launched", agentId },
  });
// Claude Code writes a subagent's report as a meta user entry from a "peer".
const handback = (uuid: string, from: string, report: string) =>
  line({
    type: "user",
    uuid,
    isMeta: true,
    message: { role: "user", content: `Another Claude session sent a message:\n<agent-message from="${from}">\n…\n</agent-message>` },
    origin: { kind: "peer", from, senderTaskId: from, body: PREAMBLE + report.replace(/^/gm, "  "), handback: true },
  });
const answer = (id: string, text: string) =>
  line({ type: "assistant", message: { id, content: [{ type: "text", text }], stop_reason: "end_turn" } });
const notification = (uuid: string, toolUseId: string) =>
  line({
    type: "user",
    uuid,
    origin: { kind: "task-notification" },
    message: {
      role: "user",
      content: [
        "<task-notification>",
        `<tool-use-id>${toolUseId}</tool-use-id>`,
        "<status>completed</status>",
        '<summary>Agent "Review docs" finished</summary>',
        '<result>This agent\'s report was delivered to you as a message from "abc" (its SubagentHandback call). Read it there; it is not repeated here.\n</result>',
        "</task-notification>",
      ].join("\n"),
    },
  });

describe("messages from other agents", () => {
  it("gives a subagent's report a turn of its own, with Claude's reaction, and makes it the agent's result", () => {
    const p = new TranscriptParser();
    p.push(
      line({ type: "user", uuid: "u1", message: { role: "user", content: "review it" } }) +
        launch("t1", "abc", "Review docs") +
        answer("m1", "Waiting for the agent.") +
        handback("h1", "abc", "No findings.\n\n- docs match the code") +
        answer("m2", "## Code review\n\nAll clean.") +
        notification("n1", "t1") +
        answer("m3", "All agents are done."),
    );
    expect(p.turns.map((t) => t.prompt)).toEqual(["review it", 'Agent "Review docs" reported back', 'Agent "Review docs" finished']);
    const [first, report, finished] = p.turns;
    expect(first.blocks.filter((b) => b.kind === "text").map((b) => ("text" in b ? b.text : ""))).toEqual(["Waiting for the agent."]);
    expect(report.notification).toMatchObject({ kind: "handback", from: "abc", toolUseId: "t1", result: "No findings.\n\n- docs match the code" });
    expect(report.blocks).toMatchObject([{ kind: "text", text: "## Code review\n\nAll clean." }]);
    // The notification only says where the report went; the agent keeps the report.
    expect(finished.notification?.result).toBeUndefined();
    expect(p.agents[0].result).toBe("No findings.\n\n- docs match the code");
    expect(turnAgents(report, p.agents).map((a) => a.id)).toEqual(["t1"]);

    const lines = answerLines(report, { tools: "off", thinking: false, agents: true }, 60, true).map(stripAnsi);
    expect(lines[0]).toBe("▌ ◆ Report");
    expect(lines).toContain("▌ No findings.");
    expect(lines.findIndex((l) => l.includes("Code review"))).toBeGreaterThan(lines.indexOf("▌ No findings."));
  });

  it("takes a report that arrives mid-turn (a queued command) the same way", () => {
    const p = new TranscriptParser();
    p.push(
      line({ type: "user", uuid: "u1", message: { role: "user", content: "review it" } }) +
        launch("t1", "abc", "Review docs") +
        line({
          type: "attachment",
          uuid: "q1",
          attachment: {
            type: "queued_command",
            commandMode: "prompt",
            isMeta: true,
            prompt: '<agent-message from="abc">…</agent-message>',
            origin: { kind: "peer", from: "abc", body: PREAMBLE + "  Done.", handback: true },
          },
        }) +
        answer("m1", "The agent is done."),
    );
    expect(p.turns.map((t) => t.prompt)).toEqual(["review it", 'Agent "Review docs" reported back']);
    expect(p.turns[1].blocks).toMatchObject([{ kind: "text", text: "The agent is done." }]);
  });

  it("names another session that writes by its id", () => {
    const p = new TranscriptParser();
    p.push(line({ type: "user", uuid: "x", isMeta: true, origin: { kind: "peer", from: "s-42", body: "Please rebase." }, message: { role: "user", content: "…" } }));
    expect(p.turns[0].prompt).toBe("Message from s-42");
    expect(p.turns[0].notification).toMatchObject({ kind: "message", result: "Please rebase." });
  });

  it("shows a report in JSON as a code block, without the preamble and the indentation", () => {
    expect(peerText({ handback: true, body: PREAMBLE + '  {\n    "findings": []\n  }' })).toBe('```json\n{\n  "findings": []\n}\n```');
    expect(peerText({ handback: true, body: PREAMBLE + "  {not json" })).toBe("{not json");
  });
});
