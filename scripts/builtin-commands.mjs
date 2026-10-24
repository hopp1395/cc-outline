// Writes src/builtinCommands.ts: Claude Code's own `/` commands, as its answer to an `initialize` lists them
// (`commands`, `builtin: true`). A headless Claude Code is asked (no settings but the project's, no MCP servers, no
// transcript, in an empty folder), over a list kept by hand of the commands only the terminal has (`/resume`, `/exit`,
// …); recordings passed as arguments (a JSON file of an initialize answer, or JSONL) add theirs over both. Run it with
// each new Claude Code version:
//   node scripts/builtin-commands.mjs [recording …]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT = new URL("../src/builtinCommands.ts", import.meta.url);

// The commands only an interactive Claude Code has, which a headless one leaves out and nothing else lists with a
// description (a remote session's `init` names some, without one): kept by hand, from `/help`. The headless answer
// wins for a name it knows.
const TERMINAL_COMMANDS = [
  { name: "add-dir", description: "Add a new working directory", argumentHint: "<path>" },
  { name: "background", description: "Send this session to the background and free the terminal", argumentHint: "[prompt]", aliases: ["bg"] },
  { name: "branch", description: "Create a branch of the current conversation at this point", argumentHint: "[name]", aliases: ["fork"] },
  { name: "btw", description: "Ask a quick side question without interrupting the main conversation", argumentHint: "[question]" },
  { name: "cd", description: "Move this session to a new working directory", argumentHint: "<path>" },
  { name: "copy", description: "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)" },
  { name: "diff", description: "View uncommitted changes and per-turn diffs" },
  { name: "exit", description: "Exit the CLI", aliases: ["quit"] },
  { name: "export", description: "Export the current conversation to a file or clipboard", argumentHint: "[filename]" },
  { name: "feedback", description: "Send feedback to Anthropic or report a bug", aliases: ["bug"] },
  { name: "help", description: "Show help and available commands" },
  { name: "hooks", description: "View hook configurations for tool events" },
  { name: "ide", description: "Manage IDE integrations and show status" },
  { name: "install-github-app", description: "Set up Claude GitHub Actions for a repository" },
  { name: "login", description: "Sign in with your Anthropic account" },
  { name: "logout", description: "Sign out from your Anthropic account" },
  { name: "memory", description: "Edit CLAUDE.md files and memory settings" },
  { name: "mobile", description: "Show QR code to download the Claude mobile app", aliases: ["ios", "android"] },
  { name: "permissions", description: "Manage allow and deny tool permission rules", aliases: ["allowed-tools"] },
  { name: "plan", description: "Enable plan mode or view the current session plan", argumentHint: "[open|<description>]" },
  { name: "plugin", description: "Manage Claude Code plugins", aliases: ["plugins", "marketplace"] },
  { name: "privacy-settings", description: "View and update your privacy settings" },
  { name: "remote-control", description: "Control this session from your phone or claude.ai/code", aliases: ["rc"] },
  { name: "resume", description: "Resume a previous conversation", argumentHint: "[conversation id or search term]", aliases: ["continue"] },
  { name: "rewind", description: "Restore the code and/or conversation to a previous point", aliases: ["checkpoint", "undo"] },
  { name: "skills", description: "List available skills" },
  { name: "statusline", description: "Set up Claude Code's status line UI" },
  { name: "status", description: "Show Claude Code status including version, model, account, API connectivity, and tool statuses" },
  { name: "tasks", description: "View and manage everything running in the background", aliases: ["bashes"] },
  { name: "teleport", description: "Send this session to the cloud, or resume one from claude.ai", aliases: ["tp"] },
  { name: "terminal-setup", description: "Install Shift+Enter key binding for newlines" },
  { name: "theme", description: "Change the theme" },
  { name: "upgrade", description: "Upgrade to Max for higher rate limits and more Opus" },
];

/** The `commands` arrays anywhere in `value`. */
function commandLists(value, found = []) {
  if (Array.isArray(value)) value.forEach((v) => commandLists(v, found));
  else if (value && typeof value === "object") {
    if (Array.isArray(value.commands) && value.commands.every((c) => c && typeof c.name === "string")) found.push(value.commands);
    else Object.values(value).forEach((v) => commandLists(v, found));
  }
  return found;
}

/** The initialize answer of a headless Claude Code, and its version. */
function askHeadless() {
  const dir = mkdtempSync(join(tmpdir(), "cco-commands-"));
  return new Promise((resolve, reject) => {
    const claude = spawn("claude -p --input-format stream-json --output-format stream-json --verbose --setting-sources project --no-session-persistence --strict-mcp-config", {
      cwd: dir,
      shell: true,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    const timer = setTimeout(() => claude.kill(), 60_000);
    claude.stdout.on("data", (chunk) => {
      out += chunk;
      for (const line of out.split("\n")) {
        if (!line.startsWith("{")) continue;
        const entry = JSON.parse(line);
        if (entry.type !== "control_response" || entry.response?.request_id !== "cco") continue;
        clearTimeout(timer);
        claude.stdin.end();
        claude.kill();
        return resolve(entry.response.response);
      }
    });
    claude.on("error", reject);
    claude.on("close", () => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      reject(new Error("Claude Code gave no initialize answer"));
    });
    claude.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "cco", request: { subtype: "initialize" } })}\n`);
  });
}

const headless = await askHeadless();
const commands = new Map();
const add = (list) => {
  for (const c of list) {
    if (!c.builtin || c.name.startsWith("_")) continue;
    commands.set(c.name, {
      name: c.name,
      description: c.description ?? "",
      ...(c.argumentHint && { argumentHint: c.argumentHint }),
      ...(c.aliases?.length > 0 && { aliases: c.aliases }),
    });
  }
};
add(TERMINAL_COMMANDS.map((c) => ({ ...c, builtin: true })));
add(headless.commands);
for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, "utf8");
  const values = file.endsWith(".jsonl") ? text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [JSON.parse(text)];
  const lists = commandLists(values);
  if (lists.length === 0) console.warn(`${file}: no commands found`);
  lists.forEach(add);
}

const sorted = [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(
  OUT,
  `// Generated by scripts/builtin-commands.mjs from Claude Code ${headless.claude_code_version}; do not edit by hand.
import type { SlashCommand } from "./slashCommands.js";

/** Claude Code's own \`/\` commands, as its answer to \`initialize\` lists them. */
export const BUILTIN_COMMANDS: SlashCommand[] = ${JSON.stringify(sorted, null, 2)};
`,
);
console.log(`${sorted.length} commands of Claude Code ${headless.claude_code_version} in src/builtinCommands.ts`);
