import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Text } from "ink";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTS, CALL_ID, notificationText, RUN_ID, SCRIPT, writeWorkflowSession } from "./helpers/workflow.js";
import { renderInk } from "./helpers/ink.js";
import { ImageSource, loadSession, sessionJson, sessionMarkdown } from "../src/export/session.js";
import { subagentFiles } from "../src/monitor/responses.js";
import { renderMarkdown } from "../src/render/markdown.js";
import { harnessPrompt, TranscriptParser, turnMarkdown, workflowMeta, workflowStatusLine, type WorkflowRun } from "../src/transcript/parse.js";
import { SessionReader } from "../src/transcript/sessions.js";
import { subagentFile } from "../src/transcript/subagents.js";
import { toolMarkdown } from "../src/transcript/tools.js";
import { readWorkflow, workflowDue } from "../src/transcript/workflows.js";
import { turnAttachments } from "../src/attachments.js";
import { ChatView, indentJson, notificationResult, spinnerMarks, turnAgents } from "../src/tui/ChatView.js";
import type { Layout } from "../src/tui/layout.js";
import { SESSION_LEGEND } from "../src/tui/sessionLegend.js";
import { sessionLines } from "../src/tui/SessionsView.js";
import { useTranscript, type Transcript } from "../src/tui/useTranscript.js";

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const line = (entry: object) => JSON.stringify(entry) + "\n";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-workflows-"));
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

/** The session written and read as the chat reads it, its workflows' folders read too. */
function readSession(finished: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "cco-workflow-"));
  const path = writeWorkflowSession(dir, "s-wf", { finished });
  const parser = new TranscriptParser({ dedupe: true });
  parser.push(readFileSync(path, "utf8"));
  for (const w of parser.workflows) readWorkflow(path, w);
  return { dir, path, parser, run: parser.workflows[0] };
}

describe("the Workflow tool in the transcript", () => {
  it("names the run after the script's meta and takes its ids from the launch", () => {
    const { parser, run } = readSession(false);
    expect(parser.workflows).toHaveLength(1);
    expect(run).toMatchObject({
      id: CALL_ID,
      name: "ticket-rating",
      description: "Rates 4 tickets and writes a brief per ticket",
      phases: ["Rate", "Sum up"],
      status: "running",
      runId: RUN_ID,
      taskId: "wtask01",
    });
    expect(parser.turns[0].blocks.filter((b) => b.kind === "workflow")).toEqual([{ kind: "workflow", workflow: run }]);
    // A Workflow call is a tool call of the turn; the queued notifications of its agents start no turns.
    expect(parser.turns[0].stats?.toolNames).toEqual({ Workflow: 1 });
    expect(parser.turns.map((t) => t.prompt)).toEqual(["rate the open tickets"]);
  });

  it("ends the run with its notification, which gets a turn for Claude's reaction", () => {
    const { parser, run } = readSession(true);
    expect(parser.turns.map((t) => t.prompt)).toEqual(["rate the open tickets", 'Dynamic workflow "Rates 4 tickets and writes a brief per ticket" completed']);
    const n = parser.turns[1].notification!;
    expect(n).toMatchObject({ workflow: "ticket-rating", toolUseId: CALL_ID, agents: { count: 2, done: 2, failed: 0, skipped: 0 }, tokens: 183203, toolUses: 78 });
    expect(n.outputFile).toBe("C:\\Temp\\claude\\tasks\\wtask01.output");
    expect(run).toMatchObject({ status: "completed", agentCount: 2, agentsDone: 2, tokens: 183203, toolUses: 78, durationMs: 1103508 });
    expect(parser.turns[1].blocks).toEqual([{ kind: "text", text: "All 4 tickets are rated." }]);
    expect(workflowStatusLine(run)).toBe("✓ completed · 18 min 24 s · 2 agents · 78 tool uses · 183k tokens");
  });

  it("marks a launch that failed", () => {
    const p = new TranscriptParser();
    p.push(
      line({ type: "user", uuid: "u1", message: { role: "user", content: "go" } }) +
        line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "w1", name: "Workflow", input: { script: SCRIPT } }] } }) +
        line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", is_error: true, content: "<tool_use_error>meta must be a literal</tool_use_error>" }] } }),
    );
    expect(p.workflows[0]).toMatchObject({ status: "failed", error: "meta must be a literal" });
    expect(workflowDue(p.workflows[0])).toBe(false);
  });

  it("names a resumed run after the run it resumes, whose agents it shares", () => {
    const { path, parser } = readSession(true);
    parser.push(
      line({ type: "user", uuid: "u2", message: { role: "user", content: "run it again" } }) +
        line({
          type: "assistant",
          message: { id: "m9", content: [{ type: "tool_use", id: "w2", name: "Workflow", input: { scriptPath: "C:\\x\\workflows\\scripts\\ticket-rating-wf_0a1b2c3d-e4f.js", resumeFromRunId: RUN_ID } }] },
        }),
    );
    const resumed = parser.workflows[1];
    expect(resumed).toMatchObject({ name: "ticket-rating", resumeOf: RUN_ID, runId: RUN_ID, phases: ["Rate", "Sum up"] });
    readWorkflow(path, resumed);
    expect(resumed.agents.map((a) => a.description)).toEqual(["rate:backend", "rate:frontend"]);
    expect(strip(renderMarkdown(turnMarkdown(parser.turns.at(-1)!, { tools: "off", thinking: false, agents: true }), 100).join("\n"))).toContain(
      `◇ Workflow · ticket-rating · ↻ resume ${RUN_ID}`,
    );
  });
});

