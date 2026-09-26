// A simplified stand-in for the Claude Code terminal UI, drawn as ANSI lines,
// so the demo can show /cco:chat being typed and the pane opening next to it.
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

const CLAUDE = "\u001b[38;2;217;119;87m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";
const GREEN = "\u001b[38;2;152;195;121m";
const SELECTED = "\u001b[38;2;177;185;249m";

const HISTORY = [
  { prompt: "Add input validation to OrderService before orders are saved" },
  { answer: "I'll move the checks into a dedicated OrderValidator and call it from OrderService before anything is saved." },
  { tool: "Update(src/Orders/OrderService.cs)", result: "Updated with 10 additions and 1 removal" },
  { tool: "Write(src/Orders/OrderValidator.cs)", result: "Wrote 16 lines" },
  { prompt: "Run the tests" },
  { tool: "Bash(dotnet test)", result: "Passed: 42, Failed: 0" },
  { answer: "All 42 tests pass, including the four new ones." },
];

const COMMANDS = [
  ["/cco:chat", "Open the cco chat view (rendered session preview) in a split pane"],
  ["/cco:git", "Open the cco git changes view (diffs with syntax highlighting) in a split pane"],
  ["/cco:plan", "Open the cco plan view (the plans Claude presented in plan mode) in a split pane"],
];

/** Wraps `text` to `width` with a first-line prefix and an indent for the rest. */
function block(prefix, text, width, style = "") {
  const indent = " ".repeat(stringWidth(prefix.replace(/\u001b\[[0-9;]*m/g, "")));
  return wrapAnsi(text, width - indent.length, { hard: true })
    .split("\n")
    .map((line, i) => (i === 0 ? prefix : indent) + style + line + RESET);
}

/** Pads or cuts an ANSI line to exactly `width` columns. */
function fit(line, width) {
  const visible = stringWidth(line);
  if (visible <= width) return line + RESET + " ".repeat(width - visible);
  let out = "";
  for (const part of line.split(/(\u001b\[[0-9;]*m)/)) {
    if (part.startsWith("\u001b")) out += part;
    else
      for (const ch of part) {
        if (stringWidth(out) + stringWidth(ch) > width) return out + RESET;
        out += ch;
      }
  }
  return out + RESET;
}

/**
 * The Claude Code screen: conversation, the prompt box with `input`, and the
 * slash-command suggestions while a command is typed. `ran` adds the command
 * and its output to the conversation.
 */
export function claudeScreen({ width, rows, input = "", ran = false }) {
  const lines = [];
  lines.push(`${CLAUDE}✻${RESET} ${BOLD}Welcome to Claude Code${RESET}`, `${DIM}  cwd: ~/shop${RESET}`, "");
  for (const item of HISTORY) {
    if (item.prompt) lines.push(...block(`${DIM}> ${RESET}`, item.prompt, width, DIM), "");
    if (item.answer) lines.push(...block(`${CLAUDE}● ${RESET}`, item.answer, width), "");
    if (item.tool) {
      lines.push(...block(`${GREEN}● ${RESET}`, `${BOLD}${item.tool}${RESET}`, width));
      lines.push(...block(`${DIM}  ⎿  ${RESET}`, item.result, width, DIM), "");
    }
  }
  if (ran) {
    lines.push(...block(`${DIM}> ${RESET}`, "/cco:chat", width, DIM));
    lines.push(...block(`${DIM}  ⎿  ${RESET}`, "Opened cco chat in a Windows Terminal pane.", width, DIM), "");
  }

  const box = Math.max(10, width - 2);
  const cursor = "\u001b[7m \u001b[27m";
  const prompt = [
    `${DIM}╭${"─".repeat(box - 2)}╮${RESET}`,
    fit(`${DIM}│${RESET} > ${input}${cursor}`, box - 1) + `${DIM}│${RESET}`,
    `${DIM}╰${"─".repeat(box - 2)}╯${RESET}`,
  ];
  const suggestions = input.startsWith("/")
    ? COMMANDS.filter(([name]) => name.startsWith(input)).map(([name, description], i) =>
        fit(`  ${i === 0 ? SELECTED : DIM}${name.padEnd(12)}${RESET}${DIM}${description}${RESET}`, width),
      )
    : [`${DIM}  ? for shortcuts${RESET}`];

  // Keep the prompt box on screen: drop the oldest conversation lines first.
  const bottom = [...prompt, ...suggestions];
  const room = rows - bottom.length;
  const shown = lines.length > room ? lines.slice(lines.length - room) : lines;
  const screen = [...shown, ...bottom];
  while (screen.length < rows) screen.push("");
  return screen.slice(0, rows).map((line) => fit(line, width));
}
