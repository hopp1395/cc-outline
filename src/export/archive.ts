import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { readFavorites, toggleFavorite } from "../favorites.js";
import { readPositions, rememberScroll, savePositions, type PositionList } from "../positions.js";
import { readSettings, PLACEMENT_VALUES, type Placement } from "../settings.js";
import { readSessionPlacement, readSessionView, saveSessionPlacement, saveSessionView } from "../sessionViews.js";
import { claudeDir, readJson, writeJson } from "../transcript/locate.js";
import type { SessionSummary } from "../transcript/sessions.js";
import { sessionItems } from "../transcript/trash.js";
import { TOOL_LEVELS } from "../transcript/tools.js";
import type { Mode } from "../tui/layout.js";
import { VERSION } from "../version.js";
import {
  EXPORT_FORMATS,
  ImageSource,
  loadSession,
  sessionCcoData,
  sessionFolder,
  sessionJson,
  sessionMarkdown,
  type AgentExport,
  type ExportFile,
  type ExportFormat,
  type ExportOptions,
  type LoadedSession,
  type SessionCcoData,
} from "./session.js";
import { readZip, ZipWriter } from "./zip.js";

/** The archive's name in the downloads folder; a taken name gets " (2)", " (3)", … */
export const EXPORT_NAME = "cco-session-export";
/** Marks a backup's manifest. */
const BACKUP_FORMAT = "cco-session-backup";

const AGENT_EXPORTS: AgentExport[] = ["none", "reports", "full"];

/** The export dialog's last choice, global like the settings. */
export function exportOptionsFile(): string {
  return join(claudeDir(), "cco", "export.json");
}

/** The options used last; for the first export, tools and thinking as the chat shows them. */
export function readExportOptions(): ExportOptions {
  const settings = readSettings();
  const stored = readJson<Partial<Record<keyof ExportOptions, unknown>>>(exportOptionsFile()) ?? {};
  return {
    tools: TOOL_LEVELS.includes(stored.tools as never) ? (stored.tools as ExportOptions["tools"]) : settings.showTools,
    thinking: typeof stored.thinking === "boolean" ? stored.thinking : settings.showThinking,
    agents: AGENT_EXPORTS.includes(stored.agents as never) ? (stored.agents as AgentExport) : "reports",
    stats: typeof stored.stats === "boolean" ? stored.stats : true,
  };
}

export function saveExportOptions(opts: ExportOptions): void {
  writeJson(exportOptionsFile(), opts);
}

/** Where exports go: `CCO_EXPORT_DIR` if set, else the user's Downloads folder, else the home folder. */
export function downloadsDir(): string {
  if (process.env.CCO_EXPORT_DIR) return process.env.CCO_EXPORT_DIR;
  const downloads = join(homedir(), "Downloads");
  return existsSync(downloads) ? downloads : homedir();
}

/** `<dir>/<name>.zip`, or the first of `<name> (2).zip`, `<name> (3).zip`, … that is free. */
export function freeName(dir: string, name: string): string {
  for (let n = 1; ; n++) {
    const file = join(dir, `${name}${n === 1 ? "" : ` (${n})`}.zip`);
    if (!existsSync(file)) return file;
  }
}

/** Every file below `path` (or `path` itself), with its path relative to `root`. */
function walk(path: string, root: string): string[] {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [relative(root, path)];
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return [];
  }
  return names.flatMap((n) => walk(join(path, n), root));
}

/** A backup's manifest: which session, where it belongs and which files it holds. */
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: 1;
  exportedAt: string;
  cco: string;
  id: string;
  /** All ids of the chain, oldest first; the last is `id`. */
  ids: string[];
  /** Folder name under ~/.claude/projects. */
  slug: string;
  cwd?: string;
  /** Files relative to ~/.claude, forward slashes; they are below `claude/` in the backup's folder. */
  files: string[];
  summary: SessionSummary;
}

const forward = (p: string) => p.split(sep).join("/");

/** The files of a session's backup, relative to ~/.claude: its parts as the trash takes them, and the pasted images it names. */
export function backupFiles(session: LoadedSession): string[] {
  const s = session.summary;
  const root = claudeDir();
  const projectDir = dirname(s.path);
  const ids = [...(s.continues ?? []), s.id];
  const parts = ids.flatMap((id) => sessionItems(projectDir, id)).flatMap((p) => walk(p, root));
  const uploads = join(root, "uploads");
  const images = session.turns.flatMap((t) =>
    (t.attachments ?? []).flatMap((a) => (a.kind === "image" && a.path && existsSync(a.path) && !relative(uploads, a.path).startsWith("..") ? [relative(root, a.path)] : [])),
  );
  return [...new Set([...parts, ...images].map(forward))];
}

