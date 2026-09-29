import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { independentEnv } from "./open.js";
import { claudeDir, readJson, writeJson } from "./transcript/locate.js";

/** Where the latest published version comes from: npm is what `npm install -g` installs. */
const NPM_URL = "https://registry.npmjs.org/cc-outline/latest";
/** The release notes: the body of each GitHub release, written by /cco-release. */
const GITHUB_URL = "https://api.github.com/repos/hopp1395/cc-outline/releases?per_page=100";
const TIMEOUT_MS = 5000;

export interface Release {
  /** `v0.7.0` */
  tag: string;
  /** `0.7.0` */
  version: string;
  title: string;
  /** The notes, Markdown. */
  body: string;
  /** ISO time it was published. */
  date?: string;
  url?: string;
}

/** What the last check found, cached in `releases.json`. */
export interface ReleaseCache {
  latest?: string;
  /** Newest first. */
  releases: Release[];
  /** Epoch ms of the last check that reached npm or GitHub. */
  checkedAt: number;
}

/** One check's result; a part is undefined if its source could not be reached. */
export interface Fetched {
  latest?: string;
  releases?: Release[];
}

/** Compares `x.y.z` versions (a leading `v` and a `-pre` suffix are ignored): negative, 0 or positive. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** The notes without the closing `**Full changelog:** <compare url>` line /cco-release adds: it only links to GitHub. */
export function withoutChangelogLink(body: string): string {
  return body.replace(/^\s*\**Full changelog:?\**:?.*$/gim, "").trimEnd();
}

/** The published releases of the GitHub API's answer, newest first; undefined if it is not a list. */
export function parseReleases(data: unknown): Release[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  return data
    .filter((r) => r && typeof r.tag_name === "string" && !r.draft && !r.prerelease)
    .map(
      (r): Release => ({
        tag: r.tag_name,
        version: r.tag_name.replace(/^v/, ""),
        title: str(r.name) ?? r.tag_name,
        body: withoutChangelogLink((str(r.body) ?? "").replace(/\r\n/g, "\n")),
        date: str(r.published_at),
        url: str(r.html_url),
      }),
    )
    .sort((a, b) => compareVersions(b.version, a.version));
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "cc-outline" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/** Asks npm for the latest version and GitHub for the release notes, both at once. */
export async function fetchReleases(): Promise<Fetched> {
  const [npm, github] = await Promise.allSettled([getJson(NPM_URL), getJson(GITHUB_URL)]);
  const version = npm.status === "fulfilled" ? (npm.value as { version?: unknown } | null)?.version : undefined;
  return {
    latest: typeof version === "string" ? version : undefined,
    releases: github.status === "fulfilled" ? parseReleases(github.value) : undefined,
  };
}

/** The cache with what a check found; parts it could not reach stay as cached. Undefined if there is nothing. */
export function mergeReleases(cached: ReleaseCache | undefined, fetched: Fetched, now = Date.now()): ReleaseCache | undefined {
  const reached = fetched.latest !== undefined || fetched.releases !== undefined;
  if (!reached) return cached;
  return {
    latest: fetched.latest ?? cached?.latest,
    releases: fetched.releases ?? cached?.releases ?? [],
    checkedAt: now,
  };
}

export function releasesFile(): string {
  return join(claudeDir(), "cco", "releases.json");
}

export function readCachedReleases(): ReleaseCache | undefined {
  const cache = readJson<ReleaseCache>(releasesFile());
  return cache && Array.isArray(cache.releases) && typeof cache.checkedAt === "number" ? cache : undefined;
}

export function saveReleases(cache: ReleaseCache): void {
  writeJson(releasesFile(), cache);
}

/** The folder of the running package: this module lies in `dist/` (or `src/`) below it. */
export function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * `npm` for an installed package (`…/node_modules/cc-outline`), which
 * `npm install -g` updates; `dev` for a checkout run through `npm link` (Node
 * resolves the link, so the path is the checkout's) or an npx cache, which it must not touch.
 */
export type InstallKind = "npm" | "dev";

export function installKind(root: string): InstallKind {
  const parts = root.split(/[\\/]/);
  if (parts.includes("_npx")) return "dev";
  return parts.at(-2) === "node_modules" && parts.at(-1) === "cc-outline" ? "npm" : "dev";
}

/** The version of the package on disk, which is newer than the running one after an update. */
export function installedVersion(root: string): string | undefined {
  try {
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the viewer offers: `update` to a newer published version, `restart`
 * when another viewer already installed one, `dev` when a newer one is out but
 * this is no npm install.
 */
export type UpdateState = { kind: "none" } | { kind: "update" | "restart" | "dev"; target: string };

export function updateState(latest: string | undefined, running: string, install: InstallKind, installed: string | undefined): UpdateState {
  if (install === "npm" && installed && compareVersions(installed, running) > 0) return { kind: "restart", target: installed };
  if (!latest || compareVersions(latest, running) <= 0) return { kind: "none" };
  return { kind: install === "npm" ? "update" : "dev", target: latest };
}

export interface UpdateStep {
  label: string;
  command: string;
}

/** The CLI, then the plugin from the marketplace the npm package carries (README: Updating). */
export const UPDATE_STEPS: UpdateStep[] = [
  { label: "CLI", command: "npm install -g cc-outline@latest" },
  { label: "marketplace", command: "claude plugin marketplace update cc-outline" },
  { label: "plugin", command: "claude plugin update cco@cc-outline" },
];

export interface StepResult {
  step: UpdateStep;
  status: "pending" | "running" | "done" | "failed";
  output: string;
}

/** Runs `command`, reporting its output; resolves with the exit code. */
export type RunCommand = (command: string, onOutput: (text: string) => void) => Promise<number>;

/**
 * Runs the command through the shell: on Windows npm and claude can be `.cmd`
 * shims, which Node starts only that way. The command is fixed text, and
 * without the variables of the Claude Code session the viewer came from.
 */
const runCommand: RunCommand = (command, onOutput) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, env: independentEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => onOutput(String(d)));
    child.stderr.on("data", (d) => onOutput(String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });

/**
 * Runs the steps one after the other and stops at the first that fails; the
 * steps after it stay `pending`. Reports every change. True if all succeeded.
 */
export async function runUpdate(onProgress: (steps: StepResult[]) => void, run: RunCommand = runCommand, steps = UPDATE_STEPS): Promise<boolean> {
  const results: StepResult[] = steps.map((step) => ({ step, status: "pending", output: "" }));
  const report = () => onProgress(results.map((r) => ({ ...r })));
  for (const r of results) {
    r.status = "running";
    report();
    let code: number;
    try {
      code = await run(r.step.command, (text) => {
        r.output += text;
        report();
      });
    } catch (err) {
      r.output += (err as Error).message;
      code = -1;
    }
    r.status = code === 0 ? "done" : "failed";
    report();
    if (code !== 0) return false;
  }
  return true;
}

/** The commands still to run by hand after a failed update: the failed step and those after it. */
export function remainingCommands(steps: StepResult[]): string[] {
  const from = steps.findIndex((s) => s.status !== "done");
  return from < 0 ? [] : steps.slice(from).map((s) => s.step.command);
}
