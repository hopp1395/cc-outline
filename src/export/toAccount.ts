import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { L } from "../i18n/index.js";
import { basename, dirname, join, resolve } from "node:path";
import { claudeDir, inClaudeDir } from "../transcript/locate.js";
import type { SessionSummary } from "../transcript/sessions.js";
import { backupFiles, mergeCcoData, relocatedData } from "./archive.js";
import { relocatePath, relocateText, slugsWith, type Relocation } from "./relocate.js";
import { loadSession, sessionCcoData } from "./session.js";

/** A session copied into another account's config folder. */
export interface AccountCopy {
  /** Its id there: the same, or a new one when that account has the id already. */
  id: string;
  /** Its transcript there. */
  path: string;
  /** Old id → new one for every id of the chain; empty when they stayed. */
  ids: Map<string, string>;
}

/**
 * Copies the session `s` of this process's config folder into the config folder `target` (another account), so
 * `claude --resume` under that account continues it: every transcript of its chain with its folder (subagents,
 * tool results), its file history, session environment and the pasted images it names, with the paths into
 * this config folder rewritten to that one. The project folder stays the same. If the target has one of the
 * chain's ids already (continued there before), the copy gets new ids, so nothing there is overwritten. cco's
 * marks, positions, view and placement of it are merged into the target's. The original stays as it is.
 * Files are written first and removed again on a failure.
 */
export function copyToAccount(s: SessionSummary, target: string): AccountCopy {
  const root = claudeDir();
  if (sameDir(root, target)) throw new Error(L().core.sameAccount);
  const session = loadSession(s);
  const slug = basename(dirname(s.path));
  const chain = [...(s.continues ?? []), s.id];
  const taken = inClaudeDir(target, () => chain.some((id) => slugsWith(id).length > 0 || existsSync(join(claudeDir(), "file-history", id))));
  const ids = new Map(taken ? chain.map((id) => [id, randomUUID()] as const) : []);
  const relocation: Relocation = { from: s.cwd, to: s.cwd ?? "", claudeFrom: root, claudeTo: target, slugFrom: slug, slugTo: slug, ids };
  const cco = s.cwd ? sessionCcoData(session, s.cwd, s.cwd) : undefined;
  const written: string[] = [];
  try {
    for (const rel of backupFiles(session)) {
      const to = join(target, ...relocatePath(rel, relocation).split("/"));
      // A pasted image another session shares is there already.
      if (existsSync(to)) continue;
      const data = relocatedData(rel, readFileSync(join(root, ...rel.split("/"))), relocation);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, data);
      written.push(to);
    }
  } catch (err) {
    for (const f of written) rmSync(f, { force: true });
    throw err;
  }
  const id = ids.get(s.id) ?? s.id;
  if (cco && s.cwd) {
    const cwd = s.cwd;
    try {
      const data = JSON.parse(relocateText(JSON.stringify(cco), relocation, true));
      inClaudeDir(target, () => mergeCcoData(cwd, data, id));
    } catch {
      // The session is copied; its marks and positions are a nicety.
    }
  }
  return { id, path: join(target, "projects", slug, `${id}.jsonl`), ids };
}

const sameDir = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
