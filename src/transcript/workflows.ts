import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readJson } from "./locate.js";
import type { AgentRun, AgentStatus, WorkflowRun } from "./parse.js";

/**
 * Claude Code keeps a dynamic workflow's run next to the session's transcript:
 * `<session>/subagents/workflows/<runId>/` holds each agent's transcript
 * (`agent-<agentId>.jsonl`) with its `.meta.json` (label, phase, model) and
 * `journal.jsonl` (`started`, `result` per agent, written as the run goes on);
 * `<session>/workflows/<runId>.json` is the run's state, written at its end,
 * with each agent's tokens, tool calls and duration (`workflowProgress`).
 */
export function workflowFolder(transcript: string, run: Pick<WorkflowRun, "runId" | "dir">): string | undefined {
  if (!run.runId) return undefined;
  const own = join(dirname(transcript), basename(transcript, ".jsonl"), "subagents", "workflows", run.runId);
  // A session read from elsewhere (an import keeps the folders next to the transcript) finds its own; else where the launch said.
  return existsSync(own) || !run.dir ? own : run.dir;
}

/** The run's state file, `<session>/workflows/<runId>.json`. */
export function workflowStateFile(transcript: string, run: Pick<WorkflowRun, "runId" | "scriptPath">): string | undefined {
  if (!run.runId) return undefined;
  const own = join(dirname(transcript), basename(transcript, ".jsonl"), "workflows", `${run.runId}.json`);
  return existsSync(own) || !run.scriptPath ? own : join(dirname(dirname(run.scriptPath)), `${run.runId}.json`);
}

interface Meta {
  description?: string;
  workflowPhase?: string;
  model?: string;
}

interface JournalEntry {
  type?: string;
  agentId?: string;
  label?: string;
  phase?: string;
  result?: unknown;
}

interface Progress {
  type?: string;
  agentId?: string;
  label?: string;
  phaseTitle?: string;
  model?: string;
  state?: string;
  startedAt?: number;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  resultPreview?: string;
}

interface RunState {
  status?: string;
  durationMs?: number;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  phases?: { title?: string }[];
  workflowProgress?: Progress[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** An agent's state in the run's state file as an AgentStatus. */
function progressStatus(state: string | undefined): AgentStatus | undefined {
  if (state === "done" || state === "completed") return "completed";
  if (state === "error" || state === "failed") return "failed";
  if (state === "skipped" || state === "cancelled" || state === "killed" || state === "stopped") return "killed";
  return undefined;
}

function readLines<T>(file: string): T[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line) as T] : [];
    } catch {
      return [];
    }
  });
}

/** What was read of a run last, to tell whether a read changed anything. */
const lastRead = new WeakMap<WorkflowRun, string>();
/** The run's status at its last read: a run is read again until it has ended and been read once since. */
const readStatus = new WeakMap<WorkflowRun, AgentStatus>();

/** The run should be read (again): never read, still running, or ended since its last read. */
export function workflowDue(run: WorkflowRun): boolean {
  return run.runId !== undefined && (run.status === "running" || readStatus.get(run) !== run.status);
}

/**
 * Reads a run's agents from its folders into `run` (`agents`, `phase`, and
 * from the state file the totals), keeping each AgentRun object, so a page
 * showing one keeps it. `transcript` is the transcript the Workflow call is in.
 * Returns whether anything changed.
 */
export function readWorkflow(transcript: string, run: WorkflowRun): boolean {
  readStatus.set(run, run.status);
  const folder = workflowFolder(transcript, run);
  if (!folder) return false;
  const stateFile = workflowStateFile(transcript, run);
  const state = stateFile ? readJson<RunState>(stateFile) : undefined;
  const journal = readLines<JournalEntry>(join(folder, "journal.jsonl"));
  const progress = new Map((state?.workflowProgress ?? []).filter((p) => p.type === "workflow_agent" && p.agentId).map((p) => [p.agentId!, p]));
  let metas: string[] = [];
  try {
    metas = readdirSync(folder).filter((n) => /^agent-.+\.meta\.json$/.test(n));
  } catch {
    // Not started yet, or the folder is gone.
  }
  // In the order they started: the journal's, then any it does not name yet, then the state's.
  const ids = [
    ...journal.filter((j) => j.type === "started" && j.agentId).map((j) => j.agentId!),
    ...metas.map((n) => n.replace(/^agent-/, "").replace(/\.meta\.json$/, "")),
    ...progress.keys(),
  ];
  const results = new Map(journal.filter((j) => j.type === "result" && j.agentId).map((j) => [j.agentId!, j.result]));
  const failed = new Set(journal.filter((j) => (j.type === "error" || j.type === "failed") && j.agentId).map((j) => j.agentId!));
  const known = new Map(run.agents.map((a) => [a.agentId, a]));
  const agents: AgentRun[] = [];
  for (const agentId of new Set(ids)) {
    const meta = readJson<Meta>(join(folder, `agent-${agentId}.meta.json`)) ?? {};
    const started = journal.find((j) => j.type === "started" && j.agentId === agentId);
    const p = progress.get(agentId);
    const agent = known.get(agentId) ?? { id: `${run.runId}/${agentId}`, agentId, description: "", status: "running" as AgentStatus };
    agent.description = str(p?.label) ?? str(started?.label) ?? str(meta.description) ?? agentId;
    agent.type = run.name ?? "workflow";
    agent.phase = str(p?.phaseTitle) ?? str(started?.phase) ?? str(meta.workflowPhase);
    agent.model = str(p?.model) ?? str(meta.model);
    agent.file = join(folder, `agent-${agentId}.jsonl`);
    agent.transcript = run.transcript ?? transcript;
    const result = results.get(agentId);
    agent.status =
      progressStatus(p?.state) ??
      (failed.has(agentId) ? "failed" : results.has(agentId) ? "completed" : run.status === "running" ? "running" : run.status === "completed" ? "completed" : "killed");
    if (result !== undefined) agent.result = typeof result === "string" ? result : "```json\n" + JSON.stringify(result, null, 2) + "\n```";
    else if (p?.resultPreview) agent.result = p.resultPreview;
    agent.tokens = num(p?.tokens) ?? agent.tokens;
    agent.toolUses = num(p?.toolCalls) ?? agent.toolUses;
    agent.durationMs = num(p?.durationMs) ?? agent.durationMs;
    if (num(p?.startedAt) !== undefined) agent.started = new Date(p!.startedAt!).toISOString();
    agents.push(agent);
  }
  run.agents = agents;
  run.phase = [...agents].reverse().find((a) => a.status === "running")?.phase ?? agents.at(-1)?.phase;
  if (state) {
    run.phases = run.phases.length ? run.phases : (state.phases ?? []).flatMap((p) => (str(p.title) ? [p.title!] : []));
    run.durationMs ??= num(state.durationMs);
    run.agentCount ??= num(state.agentCount);
    run.tokens ??= num(state.totalTokens);
    run.toolUses ??= num(state.totalToolCalls);
  }
  const signature = JSON.stringify([run.phase, run.phases, run.durationMs, run.agentCount, run.tokens, agents.map((a) => [a.agentId, a.status, a.description, a.phase, a.tokens, a.durationMs, a.result?.length])]);
  const changed = lastRead.get(run) !== signature;
  lastRead.set(run, signature);
  return changed;
}