/** How far the export is: the session (1-based) and the format being written. */
export interface ExportProgress {
  session: number;
  sessions: number;
  step: ExportFormat | "reading";
}

export interface ExportResult {
  file: string;
  sessions: number;
}

/**
 * Exports `sessions` into one zip archive in `dir` (the downloads folder):
 * per session a folder per format, `<YYYY-MM-DD-HHMM>-<id8>-<format>`. The
 * archive is written under a temporary name and renamed when complete.
 */
export async function exportSessions(
  sessions: SessionSummary[],
  opts: ExportOptions,
  env: { viewerCwd: string; dir?: string; onProgress?: (p: ExportProgress) => void; now?: Date },
): Promise<ExportResult> {
  const file = freeName(env.dir ?? downloadsDir(), EXPORT_NAME);
  const partial = `${file}.part`;
  const zip = new ZipWriter(partial);
  const now = env.now ?? new Date();
  const tick = () => new Promise((r) => setImmediate(r));
  try {
    for (const [i, summary] of sessions.entries()) {
      const report = (step: ExportProgress["step"]) => env.onProgress?.({ session: i + 1, sessions: sessions.length, step });
      report("reading");
      await tick();
      const session = loadSession(summary);
      const images = new ImageSource();
      const add = async (format: ExportFormat, main: string, doc: { text: string; files: ExportFile[] }) => {
        const folder = sessionFolder(summary, format);
        await zip.add(`${folder}/${main}`, doc.text, now);
        for (const f of doc.files) {
          const data = f.data();
          if (data !== undefined) await zip.add(`${folder}/${f.name}`, data, now);
        }
      };
      for (const format of EXPORT_FORMATS) {
        report(format);
        await tick();
        if (format === "markdown" || format === "llm") await add(format, "session.md", sessionMarkdown(session, opts, format, images, now));
        else if (format === "json") await add(format, "session.json", sessionJson(session, opts, images, now));
        else await addBackup(zip, session, env.viewerCwd, now);
      }
    }
    zip.close();
    renameSync(partial, file);
  } catch (err) {
    zip.abort();
    rmSync(partial, { force: true });
    throw err;
  }
  return { file, sessions: sessions.length };
}

