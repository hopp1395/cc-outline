import { tmpdir } from "node:os";
import { claudeCommandLine } from "./launch.js";
import { independentEnv } from "./open.js";
import { proc } from "./proc.js";
import { TIMING } from "./timing.js";
import type { Block } from "./todos.js";
import { claudeDir, withClaudeDir } from "./transcript/locate.js";

/** Small and quick: on a real plan it found the same blocks as Sonnet at about a twentieth of the cost. */
export const BLOCKS_MODEL = "haiku";

const SYSTEM_PROMPT = "You extract work blocks from a text and return only the requested structure.";

const PROMPT = `Below, in <answer>, is an answer of an AI coding assistant. Return its work blocks: the units of work meant to be done one after the other, one entry each, in the answer's order. Questions to the reader, notes, summaries, comparisons and explanations are not work blocks. If the answer has none, return an empty list.

- title: the block's name exactly as the answer writes it, with its number or prefix ("Block 2: Tests", "3. Texte"), without Markdown emphasis. A block without a name takes its first words. Never make one up, such as "Step 1".
- section: the heading the block stands under, exactly as written, without its # marks. Empty if there is none.
- text: everything else that belongs to the block, word for word and in the answer's language, without the title and the section. Keep what names a detail: a table row's cells become one line each, "Column: value". Add nothing, shorten nothing.`;

const SCHEMA = {
  type: "object",
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, section: { type: "string" }, text: { type: "string" } },
        required: ["title", "section", "text"],
      },
    },
  },
  required: ["blocks"],
};

/**
 * The arguments of the run. It leaves no trace: no transcript (Sessions and Monitor would list it), no hooks (`cco hook`
 * would make it the project's active session, and could open a viewer), no tools, skills or MCP servers.
 * `--bare` would do most of it, but reads no keychain, so it cannot use a subscription's login.
 */
export function blocksArgs(): string[] {
  return [
    "-p",
    "--model",
    BLOCKS_MODEL,
    "--no-session-persistence",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--tools",
    "",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--system-prompt",
    SYSTEM_PROMPT,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(SCHEMA),
  ];
}

/** The prompt of the run, for `markdown` (sent on stdin: an answer may be longer than a command line can be). */
export function blocksPrompt(markdown: string): string {
  return `${PROMPT}\n\n<answer>\n${markdown}\n</answer>\n`;
}

/**
 * A block's text as the list keeps and sends it: the title, the section where the blocks stand under more than one
 * (with one it says nothing new), then the rest.
 */
function blockText(block: { title: string; section: string; text: string }, sections: number): string {
  return [block.title, sections > 1 ? block.section : "", block.text].filter(Boolean).join("\n");
}

/** The blocks of what the run printed (`--output-format json`); throws with what the user should read. */
export function parseBlocks(output: string): Block[] {
  let result: { is_error?: unknown; result?: unknown; structured_output?: { blocks?: unknown } };
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error(output.trim().split("\n")[0]?.slice(0, 200) || "Claude printed nothing");
  }
  if (result?.is_error) throw new Error(typeof result.result === "string" && result.result ? result.result.slice(0, 200) : "Claude reported an error");
  const raw = result?.structured_output?.blocks;
  if (!Array.isArray(raw)) throw new Error("Claude's output has no list of blocks");
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const blocks = raw.map((b: { title?: unknown; section?: unknown; text?: unknown }) => ({ title: text(b?.title), section: text(b?.section), text: text(b?.text) })).filter((b) => b.title || b.text);
  const sections = new Set(blocks.map((b) => b.section).filter(Boolean)).size;
  return blocks.map((b) => ({ text: blockText(b, sections) }));
}

/** One run: what it finds, and the way to stop it. Stopped, the promise never settles. */
export interface BlocksRun {
  result: Promise<Block[]>;
  cancel: () => void;
}

/** What a run found, per answer, while the viewer runs: `T` again costs neither time nor usage. */
const remembered = new Map<string, Block[]>();

/** Forgets what was found (tests). */
export function forgetBlocks(): void {
  remembered.clear();
}

/** The blocks already found in `markdown`, if any. An empty result is not kept: the next `T` asks again. */
export function rememberedBlocks(markdown: string): Block[] | undefined {
  return remembered.get(markdown);
}

/** Asks Claude for the work blocks of `markdown`, in a run of its own under the viewer's config folder. */
export function askBlocks(markdown: string, platform: NodeJS.Platform = process.platform): BlocksRun {
  // A folder of no project, so it reads no project's CLAUDE.md.
  const options = { cwd: tmpdir(), env: withClaudeDir(independentEnv(), claudeDir()), stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], windowsHide: true };
  // Through the shell on Windows: claude may be an npm .cmd shim, which Node starts only that way.
  const child = platform === "win32" ? proc.spawn(claudeCommandLine(blocksArgs()), { ...options, shell: true }) : proc.spawn("claude", blocksArgs(), options);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const kill = () => {
    if (platform !== "win32" || !child.pid) return void child.kill();
    // Killing the shell would leave claude running.
    proc.spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).on?.("error", () => {});
  };
  const result = new Promise<Block[]>((resolve, reject) => {
    let output = "";
    let errors = "";
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMING.todoBlocks);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!stopped) reject(new Error(`claude could not be started: ${err.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (stopped) return;
      if (timedOut) return reject(new Error(`no answer after ${Math.round(TIMING.todoBlocks / 1000)} s`));
      try {
        const blocks = parseBlocks(output || errors);
        if (blocks.length) remembered.set(markdown, blocks);
        resolve(blocks);
      } catch (err) {
        reject(err as Error);
      }
    });
    // A claude that is gone before it read everything is reported by `close`.
    child.stdin.on("error", () => {});
    child.stdin.end(blocksPrompt(markdown));
  });
  return {
    result,
    cancel: () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      kill();
    },
  };
}
