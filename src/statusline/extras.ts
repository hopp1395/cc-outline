import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { accountColorName, readAccount } from "../account.js";
import { claudeDir, readJson, todosFile } from "../transcript/locate.js";
import type { StatusExtras, StatusInput } from "./render.js";
import { PRESET_LINES, type Segment, type StatusLinePreset } from "./render.js";

/** The branch of the repository `dir` is in, from its `HEAD` file (no git process: the line runs after every message). */
export function branchOf(dir: string): string | undefined {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const git = join(at, ".git");
    let head: string | undefined;
    try {
      if (statSync(git).isDirectory()) head = readFileSync(join(git, "HEAD"), "utf8");
      else {
        // A worktree or submodule: .git names the folder that holds HEAD.
        const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, "utf8"))?.[1]?.trim();
        if (target) head = readFileSync(join(resolve(at, target), "HEAD"), "utf8");
      }
    } catch {
      // no .git here
    }
    if (head !== undefined) {
      const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim();
      return ref ?? (head.trim().slice(0, 7) || undefined);
    }
    if (dirname(at) === at) return undefined;
  }
}

/** The account of this config folder as the line shows it: its avatar, else the email's name, in its colour unless that is off. */
export function accountBadge(dir = claudeDir()): StatusExtras["account"] {
  const account = readAccount(dir);
  if (!account) return undefined;
  const label = account.avatar ?? account.email.split("@")[0];
  const chosen = account.chosenColor ?? "auto";
  return { label, color: chosen === "off" ? undefined : accountColorName(account.email, chosen) };
}

/** Open items (not done) in the to-do lists of the project `cwd`. */
export function openTodos(cwd: string): number {
  const stored = readJson<{ lists?: { items?: { status?: unknown }[] }[] }>(todosFile(cwd));
  let open = 0;
  for (const list of Array.isArray(stored?.lists) ? stored.lists : []) for (const item of Array.isArray(list?.items) ? list.items : []) if (item?.status !== "done") open++;
  return open;
}

/** Runs `read`, leaving the part out if it fails: a segment never breaks the line. */
function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** What the preset needs of cco's files, and nothing more. */
export function gatherExtras(preset: StatusLinePreset, input: StatusInput, dir = claudeDir()): StatusExtras {
  const needs = new Set<Segment>(PRESET_LINES[preset].flat());
  const project = input.workspace?.project_dir ?? input.cwd;
  const current = input.workspace?.current_dir ?? input.cwd;
  return {
    branch: needs.has("branch") && current ? safely(() => branchOf(current)) : undefined,
    account: needs.has("account") ? safely(() => accountBadge(dir)) : undefined,
    todos: needs.has("todos") && project ? safely(() => openTodos(project)) : undefined,
  };
}