describe("workflowMeta", () => {
  it("reads name, description and the phases' titles, not a phase's other fields", () => {
    expect(workflowMeta(SCRIPT)).toEqual({ name: "ticket-rating", description: "Rates 4 tickets and writes a brief per ticket", phases: ["Rate", "Sum up"] });
  });

  it("reads double quotes and escapes, and a meta without phases", () => {
    const script = 'export const meta = {\n  description: "It\'s \\"quoted\\"",\n  name: "a-b",\n}\nconst name = "not this"\n';
    expect(workflowMeta(script)).toEqual({ name: "a-b", description: 'It\'s "quoted"', phases: [] });
    expect(workflowMeta("await agent('x')")).toEqual({ phases: [] });
  });
});

describe("readWorkflow", () => {
  it("reads a running run's agents from its journal and their .meta.json, newest phase first", () => {
    const { run } = readSession(false);
    expect(run.agents.map((a) => [a.description, a.phase, a.status, a.model])).toEqual([
      ["rate:backend", "Rate", "completed", "sonnet"],
      ["rate:frontend", "Rate", "running", "sonnet"],
    ]);
    expect(run.agents[0]).toMatchObject({ id: `${RUN_ID}/${AGENTS[0].id}`, agentId: AGENTS[0].id, type: "ticket-rating" });
    expect(run.agents[0].result).toContain('"effort": "M"');
    expect(run.phase).toBe("Rate");
    expect(workflowStatusLine(run)).toBe("⠿ running · phase 1/2 Rate · 1 of 2 agents done");
    // It runs: read again until it ended and was read once after that.
    expect(workflowDue(run)).toBe(true);
  });

  it("takes each agent's numbers from the state file written at the end, keeping the objects", () => {
    const dir = mkdtempSync(join(tmpdir(), "cco-workflow-"));
    const path = writeWorkflowSession(dir, "s-wf", { finished: false });
    const parser = new TranscriptParser();
    parser.push(readFileSync(path, "utf8"));
    const run = parser.workflows[0];
    expect(readWorkflow(path, run)).toBe(true);
    expect(readWorkflow(path, run)).toBe(false);
    const first = run.agents[0];
    // The run ends: its files are written, then its notification.
    writeWorkflowSession(dir, "s-wf", { finished: true });
    parser.push(readFileSync(path, "utf8").split("\n").slice(7).join("\n"));
    expect(run.status).toBe("completed");
    expect(workflowDue(run)).toBe(true);
    expect(readWorkflow(path, run)).toBe(true);
    expect(workflowDue(run)).toBe(false);
    expect(run.agents[0]).toBe(first);
    expect(run.agents.map((a) => [a.status, a.tokens, a.toolUses, a.durationMs, a.model])).toEqual([
      ["completed", 90932, 46, 817487, "claude-sonnet-5-5"],
      ["completed", 92271, 32, 550439, "claude-sonnet-5-5"],
    ]);
    // An agent's transcript is found in the run's folder.
    expect(subagentFile(path, run.agents[1])).toBe(join(dir, "s-wf", "subagents", "workflows", RUN_ID, `agent-${AGENTS[1].id}.jsonl`));
  });

  it("finds the run where the launch said when it is not next to the transcript", () => {
    const { path, run } = readSession(true);
    const elsewhere = join(mkdtempSync(join(tmpdir(), "cco-workflow-moved-")), "s-wf.jsonl");
    writeFileSync(elsewhere, readFileSync(path));
    const copy: WorkflowRun = { ...run, agents: [] };
    readWorkflow(elsewhere, copy);
    expect(copy.agents).toHaveLength(2);
  });
});

