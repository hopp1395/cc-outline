import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { BUILTIN_COMMANDS } from "./builtinCommands.js";
import { readJson } from "./transcript/locate.js";

/** A `/` command the prompt line offers: a skill, a command file or one of Claude Code's own. */
export interface SlashCommand {
  /** Without the slash; a plugin's starts with `<plugin>:`. */
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

/** Where the prompt line finds a session's commands: on this machine, or what a remote session tells claude.ai. */
export type CommandSource = LocalCommandSource | { remoteId: string };

/** Where a session of this machine finds its commands: its transcript's skill listing and its folders. */
export interface LocalCommandSource {
  /** The session's transcript, if it has one yet. */
  transcript?: string;
  /** The session's project folder. */
  cwd: string;
  /** The config folder of its account. */
  configDir: string;
}

/** How much of a transcript is read at a time, from its end, looking for the last skill listing. */
const CHUNK = 1024 * 1024;

/** The skills of a `skill_listing` attachment: `names` in order, each with its line `- name: description` of `content`. */
export function parseSkillListing(attachment: { content?: unknown; names?: unknown }): SlashCommand[] {
  const content = typeof attachment.content === "string" ? attachment.content : "";
  const described = new Map<string, string>();
  for (const line of content.split("\n")) {
    const hit = /^- ([^:\s]+(?::[^:\s]+)*): ?(.*)$/.exec(line);
    if (hit) described.set(hit[1]!, hit[2]!);
  }
  const names = Array.isArray(attachment.names) ? attachment.names.filter((n): n is string => typeof n === "string") : [...described.keys()];
  return names.map((name) => ({ name, description: described.get(name) ?? "" }));
}

/**
 * The skills a transcript lists last: its last `skill_listing` with `isInitial` (Claude Code writes the whole list
 * again after a compaction or a change) and the ones listed after it (`isInitial: false`, one new skill each).
 * Read from the end, a megabyte at a time; undefined when it lists none.
 */
export async function readSkillListing(path: string): Promise<SlashCommand[] | undefined> {
  let file;
  try {
    file = await open(path, "r");
  } catch {
    return undefined;
  }
  try {
    const later: SlashCommand[][] = [];
    let end = (await file.stat()).size;
    let rest = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const chunk = Buffer.alloc(end - start);
      await file.read(chunk, 0, chunk.length, start);
      const text = Buffer.concat([chunk, rest]);
      // The part before the first line break may be cut: it waits for the chunk before it.
      const cut = start > 0 ? text.indexOf(10) : -1;
      rest = cut >= 0 ? text.subarray(0, cut) : Buffer.alloc(0);
      const lines = text.subarray(cut + 1).toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!line.includes('"skill_listing"')) continue;
        let attachment;
        try {
          attachment = (JSON.parse(line) as { attachment?: { type?: string; isInitial?: boolean; content?: unknown; names?: unknown } }).attachment;
        } catch {
          continue;
        }
        if (attachment?.type !== "skill_listing") continue;
        later.push(parseSkillListing(attachment));
        if (attachment.isInitial !== false) return later.reverse().flat();
      }
      end = start;
    }
    return later.length > 0 ? later.reverse().flat() : undefined;
  } finally {
    await file.close();
  }
}

/** The fields of a Markdown file's front matter (`---` lines), the plain `key: value` ones, quotes taken off. */
export function frontMatter(text: string): { fields: Record<string, string>; body: string } {
  const hit = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!hit) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of hit[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    const value = field[2]!.trim();
    fields[field[1]!] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return { fields, body: text.slice(hit[0].length) };
}

/** A command of a Markdown file: the front matter's name, description and argument hint; the body's first line describes it without one. */
function fromMarkdown(file: string, name: string): SlashCommand | undefined {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const { fields, body } = frontMatter(text);
  if (fields["user-invocable"] === "false") return undefined;
  const description = fields.description || (body.split(/\r?\n/).find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim();
  return { name: fields.name || name, description, ...(fields["argument-hint"] && { argumentHint: fields["argument-hint"] }) };
}

const dirsOf = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};

