/**
 * cco's status line for Claude Code (`statusLine` in its settings.json runs this file, `dist/statusline.js`). A bundle
 * entry of its own: Claude Code runs it after every message, and the CLI's imports alone take a third of a second.
 * It reads the input from stdin and the preset from cco's settings, prints the lines and always exits with 0: a part
 * that fails is left out, and with nothing readable it prints "cco".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gatherExtras } from "./statusline/extras.js";
import { isStatusLinePreset, renderStatusLine, type StatusInput, type StatusLinePreset } from "./statusline/render.js";
import { claudeDir, readJson, writeJson } from "./transcript/locate.js";

/** The preset chosen in this config folder's cco settings; compact for any other value (cco's command runs only with a preset). */
function chosenPreset(): StatusLinePreset {
  const value = readJson<{ statusLine?: unknown }>(join(claudeDir(), "cco", "settings.json"))?.statusLine;
  return isStatusLinePreset(value) ? value : "compact";
}

function main(): string[] {
  let raw = "";
  let input: StatusInput = {};
  try {
    raw = readFileSync(0, "utf8");
    input = JSON.parse(raw) as StatusInput;
  } catch {
    return ["cco"];
  }
  try {
    // For the Settings view's preview with real values.
    writeJson(join(claudeDir(), "cco", "statusline-input.json"), input);
  } catch {
    // The preview then shows the last one, or the example.
  }
  const preset = chosenPreset();
  const lines = renderStatusLine(preset, input, gatherExtras(preset, input));
  return lines.length > 0 ? lines : ["cco"];
}

let lines: string[];
try {
  lines = main();
} catch {
  lines = ["cco"];
}
process.stdout.write(`${lines.join("\n")}\n`);