describe("a workflow in the chat", () => {
  it("shows its title, description and status, then its agents by phase, with tools off", () => {
    const { parser } = readSession(true);
    const md = turnMarkdown(parser.turns[0], { tools: "off", thinking: false, agents: true });
    expect(strip(renderMarkdown(md, 100).join("\n"))).toBe(
      [
        "◇ Workflow · ticket-rating · background",
        "Rates 4 tickets and writes a brief per ticket",
        "✓ completed · 18 min 24 s · 2 agents · 78 tool uses · 183k tokens",
        "",
        "Rate · 2/2",
        "",
        "  * ✓ rate:backend · 13 min 37 s · 46 tool uses · 91k tokens",
        "  * ✓ rate:frontend · 9 min 10 s · 32 tool uses · 92k tokens",
        "",
        "The workflow runs.",
      ].join("\n"),
    );
    // Like agents, it follows the agents setting.
    expect(turnMarkdown(parser.turns[0], { tools: "full", thinking: false, agents: false })).toBe("The workflow runs.");
  });

  it("spins the running run and its running agents", () => {
    const { parser } = readSession(false);
    const lines = renderMarkdown(turnMarkdown(parser.turns[0], { tools: "off", thinking: false, agents: true }), 100);
    expect(spinnerMarks(lines).map((m) => strip(lines[m.line]).trim())).toEqual(["⠿ running · phase 1/2 Rate · 1 of 2 agents done", "* ⠿ rate:frontend"]);
  });

  it("lists the run's agents for a and A, in its turn and its notification's", () => {
    const { parser } = readSession(true);
    const ids = AGENTS.map((a) => `${RUN_ID}/${a.id}`);
    expect(turnAgents(parser.turns[0], parser.agents, parser.workflows).map((a) => a.id)).toEqual(ids);
    expect(turnAgents(parser.turns[1], parser.agents, parser.workflows).map((a) => a.id)).toEqual(ids);
  });

  it("shows the cut JSON result as an indented code block and offers the whole one", () => {
    const { parser } = readSession(true);
    const n = parser.turns[1].notification!;
    expect(notificationResult(n.result!)).toBe(
      [
        "```json",
        "{",
        '  "items": [',
        "    {",
        '      "id": 101,',
        '      "title": "Split the job queue",',
        '      "effort": "M"',
        "    },",
        "    {",
        '      "id": 102,',
        '      "ti',
        "```",
        "",
        "*truncated 812 chars*",
      ].join("\n"),
    );
    const items = turnAttachments(parser.turns[1]);
    expect(items).toEqual([{ kind: "file", path: "C:/Temp/claude/tasks/wtask01.output", full: "C:\\Temp\\claude\\tasks\\wtask01.output" }]);
    expect(notificationResult("Done: **3** files.")).toBe("Done: **3** files.");
  });

  it("indents JSON like JSON.stringify, also JSON that cannot be parsed", () => {
    const value = { a: [1, { b: "x,y:{" }], c: {}, d: [], e: 'q"uote' };
    expect(indentJson(JSON.stringify(value))).toBe(JSON.stringify(value, null, 2));
    expect(indentJson('{"a":[1,2')).toBe('{\n  "a": [\n    1,\n    2');
  });
});

