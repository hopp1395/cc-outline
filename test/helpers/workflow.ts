import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A session that ran a dynamic workflow, written the way Claude Code 2.1.300
 * writes one (the shapes of a recorded session, the contents made up): the
 * Workflow call and its launch in the transcript, the run's folder with two
 * agents (their transcripts, `.meta.json` and the journal), and, once
 * `finished`, the run's state file and the notification at the end.
 */

const line = (entry: object) => JSON.stringify(entry) + "\n";
const at = (min: number) => `2026-10-16T08:${String(min).padStart(2, "0")}:00.000Z`;

export const RUN_ID = "wf_0a1b2c3d-e4f";
export const TASK_ID = "wtask01";
export const CALL_ID = "toolu_wf01";
export const AGENTS = [
  { id: "a11111111111111aa", label: "rate:backend", phase: "Rate" },
  { id: "a22222222222222bb", label: "rate:frontend", phase: "Rate" },
];

export const SCRIPT = [
  "export const meta = {",
  "  name: 'ticket-rating',",
  "  description: 'Rates 4 tickets and writes a brief per ticket',",
  "  phases: [{ title: 'Rate', detail: 'one agent per package' }, { title: 'Sum up' }],",
  "}",
  "",
  "const results = await parallel(PACKAGES.map((p) => () => agent(`Rate ${p}`, { label: `rate:${p}`, phase: 'Rate' })))",
  "return { items: results.flat() }",
].join("\n");

/** The notification's `<result>`: the run's JSON, cut by Claude Code. */
const CUT_RESULT = '{"items":[{"id":101,"title":"Split the job queue","effort":"M"},{"id":102,"ti\n... (truncated 812 chars, full result in C:\\Temp\\claude\\tasks\\wtask01.output)';

export function notificationText(): string {
  return [
    "<task-notification>",
    `<task-id>${TASK_ID}</task-id>`,
    `<tool-use-id>${CALL_ID}</tool-use-id>`,
    `<output-file>C:\\Temp\\claude\\tasks\\${TASK_ID}.output</output-file>`,
    "<status>completed</status>",
    '<summary>Dynamic workflow "Rates 4 tickets and writes a brief per ticket" completed</summary>',
    `<result>${CUT_RESULT}</result>`,
    "<diagnostics>Per-agent results: journal.jsonl</diagnostics>",
    "<usage><agent_count>2</agent_count><agents_done>2</agents_done><agents_error>0</agents_error><agents_skipped>0</agents_skipped><agents_empty_result>0</agents_empty_result><subagent_tokens>183203</subagent_tokens><tool_uses>78</tool_uses><duration_ms>1103508</duration_ms></usage>",
    "</task-notification>",
  ].join("\n");
}

