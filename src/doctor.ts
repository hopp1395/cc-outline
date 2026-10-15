import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { L } from "./i18n/index.js";
import { join } from "node:path";
import { cliFile } from "./cliPath.js";
import { detectTerminal } from "./open.js";
import { DEFAULT_SETTINGS, readSettings, settingsFile, type Settings } from "./settings.js";
import { activeFile, claudeDir, claudeFile, claudePidFromEnv, projectDir, readJson, transcriptForSession, writeJson, type ActiveSession } from "./transcript/locate.js";
import { runningSessions } from "./transcript/trash.js";
import { readLogin, RemoteError } from "./remote/credentials.js";
import { compareVersions, installKind, packageRoot, runCommand, type RunCommand } from "./update.js";
import { VERSION } from "./version.js";
import { isAlive } from "./viewer.js";
import { observersDir } from "./observers.js";

/** `ok` passes, `warn` is worth a look (or a repair), `error` keeps cco from working as it should; only errors fail `cco doctor`. */
export type Severity = "ok" | "warn" | "error";

export const DOCTOR_GROUPS = ["Installation", "State files", "Settings", "Environment", "Hooks"] as const;
export type DoctorGroup = (typeof DOCTOR_GROUPS)[number];

/** A repair: files changed in this process, or commands run one after the other. */
export interface Repair {
  /** Findings that share a repair (the settings' keys) name the same id; it runs once. */
  id: string;
  /** What it does, e.g. "delete 3 state files". */
  label: string;
  commands?: string[];
  apply?: () => void;
}

export interface Finding {
  group: DoctorGroup;
  severity: Severity;
  text: string;
  /** What to do by hand. */
  hint?: string;
  /** The files it is about. */
  paths?: string[];
  repair?: Repair;
}

export interface DoctorOptions {
  /** The project whose hooks are checked. */
  cwd: string;
  /** The Claude Code process the check runs under (CLAUDE_PID): its session is the one checked. */
  claudePid?: number;
  env?: NodeJS.ProcessEnv;
  /** The package folder of the running cco. */
  root?: string;
  now?: number;
}

const PLUGIN = "cco@cc-outline";
/** The files in ~/.claude/cco that belong to no project. */
const GLOBAL_FILES = new Set(["settings.json", "favorites.json", "releases.json", "version.json", "cli.json", "export.json"]);
/** A project's session marked ended this long ago is history: no viewer waits for it any more. */
const ENDED_AGE_MS = 24 * 60 * 60 * 1000;
/** A `.corrupt` copy is kept this long for a look, then counts as a leftover. */
const CORRUPT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The hooks write a prompt's time just before Claude Code writes the prompt. */
const HOOK_SLACK_MS = 5000;
const LIST_MAX = 5;

const ccoDir = () => join(claudeDir(), "cco");