describe("a workflow agent's own transcript", () => {
  it("shows what the harness relays without its preamble, and the structured output as the result", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cco-workflow-")), "s.jsonl");
    writeWorkflowSession(join(file, ".."), "s", { finished: true });
    const agentFile = join(file, "..", "s", "subagents", "workflows", RUN_ID, `agent-${AGENTS[0].id}.jsonl`);
    const p = new TranscriptParser({ sidechains: true });
    p.push(readFileSync(agentFile, "utf8"));
    expect(p.turns.map((t) => [t.harness, t.prompt])).toEqual([
      ["user request", "rate the open tickets"],
      ["computed task", "Rate the tickets of rate:backend.\n\nReturn one entry per ticket."],
    ]);
    const md = turnMarkdown(p.turns[1], { tools: "off", thinking: false, agents: true });
    const output = JSON.stringify({ items: [{ id: 101, title: "Split the job queue", effort: "M" }] }, null, 2);
    expect(md).toBe(`Reading the tickets.\n\n**Result**\n\n${"```"}json\n${output}\n${"```"}`);
  });

  it("reads a harness prompt, and leaves others alone", () => {
    expect(harnessPrompt("[Workflow harness — computed task] Preamble:\n  line 1\n    indented\n  line 3")).toEqual({ kind: "computed task", text: "line 1\n  indented\nline 3" });
    expect(harnessPrompt("[Image #1] look")).toBeUndefined();
  });

  it("puts a structured output into a JSON block at every tool level", () => {
    for (const level of ["off", "compact", "full"] as const) expect(toolMarkdown("StructuredOutput", { ok: true }, { status: "ok" }, level)).toBe('**Result**\n\n```json\n{\n  "ok": true\n}\n```');
  });
});

describe("workflows elsewhere", () => {
  it("lets the Monitor read the agents' transcripts, not the journal", () => {
    const { path } = readSession(true);
    const files = subagentFiles([path]).map((f) => basename(f));
    expect(files.sort()).toEqual(AGENTS.map((a) => `agent-${a.id}.jsonl`).sort());
  });

  it("lists the session's workflows in Sessions", () => {
    const { dir, path } = readSession(true);
    const s = new SessionReader(path).update();
    expect(s.workflows).toEqual([
      {
        id: CALL_ID,
        name: "ticket-rating",
        description: "Rates 4 tickets and writes a brief per ticket",
        status: "completed",
        runId: RUN_ID,
        started: "2026-10-16T08:00:00.000Z",
        durationMs: 1103508,
        agents: 2,
        tokens: 183203,
      },
    ]);
    const lines = sessionLines(s, dir, 120, false).map(strip);
    const at = lines.indexOf("Workflows (1)");
    expect(at).toBeGreaterThan(lines.indexOf("Plans (0)"));
    expect(lines[at + 1]).toMatch(/^ {2}✓ \d\d:\d\d ticket-rating · 2 agents · 18 min 24 s · Rates 4 tickets and writes a brief per ticket$/);
    expect(SESSION_LEGEND.some((m) => m.mark === "◇")).toBe(true);
  });

  it("exports the run's agents with the workflow, their conversations with whole conversations", () => {
    const { path } = readSession(true);
    const session = loadSession(new SessionReader(path).update());
    expect(session.workflows).toHaveLength(1);
    expect(session.agents.map((a) => a.description)).toEqual(["rate:backend", "rate:frontend"]);
    const images = new ImageSource();
    const md = sessionMarkdown(session, { tools: "compact", thinking: false, agents: "full", stats: false }, "markdown", images);
    expect(md.text).toMatch(/\*\*◇ Workflow · ticket\\?-rating · background\*\*/);
    expect(md.text).toContain(`[Whole conversation](agents/ticket-rating-${AGENTS[0].id}.md)`);
    const doc = String(md.files.find((f) => f.name === `agents/ticket-rating-${AGENTS[0].id}.md`)!.data());
    expect(doc).toContain("## Request\n\n> rate the open tickets");
    expect(doc).toContain("## Task\n\n> Rate the tickets of rate:backend.");
    const json = JSON.parse(sessionJson(session, { tools: "compact", thinking: false, agents: "reports", stats: false }, images).text);
    const block = json.turns[0].blocks.find((b: { type: string }) => b.type === "workflow");
    expect(block.workflow).toMatchObject({ name: "ticket-rating", runId: RUN_ID, status: "completed" });
    expect(block.workflow.agents.map((a: { description: string }) => a.description)).toEqual(["rate:backend", "rate:frontend"]);
    expect(block.workflow.agents[0].file).toBeUndefined();
    expect(json.agents).toHaveLength(2);
  });
});