async function addBackup(zip: ZipWriter, session: LoadedSession, viewerCwd: string, now: Date): Promise<void> {
  const s = session.summary;
  const folder = sessionFolder(s, "backup");
  const root = claudeDir();
  const files = backupFiles(session);
  const written: string[] = [];
  for (const rel of files) {
    const path = join(root, rel);
    let data: Buffer;
    let modified: Date;
    try {
      data = readFileSync(path);
      modified = statSync(path).mtime;
    } catch {
      // Gone since it was listed (a running session's temporary file).
      continue;
    }
    await zip.add(`${folder}/claude/${rel}`, data, modified);
    written.push(rel);
  }
  const cwd = s.cwd;
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: now.toISOString(),
    cco: VERSION,
    id: s.id,
    ids: [...(s.continues ?? []), s.id],
    slug: basename(dirname(s.path)),
    cwd,
    files: written,
    summary: s,
  };
  await zip.add(`${folder}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n", now);
  if (cwd) await zip.add(`${folder}/cco.json`, JSON.stringify(sessionCcoData(session, cwd, viewerCwd), null, 2) + "\n", now);
}

// --- Import -----------------------------------------------------------------------------------

export interface ImportResult {
  /** Titles or ids of the sessions imported. */
  imported: { id: string; title: string }[];
  skipped: { id: string; title: string; reason: string }[];
}

/** A path inside ~/.claude for a file of a backup; undefined if it would lead out of it. */
function insideClaude(rel: string): string | undefined {
  if (!rel || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return undefined;
  const target = normalize(join(claudeDir(), rel));
  const back = relative(claudeDir(), target);
  return back && !back.startsWith("..") && !isAbsolute(back) ? target : undefined;
}

/** Adds cco's data of an imported session to what the project has; nothing that is there is overwritten. */
export function mergeCcoData(cwd: string, data: Partial<SessionCcoData>, id: string): void {
  for (const kind of ["turns", "plans", "sessions"] as const) {
    const marked = new Set(readFavorites(cwd, kind));
    for (const key of data.favorites?.[kind] ?? []) if (typeof key === "string" && !marked.has(key)) toggleFavorite(cwd, kind, key);
  }
  for (const [list, scroll] of Object.entries(data.positions ?? {}) as [PositionList, Record<string, number>][]) {
    const positions = readPositions(cwd, list);
    let changed = false;
    for (const [key, n] of Object.entries(scroll ?? {})) {
      if (typeof n !== "number" || key in positions.scroll) continue;
      rememberScroll(positions, key, n);
      changed = true;
    }
    if (changed) savePositions(cwd, list, positions);
  }
  if (typeof data.view === "string" && !readSessionView(cwd, id)) saveSessionView(cwd, id, data.view as Mode);
  if (PLACEMENT_VALUES.includes(data.placement as Placement) && !readSessionPlacement(cwd, id)) saveSessionPlacement(cwd, id, data.placement as Placement);
}

/**
 * Imports the backups in the archive `file` into ~/.claude: per session its
 * files and cco's data. A session whose transcript is there already is
 * skipped, as is a pasted image that is there; the others are imported.
 */
export function importArchive(file: string): ImportResult {
  const entries = readZip(file);
  const result: ImportResult = { imported: [], skipped: [] };
  const manifests = entries.filter((e) => /^[^/]+-backup\/manifest\.json$/.test(e.name));
  if (manifests.length === 0) throw new Error("no session backups in this archive");
  for (const m of manifests) {
    const folder = m.name.slice(0, -"/manifest.json".length);
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(m.data().toString("utf8")) as BackupManifest;
    } catch {
      result.skipped.push({ id: folder, title: folder, reason: "unreadable manifest" });
      continue;
    }
    const title = manifest.summary?.title ?? manifest.summary?.prompts?.[0]?.text?.split("\n")[0] ?? manifest.id;
    if (manifest.format !== BACKUP_FORMAT || typeof manifest.id !== "string" || typeof manifest.slug !== "string") {
      result.skipped.push({ id: folder, title, reason: "not a session backup" });
      continue;
    }
    const projectDir = join(claudeDir(), "projects", manifest.slug);
    const ids = Array.isArray(manifest.ids) ? manifest.ids : [manifest.id];
    if (ids.some((id) => existsSync(join(projectDir, `${id}.jsonl`)))) {
      result.skipped.push({ id: manifest.id, title, reason: "already there" });
      continue;
    }
    const prefix = `${folder}/claude/`;
    const files = entries.filter((e) => e.name.startsWith(prefix) && !e.name.endsWith("/"));
    const targets = files.map((e) => ({ entry: e, target: insideClaude(e.name.slice(prefix.length)) }));
    const outside = targets.find((t) => !t.target);
    if (outside) {
      result.skipped.push({ id: manifest.id, title, reason: `unsafe path ${outside.entry.name}` });
      continue;
    }
    // Unpacked (and checked) first, so a damaged archive leaves nothing half imported.
    let data: { target: string; data: Buffer; modified: Date }[];
    try {
      data = targets.map((t) => ({ target: t.target!, data: t.entry.data(), modified: t.entry.modified }));
    } catch (err) {
      result.skipped.push({ id: manifest.id, title, reason: (err as Error).message });
      continue;
    }
    for (const d of data) {
      // A pasted image another session shares, or one left from before, stays as it is.
      if (existsSync(d.target)) continue;
      mkdirSync(dirname(d.target), { recursive: true });
      writeFileSync(d.target, d.data);
    }
    const cco = entries.find((e) => e.name === `${folder}/cco.json`);
    if (cco && manifest.cwd) {
      try {
        mergeCcoData(manifest.cwd, JSON.parse(cco.data().toString("utf8")) as Partial<SessionCcoData>, manifest.id);
      } catch {
        // The session is in; its marks and positions are a nicety.
      }
    }
    result.imported.push({ id: manifest.id, title });
  }
  return result;
}

/** The newest export archive in the downloads folder: what the import dialog proposes. */
export function newestExport(dir = downloadsDir()): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(EXPORT_NAME) && n.endsWith(".zip"));
  } catch {
    return undefined;
  }
  const mtime = (f: string) => {
    try {
      return statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  return names.map((n) => join(dir, n)).sort((a, b) => mtime(b) - mtime(a))[0];
}

/** "imported 2 sessions · skipped 1 (already there)". */
export function importSummary(result: ImportResult): string {
  const parts = [`imported ${result.imported.length} session${result.imported.length === 1 ? "" : "s"}`];
  if (result.skipped.length) {
    const reasons = [...new Set(result.skipped.map((s) => s.reason))].join(", ");
    parts.push(`skipped ${result.skipped.length} (${reasons})`);
  }
  return parts.join(" · ");
}