export function tilde(path: string): string {
  const home = homedir();
  return path.toLowerCase().startsWith(home.toLowerCase()) ? "~" + path.slice(home.length) : path;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The parsed file, `undefined` if it is missing, `null` if it is not JSON. */
function parseFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const removeAll = (paths: string[]) => () => {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
};

// ---------------------------------------------------------------- Installation

function installation(root: string, version: string): Finding[] {
  const group = "Installation";
  const kind = installKind(root);
  const findings: Finding[] = [
    { group, severity: "ok", text: L().doctor.installed(kind === "npm" ? L().doctor.npm : L().doctor.dev, version, tilde(root)) },
  ];

  const cli = join(root, "dist", "cli.js");
  const recordCli: Repair = { id: "cli", label: L().doctor.recordCli(tilde(cli)), apply: () => writeJson(cliFile(), { cli }) };
  const recorded = parseFile(cliFile());
  if (recorded === undefined)
    findings.push({
      group,
      severity: "warn",
      text: L().doctor.cliMissing,
      repair: recordCli,
    });
  // Not JSON: State files renames it.
  else if (recorded !== null) {
    const path = isObject(recorded) ? recorded.cli : undefined;
    if (typeof path === "string" && existsSync(path)) findings.push({ group, severity: "ok", text: L().doctor.launcher(tilde(path)) });
    else
      findings.push({
        group,
        severity: "error",
        text: typeof path === "string" ? L().doctor.cliGone(tilde(path)) : L().doctor.cliNone,
        repair: recordCli,
      });
  }

  const entries = readJson<{ plugins?: Record<string, { version?: unknown; scope?: unknown }[]> }>(join(claudeDir(), "plugins", "installed_plugins.json"))?.plugins?.[PLUGIN];
  const installed = Array.isArray(entries) ? (entries.find((e) => e?.scope === "user") ?? entries[0]) : undefined;
  if (!installed) {
    findings.push({
      group,
      severity: "error",
      text: L().doctor.notInstalled(PLUGIN),
      hint: L().doctor.thenRestart(`claude plugin marketplace add "${root}" && claude plugin install ${PLUGIN}`),
    });
    return findings;
  }
  const enabled = readJson<{ enabledPlugins?: Record<string, unknown> }>(join(claudeDir(), "settings.json"))?.enabledPlugins?.[PLUGIN];
  if (enabled === false)
    findings.push({ group, severity: "error", text: L().doctor.disabled(PLUGIN), hint: L().doctor.thenRestart(`claude plugin enable ${PLUGIN}`) });
  const pluginVersion = typeof installed.version === "string" ? installed.version : undefined;
  const cmp = pluginVersion ? compareVersions(pluginVersion, version) : 0;
  if (pluginVersion && cmp < 0) {
    const commands = ["claude plugin marketplace update cc-outline", `claude plugin update ${PLUGIN}`];
    findings.push({
      group,
      severity: "warn",
      text: L().doctor.older(pluginVersion, version),
      hint: kind === "npm" ? L().doctor.restartOnly : L().doctor.thenRestart(commands.join(" && ")),
      repair: kind === "npm" ? { id: "plugin", label: L().doctor.updatePlugin, commands } : undefined,
    });
  } else if (pluginVersion && cmp > 0)
    findings.push({
      group,
      severity: "warn",
      text: L().doctor.newer(pluginVersion, version),
      hint: kind === "npm" ? "npm install -g cc-outline@latest" : L().doctor.rebuild,
    });
  else if (enabled !== false) findings.push({ group, severity: "ok", text: L().doctor.pluginOk(`${PLUGIN}${pluginVersion ? ` v${pluginVersion}` : ""}`) });
  return findings;
}

// ---------------------------------------------------------------- State files

const PID_FILE = /^([A-Za-z0-9-]+)\.(claude|viewer|control)-(\d+)\.json$/;
const LEGACY_FILE = /^([A-Za-z0-9-]+)\.(viewer|control)\.json$/;
const RESTORE_FILE = /^([A-Za-z0-9-]+)\.restore\.json$/;
const ACTIVE_FILE = /^[A-Za-z0-9-]+\.json$/;

function stateFiles(now: number): Finding[] {
  const group = "State files";
  const dir = ccoDir();
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch {
    return [{ group, severity: "ok", text: L().doctor.noDir(tilde(dir)) }];
  }
  const stale: string[] = [];
  const leftovers: string[] = [];
  const corrupt: string[] = [];
  const ended: string[] = [];
  const orphaned: string[] = [];
  const mtime = (p: string) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return now;
    }
  };
  const legacyViewerAlive = (slug: string) => {
    const info = parseFile(join(dir, `${slug}.viewer.json`));
    return isObject(info) && typeof info.pid === "number" && isAlive(info.pid);
  };
  for (const name of names) {
    const path = join(dir, name);
    // `<file>.<pid>.tmp` of writeJson: a process that died between write and rename.
    if (name.endsWith(".tmp")) {
      const pid = Number(name.split(".").at(-2));
      if (!(Number.isInteger(pid) && pid > 0 && isAlive(pid))) leftovers.push(path);
      continue;
    }
    const debug = /^debug-(\d+)\.log$/.exec(name);
    if (debug) {
      if (!isAlive(Number(debug[1]))) leftovers.push(path);
      continue;
    }
    if (name.endsWith(".corrupt")) {
      if (now - mtime(path) > CORRUPT_AGE_MS) leftovers.push(path);
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const data = parseFile(path);
    if (data === undefined) continue;
    if (!isObject(data)) {
      corrupt.push(path);
      continue;
    }
    const pidFile = PID_FILE.exec(name);
    if (pidFile) {
      if (!isAlive(Number(pidFile[3]))) stale.push(path);
      continue;
    }
    const legacy = LEGACY_FILE.exec(name);
    if (legacy) {
      if (!legacyViewerAlive(legacy[1])) stale.push(path);
      continue;
    }
    const restore = RESTORE_FILE.exec(name);
    if (restore) {
      if (!existsSync(join(claudeDir(), "projects", restore[1]))) orphaned.push(path);
      continue;
    }
    if (ACTIVE_FILE.test(name) && !GLOBAL_FILES.has(name) && data.ended === true) {
      const updated = typeof data.updated === "string" ? Date.parse(data.updated) : Number.NaN;
      if (!(now - (Number.isNaN(updated) ? mtime(path) : updated) < ENDED_AGE_MS)) ended.push(path);
    }
  }
  const trash = trashOrphans();
  // Observers register below the default folder, whichever account they read.
  stale.push(...staleObservers());

  const findings: Finding[] = [];
  const add = (paths: string[], text: string, id: string, label: string, apply: () => void) =>
    paths.length > 0 && findings.push({ group, severity: "warn", text, paths, repair: { id, label, apply } });
  const t = L().doctor;
  add(stale, t.stale(stale.length), "stale", t.staleRepair(stale.length), removeAll(stale));
  add(corrupt, t.corrupt(corrupt.length), "corrupt", t.corruptRepair(corrupt.length), () => {
    for (const p of corrupt) if (existsSync(p)) renameSync(p, `${p}.corrupt`);
  });
  add(leftovers, t.leftovers(leftovers.length), "leftovers", t.leftoversRepair(leftovers.length), removeAll(leftovers));
  add(ended, t.ended(ended.length), "ended", t.endedRepair(ended.length), removeAll(ended));
  add(orphaned, t.orphaned(orphaned.length), "orphaned", t.orphanedRepair(orphaned.length), removeAll(orphaned));
  add(trash, t.trash(trash.length), "trash", t.trashRepair(trash.length), removeAll(trash));
  if (findings.length === 0) findings.push({ group, severity: "ok", text: t.clean(tilde(dir)) });
  return findings;
}