/** The skills of a `skills` folder (`<name>/SKILL.md`) and the commands of a `commands` folder (`a/b.md` is `a:b`), names led by `prefix`. */
function folderCommands(root: string, prefix = ""): SlashCommand[] {
  const found: SlashCommand[] = [];
  for (const dir of dirsOf(join(root, "skills"))) {
    const command = fromMarkdown(join(root, "skills", dir, "SKILL.md"), dir);
    if (command) found.push({ ...command, name: prefix + (prefix ? dir : command.name) });
  }
  const commands = join(root, "commands");
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (e.isFile() && e.name.endsWith(".md")) {
        const name = relative(commands, path).slice(0, -3).split(sep).join(":");
        const command = fromMarkdown(path, name);
        if (command) found.push({ ...command, name: prefix + name });
      }
    }
  };
  walk(commands, 0);
  return found;
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/**
 * The plugins on for the project: installed for the user or for this project (`installed_plugins.json`) and
 * switched on in `enabledPlugins` of the user's, the project's or its local settings (the last one that names it wins).
 */
function enabledPlugins(configDir: string, cwd: string): { name: string; path: string }[] {
  type Install = { scope?: string; projectPath?: string; installPath?: string };
  const installed = readJson<{ plugins?: Record<string, Install[]> }>(join(configDir, "plugins", "installed_plugins.json"))?.plugins ?? {};
  const enabled: Record<string, unknown> = {};
  for (const file of [join(configDir, "settings.json"), join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")]) {
    Object.assign(enabled, readJson<{ enabledPlugins?: Record<string, unknown> }>(file)?.enabledPlugins ?? {});
  }
  const plugins: { name: string; path: string }[] = [];
  for (const [id, installs] of Object.entries(installed)) {
    if (enabled[id] !== true || !Array.isArray(installs)) continue;
    const install = installs.find((i) => i.installPath && (i.scope === "user" || (i.projectPath !== undefined && samePath(i.projectPath, cwd))));
    if (install?.installPath && existsSync(install.installPath)) plugins.push({ name: id.split("@")[0]!, path: install.installPath });
  }
  return plugins;
}

/** The commands of the session's folders: the user's and the project's skills and commands, then those of its plugins. */
export function folderSkills(source: Pick<LocalCommandSource, "cwd" | "configDir">): SlashCommand[] {
  return [
    ...folderCommands(source.configDir),
    ...folderCommands(join(source.cwd, ".claude")),
    ...enabledPlugins(source.configDir, source.cwd).flatMap((p) => folderCommands(p.path, `${p.name}:`)),
  ];
}

/** Each name once: the first one wins. */
function unique(commands: SlashCommand[]): SlashCommand[] {
  const seen = new Set<string>();
  return commands.filter((c) => !seen.has(c.name) && seen.add(c.name));
}

/**
 * Every command a session of this machine offers: the skills its transcript lists last (what that session knows,
 * claude.ai's skills too), the commands of its folders that listing leaves out (skills only the user may start,
 * `disable-model-invocation`; all of them before the first listing), then Claude Code's own.
 */
export async function sessionCommands(source: LocalCommandSource): Promise<SlashCommand[]> {
  const listed = source.transcript ? await readSkillListing(source.transcript) : undefined;
  return unique([...(listed ?? []), ...folderSkills(source), ...BUILTIN_COMMANDS]);
}

/** The text after `/` while the prompt is a command name being typed (the cursor in it, no space before it), else undefined. */
export function commandQuery(text: string, cursor: number): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const typed = text.slice(1, cursor);
  if (cursor < 1 || /\s/.test(typed)) return undefined;
  return typed;
}

/** The commands whose name (or an alias) holds `query`: those starting with it first, each part alphabetical. */
export function matchCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const names = (c: SlashCommand) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
  // A plugin's command also matches by the part after its prefix, as `/open` finds `cco:open`.
  const starts = (n: string) => n.startsWith(q) || n.slice(n.lastIndexOf(":") + 1).startsWith(q);
  const rank = (c: SlashCommand) => (names(c).some(starts) ? 0 : names(c).some((n) => n.includes(q)) ? 1 : -1);
  return commands
    .map((c) => ({ c, r: rank(c) }))
    .filter((m) => m.r >= 0)
    .sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name))
    .map((m) => m.c);
}

/** The prompt with the command name being typed replaced by `name` and a space; the cursor after that space. */
export function takeCommand(text: string, name: string): { text: string; cursor: number } {
  const end = /^\/\S*/.exec(text)![0].length;
  const rest = text.slice(end).replace(/^ /, "");
  const head = `/${name} `;
  return { text: head + rest, cursor: head.length };
}

/** The modification time of `path`, or 0: a changed transcript is read again. */
export function modifiedAt(path: string | undefined): number {
  if (!path) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