function Probe({ path }: { path: string }) {
  const t = useTranscript(path);
  const run = t.workflows?.[0];
  return <Text>{run ? `${run.status}|${run.agents.map((a) => `${a.description}=${a.status}`).join(",")}` : "none"}</Text>;
}

describe("following a running workflow", () => {
  it("reads its agents as they start and finish, until its notification ends it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cco-workflow-live-"));
    const path = writeWorkflowSession(dir, "s-live", { finished: false });
    const app = renderInk(<Probe path={path} />, { columns: 200, rows: 5 });
    await expect.poll(() => app.frame().trim(), { timeout: 3000 }).toBe("running|rate:backend=completed,rate:frontend=running");
    // The second agent returns: the journal grows.
    appendFileSync(join(dir, "s-live", "subagents", "workflows", RUN_ID, "journal.jsonl"), line({ type: "result", agentId: AGENTS[1].id, result: { items: [] } }));
    await expect.poll(() => app.frame().trim(), { timeout: 3000 }).toBe("running|rate:backend=completed,rate:frontend=completed");
    appendFileSync(path, line({ type: "user", uuid: "n1", origin: { kind: "task-notification" }, message: { role: "user", content: notificationText() } }));
    await expect.poll(() => app.frame().trim(), { timeout: 3000 }).toBe("completed|rate:backend=completed,rate:frontend=completed");
    app.unmount();
  });
});

describe("a workflow agent's page", () => {
  const layout: Layout = { columns: 120, rows: 40, listWidth: 30, previewWidth: 87, bodyHeight: 36 };

  it("opens with a and shows the relayed request, the task and the result", async () => {
    const { path, parser } = readSession(true);
    const transcript: Transcript = { turns: [...parser.turns], plans: [], agents: [...parser.agents], workflows: [...parser.workflows], version: 1 };
    const cwd = mkdtempSync(join(tmpdir(), "cco-workflow-cwd-"));
    const view = renderInk(<ChatView cwd={cwd} path={path} transcript={transcript} layout={layout} active />, layout);
    await expect.poll(view.frame, { timeout: 2000 }).toContain("All 4 tickets are rated.");
    await view.press("\u001b[A");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("◇ Workflow · ticket-rating · background");
    await view.press("a");
    await expect.poll(view.frame, { timeout: 2000 }).toContain("ticket-rating · Rate · rate:backend");
    const frame = view.frame();
    expect(frame).toContain("Request");
    expect(frame).toContain("rate the open tickets");
    expect(frame).toContain("Rate the tickets of rate:backend.");
    expect(frame).toContain('"title": "Split the job queue"');
    expect(frame).not.toContain("Workflow harness");
    view.unmount();
  });
});