/** Registrations of observers that no longer run, or files there that are none. */
function staleObservers(): string[] {
  const dir = observersDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((n) => join(dir, n))
    .filter((path) => {
      const info = parseFile(path);
      return !(isObject(info) && typeof info.pid === "number" && isAlive(info.pid));
    });
}

/** Folders in the trash the Sessions view cannot show: a session without a readable manifest, or a project's folder left empty. */
function trashOrphans(): string[] {
  const root = join(ccoDir(), "trash");
  const orphans: string[] = [];
  let slugs: string[];
  try {
    slugs = readdirSync(root);
  } catch {
    return [];
  }
  for (const slug of slugs) {
    let ids: string[];
    try {
      ids = readdirSync(join(root, slug));
    } catch {
      continue;
    }
    if (ids.length === 0) orphans.push(join(root, slug));
    for (const id of ids) if (!isObject(parseFile(join(root, slug, id, "manifest.json")))) orphans.push(join(root, slug, id));
  }
  return orphans;
}

// ---------------------------------------------------------------- Settings

/** Keys of former formats `readSettings` takes over, which the doctor names. */
const LEGACY_SETTINGS = ["updateCheck", "pinnedGroup"];

function settingsCheck(): Finding[] {
  const group = "Settings";
  const file = settingsFile();
  const stored = parseFile(file);
  const t = L().doctor;
  if (stored === undefined) return [{ group, severity: "ok", text: t.noSettings }];
  // Not JSON: State files renames it.
  if (!isObject(stored)) return [];
  const applied = readSettings();
  const repair: Repair = { id: "settings", label: t.rewrite, apply: () => writeJson(file, readSettings()) };
  const findings: Finding[] = [];
  const show = (v: unknown) => JSON.stringify(v);
  for (const [key, value] of Object.entries(stored)) {
    if (LEGACY_SETTINGS.includes(key)) {
      findings.push({ group, severity: "warn", text: t.oldFormat(key, t.legacy[key] ?? key), repair });
      continue;
    }
    if (!(key in DEFAULT_SETTINGS)) {
      findings.push({ group, severity: "warn", text: t.unknown(key), repair });
      continue;
    }
    const k = key as keyof Settings;
    if (applied[k] === value) continue;
    const migrated = typeof value === "boolean" && k === "showTools";
    findings.push({
      group,
      severity: "warn",
      text: migrated ? t.migrated(k, show(value), show(applied[k])) : t.invalid(k, show(value), show(applied[k])),
      repair,
    });
  }
  if (findings.length === 0) findings.push({ group, severity: "ok", text: t.valid });
  return findings;
}

