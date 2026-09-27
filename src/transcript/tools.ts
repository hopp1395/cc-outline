import { isAbsolute, relative } from "node:path";
import { BOX_END, BOX_START } from "../render/markdown.js";

/** How much of Claude's tool calls the chat shows: nothing, a line each, or with command and output. */
export const TOOL_LEVELS = ["off", "compact", "full"] as const;
export type ToolLevel = (typeof TOOL_LEVELS)[number];

/**
 * What a tool call produced, reduced to what the chat shows: a status, a
 * short result for the compact line and Markdown for the full view. Built
 * once when the result arrives, so file contents and outputs are not kept.
 */
export interface ToolOutcome {
  status: "ok" | "error" | "denied";
  /** The compact result after the tool's title, e.g. "lines 85–145 of 300". */
  summary?: string;
  /** Markdown shown below the line in full mode: output, file lists, the error. */
  detail?: string;
  /** AskUserQuestion: question → the chosen label(s) or typed answer, and the notes added to answers. */
  answers?: Record<string, string>;
  notes?: Record<string, string>;
  /** ExitPlanMode: the user's words when they rejected the plan. */
  feedback?: string;
}

/** Lines of Bash/PowerShell output kept for the full view: the end, where results and errors are. */
export const OUTPUT_TAIL = 10;
/** File names kept of a Grep or Glob result. */
const MAX_FILES = 5;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Escapes Markdown in text from tools and users. */
export const escapeMd = (s: string) => s.replace(/([\\`*_[\]<>|])/g, "\\$1");

/** A fenced code block, with a fence longer than any run of backticks in `text`. */
export function fence(text: string, lang = ""): string {
  const f = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${f}${lang}\n${text}\n${f}`;
}

/** Inline code; backticks become quotes, so the span cannot break. */
const code = (s: string, max = 100) => {
  const one = s.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return `\`${one.length > max ? one.slice(0, max - 1) + "…" : one}\``;
};

/** `path` relative to `cwd` when it lies inside it, with forward slashes. */
export function shortPath(path: string, cwd?: string): string {
  if (cwd && isAbsolute(path)) {
    const rel = relative(cwd, path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.replace(/\\/g, "/");
  }
  return path.replace(/\\/g, "/");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : /(ch|sh|s|x)$/.test(word) ? "es" : "s"}`;
const lines = (s: string) => s.replace(/\n+$/, "").split("\n");

/** The text of a tool_result's content: a string or text blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (obj(b).type === "text" ? (str(obj(b).text) ?? "") : "")).join("\n");
  return "";
}

/** The last `n` lines of `text` as a code block, with how many came before. */
function tail(text: string, n = OUTPUT_TAIL): string {
  const all = lines(text);
  const shown = all.slice(-n).join("\n");
  const above = all.length - n;
  return (above > 0 ? `*… ${plural(above, "line")} above*\n\n` : "") + fence(shown);
}

/** "+12 −3" from a structuredPatch. */
function patchCounts(patch: unknown): string | undefined {
  if (!Array.isArray(patch)) return undefined;
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    for (const line of (obj(hunk).lines as unknown[]) ?? []) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return `+${added} −${removed}`;
}

/** A list of up to MAX_FILES paths, and how many more there are. */
function fileList(files: unknown, cwd?: string, total?: number): string | undefined {
  if (!Array.isArray(files) || files.length === 0) return undefined;
  const names = files.filter((f): f is string => typeof f === "string");
  const more = (total ?? names.length) - Math.min(names.length, MAX_FILES);
  return [...names.slice(0, MAX_FILES).map((f) => `- ${code(shortPath(f, cwd), 200)}`), ...(more > 0 ? [`- *… ${more} more*`] : [])].join("\n");
}

const DENIED = /^The user doesn't want to proceed/;

/**
 * Reduces a tool's result to a `ToolOutcome`. `result` is the entry's
 * `toolUseResult` (structured, differs per tool), `content` the tool_result's
 * content (what Claude read), `cwd` the session's folder for short paths.
 */
export function toolOutcome(name: string, input: unknown, result: unknown, content: unknown, isError: boolean | undefined, cwd?: string): ToolOutcome {
  const text = resultText(content);
  if (isError) {
    if (DENIED.test(text)) {
      // The words after "the user said:" when they rejected with feedback.
      const feedback = /the user said:\s*([\s\S]*)$/i.exec(text)?.[1]?.trim();
      return { status: "denied", summary: "⊘ denied", ...(feedback ? { feedback, detail: `> ${escapeMd(feedback)}` } : {}) };
    }
    const first = lines(text.replace(/<\/?tool_use_error>/g, "").trim())[0] ?? "";
    return { status: "error", summary: `✗ ${escapeMd(first.slice(0, 100))}`, detail: text.trim() ? tail(text.replace(/<\/?tool_use_error>/g, "").trim()) : undefined };
  }
  const r = obj(result);
  const i = obj(input);
  switch (name) {
    case "Bash":
    case "PowerShell": {
      const out = str(r.stdout) ?? (typeof result === "string" ? result : text);
      const err = str(r.stderr);
      const status = r.interrupted === true ? "⊘ interrupted" : str(r.backgroundTaskId) ? "⏱ background" : "✓";
      const count = out ? lines(out).length : 0;
      const detail = [
        ...(out ? [tail(out)] : []),
        ...(err ? [`*stderr:*\n\n${tail(err)}`] : []),
      ].join("\n\n");
      return { status: "ok", summary: count ? `${status} · ${plural(count, "line")}` : status, detail: detail || undefined };
    }
    case "Read": {
      const file = obj(r.file);
      const type = str(r.type);
      if (type && type !== "text") return { status: "ok", summary: type };
      const total = num(file.totalLines);
      const start = num(file.startLine) ?? 1;
      const count = num(file.numLines);
      if (total === undefined || count === undefined) return { status: "ok" };
      return { status: "ok", summary: start === 1 && count >= total ? plural(total, "line") : `lines ${start}–${start + count - 1} of ${total}` };
    }
    case "Edit":
    case "MultiEdit":
      return { status: "ok", summary: patchCounts(r.structuredPatch) };
    case "Write": {
      if (r.type === "update") return { status: "ok", summary: patchCounts(r.structuredPatch) };
      const body = str(i.content);
      return { status: "ok", summary: body !== undefined ? `created, ${plural(lines(body).length, "line")}` : "created" };
    }
    case "Grep": {
      const files = num(r.numFiles) ?? 0;
      const mode = str(r.mode);
      const found = mode === "content" ? (num(r.numLines) ?? 0) : mode === "count" ? (num(r.numMatches) ?? 0) : files;
      const summary =
        found === 0
          ? "no matches"
          : mode === "content"
            ? plural(found, "line")
            : mode === "count"
              ? `${plural(found, "match")} in ${plural(files, "file")}`
              : plural(files, "file");
      const detail = mode === "content" && str(r.content) ? tail(str(r.content)!, MAX_FILES) : fileList(r.filenames, cwd, files);
      return { status: "ok", summary, detail };
    }
    case "Glob": {
      const files = num(r.numFiles) ?? 0;
      return { status: "ok", summary: files === 0 ? "no files" : plural(files, "file") + (r.truncated === true ? " (truncated)" : ""), detail: fileList(r.filenames, cwd, files) };
    }
    case "WebFetch": {
      const bytes = num(r.bytes);
      const size = bytes === undefined ? undefined : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
      const summary = [num(r.code), size].filter((x) => x !== undefined).join(" · ");
      return { status: "ok", summary: summary || undefined, detail: str(i.prompt) ? `*${escapeMd(str(i.prompt)!)}*` : undefined };
    }
    case "WebSearch": {
      const links: { title: string; url: string }[] = [];
      for (const part of Array.isArray(r.results) ? r.results : []) {
        for (const hit of Array.isArray(obj(part).content) ? (obj(part).content as unknown[]) : []) {
          const title = str(obj(hit).title);
          const url = str(obj(hit).url);
          if (title && url) links.push({ title, url });
        }
      }
      const detail = links.slice(0, MAX_FILES).map((l) => `- ${escapeMd(l.title)}  \n  ${l.url}`).join("\n");
      return { status: "ok", summary: plural(links.length, "result"), detail: detail || undefined };
    }
    case "ToolSearch": {
      const matches = Array.isArray(r.matches) ? r.matches.filter((m): m is string => typeof m === "string") : [];
      return { status: "ok", summary: matches.length ? `loaded ${matches.map(mcpName).join(", ")}` : "nothing found" };
    }
    case "AskUserQuestion": {
      const answers: Record<string, string> = {};
      for (const [q, a] of Object.entries(obj(r.answers))) if (typeof a === "string") answers[q] = a;
      const notes: Record<string, string> = {};
      for (const [q, a] of Object.entries(obj(r.annotations))) {
        const note = str(obj(a).notes);
        if (note) notes[q] = note;
      }
      return { status: "ok", answers, notes };
    }
    case "ExitPlanMode":
    case "Skill":
      return { status: "ok" };
    default: {
      const first = lines(text.trim())[0];
      return { status: "ok", summary: first ? escapeMd(first.length > 80 ? first.slice(0, 79) + "…" : first) : undefined };
    }
  }
}

/** "claude-in-chrome · navigate" for "mcp__claude-in-chrome__navigate". */
function mcpName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

/** The key input of a tool as inline code, e.g. its command, path or pattern. */
function keyInput(input: unknown): string {
  const o = obj(input);
  const key = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "description"].find((k) => typeof o[k] === "string");
  return code(key ? (o[key] as string) : JSON.stringify(input ?? ""));
}

/** The title of a tool call, after "⚙ Name": what it worked on. */
function toolTitle(name: string, input: unknown, cwd?: string): string {
  const i = obj(input);
  const path = str(i.file_path) ?? str(i.notebook_path);
  switch (name) {
    case "Bash":
    case "PowerShell":
      return str(i.description) ? `*${escapeMd(str(i.description)!)}*` : code(str(i.command) ?? "");
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return path ? code(shortPath(path, cwd), 200) : keyInput(input);
    case "Grep":
    case "Glob": {
      const where = str(i.path) ?? str(i.glob);
      return code(str(i.pattern) ?? "") + (where ? ` in ${code(shortPath(where, cwd), 200)}` : "");
    }
    case "WebFetch":
      return str(i.url) ?? keyInput(input);
    case "WebSearch":
    case "ToolSearch":
      return code(str(i.query) ?? "");
    case "Skill":
      return code(`/${[str(i.skill), str(i.args)].filter(Boolean).join(" ")}`);
    default:
      return keyInput(input);
  }
}

/** A tool call as the chat shows it at `level` ("off" shows only questions). */
export function toolMarkdown(name: string, input: unknown, outcome: ToolOutcome | undefined, level: ToolLevel, cwd?: string): string {
  if (name === "AskUserQuestion") return questionMarkdown(input, outcome);
  if (level === "off") return "";
  if (name === "ExitPlanMode") {
    const decision =
      outcome === undefined
        ? "waiting for your decision"
        : outcome.status === "ok"
          ? "approved"
          : outcome.status === "denied"
            ? `rejected${outcome.feedback ? `: ${escapeMd(outcome.feedback)}` : ""}`
            : "failed";
    return `**▤ Plan presented** → ${decision} *(3 Plan view)*`;
  }
  const status = outcome?.summary ? ` · ${outcome.summary}` : "";
  const line = `**⚙ ${escapeMd(mcpName(name))}** ${toolTitle(name, input, cwd)}${status}`;
  if (level === "compact") return line;
  const command = (name === "Bash" || name === "PowerShell") && str(obj(input).command) ? fence(str(obj(input).command)!, name === "Bash" ? "sh" : "powershell") : undefined;
  return [line, ...(command ? [command] : []), ...(outcome?.detail ? [outcome.detail] : [])].join("\n\n");
}

/** An AskUserQuestion call, framed: every question with its options, then the user's answer. */
function questionMarkdown(input: unknown, outcome: ToolOutcome | undefined): string {
  const questions = Array.isArray(obj(input).questions) ? (obj(input).questions as unknown[]) : [];
  if (questions.length === 0) return "";
  const title = questions.length === 1 ? "Claude asks" : `Claude asks ${questions.length} questions`;
  const body = questions
    .map((raw) => {
      const q = obj(raw);
      const question = str(q.question) ?? "";
      const header = str(q.header);
      const options = (Array.isArray(q.options) ? q.options : []).map((o) => {
        const label = str(obj(o).label) ?? "";
        const description = str(obj(o).description);
        return `- ${escapeMd(label)}${description ? ` — *${escapeMd(description)}*` : ""}`;
      });
      const answer =
        outcome === undefined
          ? "*waiting for your answer*"
          : outcome.status !== "ok"
            ? "⊘ *not answered*"
            : outcome.answers?.[question] !== undefined
              ? `**→ ${escapeMd(outcome.answers[question])}**`
              : "⊘ *not answered*";
      const note = outcome?.notes?.[question];
      return [
        header ? `**? ${escapeMd(header)}** — ${escapeMd(question)}` : `**? ${escapeMd(question)}**`,
        ...(options.length ? [options.join("\n")] : []),
        answer + (note ? `  \n*note:* ${escapeMd(note)}` : ""),
      ].join("\n\n");
    })
    .join("\n\n");
  return `${BOX_START}${title}\n${body}\n${BOX_END}`;
}