/** A workflow agent's transcript: the relayed request, the computed task, its work and its structured output. */
function agentTranscript(sessionId: string, agentId: string, label: string): string {
  const base = { isSidechain: true, agentId, sessionId };
  const output = { items: [{ id: 101, title: "Split the job queue", effort: "M" }] };
  return (
    line({
      ...base,
      type: "user",
      uuid: `${agentId}-u1`,
      timestamp: at(1),
      message: {
        role: "user",
        content:
          "[Workflow harness — user request] The harness relays, verbatim and indented below, the user request that triggered this workflow run. Where the computed task conflicts with this request, this request wins:\n  rate the open tickets",
      },
    }) +
    line({
      ...base,
      type: "user",
      uuid: `${agentId}-u2`,
      timestamp: at(1),
      message: {
        role: "user",
        content: `[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. The computed task text follows:\n  Rate the tickets of ${label}.\n  \n  Return one entry per ticket.`,
      },
    }) +
    line({ type: "api-request", sessionId, agentId, id: `${agentId}-r1`, timestamp: at(1), querySource: "agent:builtin:workflow-subagent", params: { model: "claude-sonnet-5-5" } }) +
    line({ ...base, type: "assistant", uuid: `${agentId}-a1`, timestamp: at(2), message: { id: `${agentId}-m1`, model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: "Reading the tickets." }], usage: { output_tokens: 400 } } }) +
    line({
      ...base,
      type: "assistant",
      uuid: `${agentId}-a2`,
      timestamp: at(3),
      message: { id: `${agentId}-m2`, model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "tool_use", id: `${agentId}-so`, name: "StructuredOutput", input: output }], stop_reason: "tool_use", usage: { output_tokens: 300 } },
    }) +
    line({ ...base, type: "attachment", uuid: `${agentId}-at`, timestamp: at(3), attachment: { type: "structured_output", data: output } }) +
    line({ ...base, type: "user", uuid: `${agentId}-u3`, timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${agentId}-so`, content: "Structured output provided successfully" }] } })
  );
}

/**
 * Writes the session `<dir>/<sessionId>.jsonl` with its folders. Not
 * `finished`: the run goes on, the first agent has returned, the second
 * still works; there is no state file and no notification yet.
 */
export function writeWorkflowSession(dir: string, sessionId: string, opts: { finished?: boolean } = {}): string {
  const transcript = join(dir, `${sessionId}.jsonl`);
  const session = join(dir, sessionId);
  const runDir = join(session, "subagents", "workflows", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(session, "workflows", "scripts"), { recursive: true });
  const scriptPath = join(session, "workflows", "scripts", `ticket-rating-${RUN_ID}.js`);
  writeFileSync(scriptPath, SCRIPT);

  let main =
    line({ type: "user", uuid: "u1", timestamp: at(0), cwd: dir, sessionId, message: { role: "user", content: "rate the open tickets" } }) +
    line({
      type: "assistant",
      uuid: "a1",
      timestamp: at(0),
      sessionId,
      message: { id: "m1", model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: CALL_ID, name: "Workflow", input: { script: SCRIPT } }], stop_reason: "tool_use", usage: { output_tokens: 900 } },
    }) +
    line({
      type: "user",
      uuid: "r1",
      timestamp: at(0),
      sessionId,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: CALL_ID,
            content: [{ type: "text", text: `Workflow launched in background. Task ID: ${TASK_ID}\nSummary: Rates 4 tickets and writes a brief per ticket\nRun ID: ${RUN_ID}` }],
          },
        ],
      },
      toolUseResult: {
        status: "async_launched",
        taskId: TASK_ID,
        taskType: "local_workflow",
        workflowName: "ticket-rating",
        runId: RUN_ID,
        summary: "Rates 4 tickets and writes a brief per ticket",
        transcriptDir: runDir,
        scriptPath,
      },
    }) +
    line({ type: "assistant", uuid: "a2", timestamp: at(1), sessionId, message: { id: "m2", model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "The workflow runs." }], stop_reason: "end_turn" } }) +
    line({ type: "system", subtype: "turn_duration", uuid: "s1", timestamp: at(1), sessionId, durationMs: 60000, messageCount: 4, pendingWorkflowCount: 1 }) +
    // A background command of an agent passes through the main queue only.
    line({ type: "queue-operation", operation: "enqueue", timestamp: at(2), sessionId, content: "<task-notification>…</task-notification>" }) +
    line({ type: "queue-operation", operation: "remove", timestamp: at(2), sessionId, reason: "absorbed_mid_turn", commandUuid: "c1", deliveryId: "d1" });

  const journal = [
    line({ type: "launched" }),
    ...AGENTS.map((a) => line({ type: "started", key: `v2:${a.id}`, agentId: a.id, label: a.label, phase: a.phase })),
    line({ type: "result", key: `v2:${AGENTS[0].id}`, agentId: AGENTS[0].id, result: { items: [{ id: 101, effort: "M" }] } }),
    ...(opts.finished ? [line({ type: "result", key: `v2:${AGENTS[1].id}`, agentId: AGENTS[1].id, result: { items: [{ id: 102, effort: "S" }] } })] : []),
  ];
  writeFileSync(join(runDir, "journal.jsonl"), journal.join(""));
  for (const a of AGENTS) {
    writeFileSync(
      join(runDir, `agent-${a.id}.meta.json`),
      JSON.stringify({ agentType: "workflow-subagent", description: a.label, workflowPhase: a.phase, spawnDepth: 1, requestShape: "foreground", model: "sonnet" }),
    );
    writeFileSync(join(runDir, `agent-${a.id}.jsonl`), agentTranscript(sessionId, a.id, a.label));
  }

  if (opts.finished) {
    writeFileSync(
      join(session, "workflows", `${RUN_ID}.json`),
      JSON.stringify({
        runId: RUN_ID,
        taskId: TASK_ID,
        script: SCRIPT,
        scriptPath,
        agentCount: 2,
        durationMs: 1103508,
        workflowName: "ticket-rating",
        status: "completed",
        phases: [{ title: "Rate", detail: "one agent per package" }, { title: "Sum up" }],
        totalTokens: 183203,
        totalToolCalls: 78,
        workflowProgress: [
          { type: "workflow_phase", index: 1, title: "Rate" },
          ...AGENTS.map((a, i) => ({
            type: "workflow_agent",
            index: i + 1,
            label: a.label,
            phaseIndex: 1,
            phaseTitle: a.phase,
            agentId: a.id,
            model: "claude-sonnet-5-5",
            state: "done",
            startedAt: Date.parse(at(1)),
            attempt: 1,
            lastToolName: "StructuredOutput",
            tokens: [90932, 92271][i],
            toolCalls: [46, 32][i],
            durationMs: [817487, 550439][i],
            resultPreview: '{"items":[{"id":101',
          })),
        ],
      }),
    );
    main +=
      line({ type: "queue-operation", operation: "enqueue", timestamp: at(19), sessionId, content: notificationText() }) +
      line({ type: "queue-operation", operation: "dequeue", timestamp: at(19), sessionId }) +
      line({
        type: "user",
        uuid: "n1",
        timestamp: at(19),
        sessionId,
        promptSource: "system",
        turnOrigin: "task_notification",
        origin: { kind: "task-notification", producer: "session-task", runId: RUN_ID },
        message: { role: "user", content: notificationText() },
      }) +
      line({ type: "assistant", uuid: "a3", timestamp: at(20), sessionId, message: { id: "m3", model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "All 4 tickets are rated." }], stop_reason: "end_turn" } });
  }
  writeFileSync(transcript, main);
  return transcript;
}