// ---------------------------------------------------------------- Environment

function environment(env: NodeJS.ProcessEnv): Finding[] {
  const group = "Environment";
  const findings: Finding[] = [];
  const major = Number.parseInt(process.versions.node, 10);
  findings.push(
    major >= 22
      ? { group, severity: "ok", text: L().doctor.node(process.versions.node) }
      : { group, severity: "error", text: L().doctor.nodeOld(process.versions.node), hint: L().doctor.installNode },
  );
  const dir = claudeDir();
  const where = env.CLAUDE_CONFIG_DIR ? `CLAUDE_CONFIG_DIR ${tilde(dir)}` : tilde(dir);
  findings.push(
    existsSync(dir)
      ? { group, severity: "ok", text: L().doctor.folder(where) }
      : { group, severity: "error", text: L().doctor.folderGone(where), hint: L().doctor.checkFolder },
  );
  const terminal = detectTerminal(env);
  if (terminal === "tmux") findings.push({ group, severity: "ok", text: L().doctor.terminal("tmux") });
  else if (terminal === "wt" && env.WT_SESSION) findings.push({ group, severity: "ok", text: L().doctor.terminal("Windows Terminal") });
  else if (terminal === "wt")
    findings.push({
      group,
      severity: "warn",
      text: L().doctor.noWtSession,
      hint: L().doctor.startAnew,
    });
  else
    findings.push({
      group,
      severity: "warn",
      text: L().doctor.noTerminal,
      hint: L().doctor.ownTerminal,
    });
  if (readSettings().remoteApi) findings.push(remoteLogin(dir));
  return findings;
}

/** The remote API (setting remoteApi) needs the login Claude Code keeps; whether claude.ai accepts it shows in the Sessions view. */
function remoteLogin(dir: string): Finding {
  const group = "Environment";
  try {
    readLogin(dir);
    return { group, severity: "ok", text: L().doctor.loginFound };
  } catch (err) {
    if (!(err instanceof RemoteError)) throw err;
    return { group, severity: "warn", text: L().doctor.remote(err.message), hint: L().doctor.remoteHint };
  }
}

// ---------------------------------------------------------------- Hooks

