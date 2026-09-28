import { describe, expect, it } from "vitest";
import { tabPage } from "../src/transcript/chrome.js";
import { TranscriptParser, turnMarkdown } from "../src/transcript/parse.js";
import { toolMarkdown, toolOutcome } from "../src/transcript/tools.js";

const tool = (name: string) => `mcp__claude-in-chrome__${name}`;
const context = (title: string, url = "https://example.com/") =>
  `\n\nTab Context:\n- Executed on tabId: 7\n- Available tabs:\n  • tabId 7: "${title}" ("${url}")\n  • tabId 8: "Other" ("https://other/")`;
const content = (...texts: string[]) => texts.map((text) => ({ type: "text", text }));

/** The compact line (or full Markdown) of one call with its result. */
function show(name: string, input: unknown, texts: string[], level: "compact" | "full" = "compact"): string {
  const outcome = toolOutcome(tool(name), input, undefined, content(...texts), false);
  return toolMarkdown(tool(name), input, outcome, level);
}

describe("Claude in Chrome calls", () => {
  it("shows each action verb first, without tab ids", () => {
    expect(show("navigate", { url: "https://eu-central-1.console.aws.amazon.com/cloudwatch/home", tabId: 7 }, ["Navigated to …", context("CloudWatch")])).toBe(
      "**↗ navigate** `eu-central-1.console.aws.amazon.com/cloudwatch/home`",
    );
    expect(show("computer", { action: "left_click", coordinate: [451, 265], tabId: 7 }, ["Clicked at (451, 265)"])).toBe("**⊙ click** (451, 265)");
    expect(show("computer", { action: "type", text: "Runs", tabId: 7 }, ['Typed "Runs"'])).toBe('**⌨ type** `"Runs"`');
    expect(show("computer", { action: "key", text: "Return", tabId: 7 }, ["Pressed 1 key: Return"])).toBe("**⌨ key** `Return`");
    expect(show("computer", { action: "screenshot", tabId: 7 }, ["Successfully captured screenshot (1568x698, jpeg) - ID: ss_1"])).toBe(
      "**▣ screenshot** · 1568×698",
    );
    expect(show("computer", { action: "scroll", scroll_direction: "down", scroll_amount: 15, coordinate: [1, 2] }, ["Scrolled"])).toBe("**↕ scroll** down 15");
    expect(show("computer", { action: "wait", duration: 3 }, ["Waited for 3 seconds"])).toBe("**◷ wait** 3 s");
    expect(show("find", { query: "Inference profiles link" }, ["Found 2 matching elements\n\n- ref_1: link"])).toBe(
      "**⌕ browser find** `Inference profiles link` · → 2 elements",
    );
    expect(show("list_connected_browsers", {}, ["[]"])).toBe("**◎ browsers connected** · none");
    expect(show("tabs_context_mcp", {}, ['{"availableTabs":[]}', context("A")])).toBe("**▭ browser tabs** · 2 tabs");
  });

  it("leaves out Claude Code's reminders and shows scripts in full", () => {
    const reminder = "<system-reminder>Prefer browser_batch</system-reminder>";
    expect(show("read_console_messages", { pattern: "error", onlyErrors: true }, [`Found 3 error messages:\n[1] boom ${reminder}`])).toBe(
      "**⚠ browser console** `error` · Found 3 error messages:",
    );
    expect(show("javascript_tool", { action: "javascript_exec", text: "document.title" }, ['{\n  "a": 1\n}'], "full")).toBe(
      '**{} browser javascript** `document.title` · `{ "a": 1 }`\n\n```js\ndocument.title\n```\n\n```\n{\n  "a": 1\n}\n```',
    );
  });

  it("lists a batch's actions with their results", () => {
    const input = {
      actions: [
        { name: "computer", input: { action: "left_click", coordinate: [447, 557], tabId: 7 } },
        { name: "computer", input: { action: "screenshot", tabId: 7 } },
      ],
    };
    const texts = ["[computer:left_click] Clicked at (447, 557)", "[computer:screenshot] Successfully captured screenshot (1568x744, jpeg) - ID: ss_2", context("Report")];
    expect(show("browser_batch", input, texts)).toBe("**⧉ browser batch** 2 actions\n- **⊙ click** (447, 557)\n- **▣ screenshot** · 1568×744");
  });

  it("reads the page an action ran on from the tab context", () => {
    expect(tabPage(context('Edit "item" | DynamoDB'))).toBe('Edit "item" | DynamoDB');
    expect(tabPage(context("", "https://example.com/path"))).toBe("example.com/path");
    expect(tabPage("Tab Context:\n- Available tabs:\n  • tabId 7: \"A\" (\"x\")")).toBeUndefined();
  });

  it("names the page whenever it changes, after a navigation that leads there", () => {
    const line = (entry: object) => JSON.stringify(entry) + "\n";
    const call = (id: string, name: string, input: object) =>
      line({ type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name: tool(name), input }], stop_reason: "tool_use" } });
    const result = (id: string, ...texts: string[]) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: content(...texts) }] } });
    const p = new TranscriptParser();
    p.push(
      line({ type: "user", uuid: "u", message: { role: "user", content: "check the page" } }) +
        call("1", "computer", { action: "screenshot" }) +
        result("1", "Successfully captured screenshot (10x10, jpeg)", context("Start")) +
        call("2", "navigate", { url: "https://example.com/next" }) +
        result("2", "Navigated", context("Next")) +
        call("3", "computer", { action: "left_click", coordinate: [1, 2] }) +
        result("3", "Clicked", context("Next")),
    );
    expect(turnMarkdown(p.turns[0], { tools: "compact", thinking: false }).split("\n\n")).toEqual([
      "*on Start*",
      "**▣ screenshot** · 10×10",
      "**↗ navigate** `example.com/next`",
      "*on Next*",
      "**⊙ click** (1, 2)",
    ]);
  });
});