/** The time of the last prompt typed in the transcript, from its last 512 KB; undefined if there is none. */
export function lastPromptTime(transcript: string): number | undefined {
  let text: string;
  try {
    const size = statSync(transcript).size;
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(transcript, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    text = buffer.toString("utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (e.type !== "user" || e.isMeta || e.isSidechain || e.isCompactSummary || typeof e.timestamp !== "string") continue;
    const origin = (e.origin as { kind?: unknown } | undefined)?.kind;
    if (origin === "task-notification" || origin === "peer") continue;
    const content = (e.message as { content?: unknown } | undefined)?.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as { type?: string; text?: string }[]) : [];
    if (blocks.some((b) => b.type === "tool_result")) continue;
    const first = blocks.find((b) => b.type === "text")?.text ?? "";
    // Shell commands, their output and local commands run no UserPromptSubmit hook.
    if (/^\s*<(bash-|local-command|command-name|task-notification)/.test(first)) continue;
    if (blocks.length === 0) continue;
    return Date.parse(e.timestamp);
  }
  return undefined;
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

function hooks(cwd: string, claudePid: number | undefined): Finding[] {
  const group = "Hooks";
  // Only a running session says anything: after Claude Code exits, the hooks have nothing to record.
  const running = [...runningSessions()]
    .map(([id, s]) => ({ ...s, transcript: transcriptForSession(cwd, id) }))
    .filter((s) => existsSync(s.transcript));
  const own = running.filter((s) => s.pid === claudePid);
  const candidates = own.length > 0 ? own : running;
  if (candidates.length === 0) return [{ group, severity: "ok", text: L().doctor.noClaude(tilde(cwd)) }];
  const session = candidates.map((s) => ({ ...s, mtime: statSync(s.transcript).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0];
  const states = [claudeFile(cwd, session.pid), activeFile(cwd)].map((f) => readJson<ActiveSession>(f)).filter((s) => isObject(s));
  const updated = Math.max(...states.map((s) => (typeof s.updated === "string" ? Date.parse(s.updated) : Number.NaN)).filter((t) => !Number.isNaN(t)), -Infinity);
  const hint = L().doctor.hooksHint;
  if (updated === -Infinity) return [{ group, severity: "error", text: L().doctor.noRecord(tilde(projectDir(cwd))), hint }];
  const prompt = lastPromptTime(session.transcript);
  if (prompt !== undefined && updated < prompt - HOOK_SLACK_MS)
    return [{ group, severity: "error", text: L().doctor.late(clock(prompt), clock(updated)), hint }];
  return [{ group, severity: "ok", text: L().doctor.recorded(clock(updated)) }];
}

// ---------------------------------------------------------------- Running

/** Every check, grouped as `DOCTOR_GROUPS`. */
export function diagnose(options: DoctorOptions): Finding[] {
  return DOCTOR_GROUPS.flatMap((group) => diagnoseGroup(group, options));
}

/** The checks of one group; one that throws becomes an error finding. */
export function diagnoseGroup(group: DoctorGroup, options: DoctorOptions): Finding[] {
  const env = options.env ?? process.env;
  const checks: Record<DoctorGroup, () => Finding[]> = {
    Installation: () => installation(options.root ?? packageRoot(), VERSION),
    "State files": () => stateFiles(options.now ?? Date.now()),
    Settings: () => settingsCheck(),
    Environment: () => environment(env),
    Hooks: () => hooks(options.cwd, options.claudePid ?? claudePidFromEnv(env)),
  };
  try {
    return checks[group]();
  } catch (err) {
    return [{ group, severity: "error", text: L().doctor.failed((err as Error).message) }];
  }
}

/** The repairs the findings offer, each once. */
export function repairsOf(findings: Finding[]): Repair[] {
  const repairs = new Map<string, Repair>();
  for (const f of findings) if (f.repair && f.severity !== "ok" && !repairs.has(f.repair.id)) repairs.set(f.repair.id, f.repair);
  return [...repairs.values()];
}

export function countFindings(findings: Finding[]): { errors: number; warnings: number; repairable: number } {
  return {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warn").length,
    repairable: findings.filter((f) => f.severity !== "ok" && f.repair).length,
  };
}

/** "1 error, 3 warnings" or "no problems". */
export function countText(findings: Finding[]): string {
  const { errors, warnings } = countFindings(findings);
  if (errors + warnings === 0) return L().doctor.noProblems;
  return [errors > 0 ? L().doctor.errors(errors) : "", warnings > 0 ? L().doctor.warnings(warnings) : ""].filter(Boolean).join(", ");
}

/** One step of a repair: a command, or a change of files. */
export interface RepairStep {
  label: string;
  command?: string;
  apply?: () => void;
}

export interface RepairResult {
  step: RepairStep;
  status: "pending" | "running" | "done" | "failed";
  output: string;
}

export function repairSteps(repairs: Repair[]): RepairStep[] {
  return repairs.flatMap((r): RepairStep[] => (r.commands ? r.commands.map((command) => ({ label: r.label, command })) : [{ label: r.label, apply: r.apply }]));
}

/** Runs every step, also after one failed (the repairs do not depend on each other); reports every change. True if all succeeded. */
export async function runRepairs(steps: RepairStep[], onProgress: (results: RepairResult[]) => void, run: RunCommand = runCommand): Promise<boolean> {
  const results: RepairResult[] = steps.map((step) => ({ step, status: "pending", output: "" }));
  const report = () => onProgress(results.map((r) => ({ ...r })));
  for (const r of results) {
    r.status = "running";
    report();
    let ok: boolean;
    try {
      if (r.step.command)
        ok =
          (await run(r.step.command, (text) => {
            r.output += text;
            report();
          })) === 0;
      else {
        r.step.apply?.();
        ok = true;
      }
    } catch (err) {
      r.output += (err as Error).message;
      ok = false;
    }
    r.status = ok ? "done" : "failed";
    report();
  }
  return results.every((r) => r.status === "done");
}

export const SEVERITY_MARKS: Record<Severity, string> = { ok: "✓", warn: "!", error: "✗" };

const COLORS: Record<Severity, number> = { ok: 32, warn: 33, error: 31 };

/** The report as lines: per group its findings, with files (up to 5), hint and repair below. */
export function reportLines(findings: Finding[], color: boolean): string[] {
  const paint = (code: number, s: string) => (color ? `\u001b[${code}m${s}\u001b[39m` : s);
  const dim = (s: string) => (color ? `\u001b[2m${s}\u001b[22m` : s);
  const bold = (s: string) => (color ? `\u001b[1m${s}\u001b[22m` : s);
  const lines: string[] = [];
  for (const group of DOCTOR_GROUPS) {
    const own = findings.filter((f) => f.group === group);
    if (own.length === 0) continue;
    lines.push("", bold(L().doctor.groups[group] ?? group));
    for (const f of own) {
      lines.push(`  ${paint(COLORS[f.severity], SEVERITY_MARKS[f.severity])} ${f.text}`);
      const paths = f.paths ?? [];
      for (const p of paths.slice(0, LIST_MAX)) lines.push(`      ${dim(tilde(p))}`);
      if (paths.length > LIST_MAX) lines.push(`      ${dim(L().doctor.andMore(paths.length - LIST_MAX))}`);
      if (f.severity === "ok") continue;
      if (f.hint) lines.push(`      ${f.hint}`);
      if (f.repair) lines.push(`      ${dim(L().doctor.repair(f.repair.label))}`);
    }
  }
  return lines;
}

/** `cco doctor`: prints the report, with `fix` repairs and checks again. Returns the exit code: 1 if an error is left. */
export async function runDoctor(options: DoctorOptions & { fix?: boolean; out?: (line: string) => void; color?: boolean }): Promise<number> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const color = options.color ?? process.stdout.isTTY === true;
  let findings = diagnose(options);
  out(`cco doctor · v${VERSION}`);
  for (const line of reportLines(findings, color)) out(line);
  const repairs = repairsOf(findings);
  out("");
  if (!options.fix) {
    out(L().doctor.summary(countText(findings), repairs.length > 0 ? countFindings(findings).repairable : 0));
    return countFindings(findings).errors > 0 ? 1 : 0;
  }
  if (repairs.length === 0) {
    out(L().doctor.nothing(countText(findings)));
    return countFindings(findings).errors > 0 ? 1 : 0;
  }
  out(L().doctor.repairing);
  // Each step once, when it has finished.
  const printed = new Set<number>();
  await runRepairs(repairSteps(repairs), (results) => {
    for (const [i, r] of results.entries()) {
      if ((r.status !== "done" && r.status !== "failed") || printed.has(i)) continue;
      printed.add(i);
      out(`  ${r.status === "done" ? "✓" : "✗"} ${r.step.command ?? r.step.label}`);
      if (r.status === "failed") for (const l of r.output.trim().split(/\r?\n/).slice(-12)) out(`      ${l}`);
    }
  });
  findings = diagnose(options);
  out("");
  out(L().doctor.after);
  for (const line of reportLines(findings, color)) out(line);
  out("");
  out(`${countText(findings)}.`);
  return countFindings(findings).errors > 0 ? 1 : 0;
}
