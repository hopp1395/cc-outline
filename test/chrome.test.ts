import { describe, expect, it } from "vitest";
import { tabPage } from "../src/transcript/chrome.js";
import { TranscriptParser, turnMarkdown, turnScreenshots } from "../src/transcript/parse.js";
import { shotAt, stripAnsi } from "../src/tui/links.js";
import { toolMarkdown, toolOutcome } from "../src/transcript/tools.js";
import { BOX_END, BOX_START_CYAN } from "../src/render/markdown.js";

const ESC = "\u001b";
const CYAN_FRAME = BOX_START_CYAN;
const FRAME_END = BOX_END;
const ESCAPED_UNDERSCORE = "\\_";

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

  it("shows where a batch stopped: what ran, the error and what did not run", () => {
    const input = {
      actions: [
        { name: "computer", input: { action: "wait", duration: 2 } },
        { name: "computer", input: { action: "screenshot" } },
        { name: "computer", input: { action: "scroll", scroll_direction: "down", scroll_amount: 5 } },
      ],
    };
    const text = "[computer:wait] Waited for 2 seconds\n\nactions[1] (computer:screenshot) failed: Permission denied for this action on this domain (1 completed, 2 remaining)";
    const outcome = toolOutcome(tool("browser_batch"), input, undefined, text, true);
    expect(outcome.summary).toBe("✗ action 2 of 3 failed");
    expect(outcome.steps?.map((s) => s.line)).toEqual([
      "**◷ wait** 2 s",
      "**▣ screenshot** · ✗ Permission denied for this action on this domain",
      "**↕ scroll** down 5 · not run",
    ]);
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

describe("the desktop app's Browser pane", () => {
  const pane = (name: string) => `mcp__Claude_Browser__${name}`;
  const seed = (title: string, url = "https://example.com/") => `\n\nTab Context:\n- Executed on tabId: seed\n- Available tabs:\n  • tabId seed: "${title}" ("${url}")`;
  const image = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } };

  it("reads its results like Chrome's: sizes, matches, the tab named by a word", () => {
    const shot = toolOutcome(pane("computer"), { action: "screenshot" }, undefined, [image, ...content("[Image: source: C:\t\blob-1.jpg]", "Screenshot size: 800x600", seed("Example Domain"))], false);
    expect(shot).toMatchObject({ summary: "800×600", page: "Example Domain", images: [{ path: "C:\t\blob-1.jpg" }] });
    expect(toolMarkdown(pane("computer"), { action: "screenshot" }, shot, "compact", undefined, [3])).toBe("**▣ screenshot** · 800×600 \u001b[36m[▣ 3]\u001b[39m");

    const click = { action: "left_click", ref: "ref_21", action_summary: 'Opens the "Learn more" link' };
    const clicked = toolOutcome(pane("computer"), click, undefined, content("left_click at (512, 425) [ref_21]\n\n(captured at origin https://example.com)", seed("Example Domain")), false);
    expect(toolMarkdown(pane("computer"), click, clicked, "compact")).toBe('**⊙ click** Opens the "Learn more" link');

    expect(toolOutcome(pane("find"), { query: "x" }, undefined, content('No matches for "x".', seed("A")), false).summary).toBe("→ none");
    const found = toolOutcome(pane("find"), { query: "Learn" }, undefined, content('Found 1 match(es) for "Learn":\n- link "Learn more" [ref_21]', seed("A")), false);
    expect(found).toMatchObject({ summary: "→ 1 element", brief: ['link "Learn more" [ref_21]'] });
    const network = toolOutcome(pane("read_network_requests"), {}, undefined, content("[1] GET https://a/ → 200 \n[2] GET https://a/b.css → 200", seed("A")), false);
    expect(network.summary).toBe("2 requests");
    expect(toolMarkdown(pane("preview_start"), { url: "https://example.com" }, { status: "ok" }, "compact")).toBe("**↗ open browser** `example.com`");
  });

  it("gives each image of a batch the action it came from", () => {
    const input = { actions: [{ name: "navigate", input: { url: "https://example.com" } }, { name: "computer", input: { action: "screenshot" } }] };
    const outcome = toolOutcome(
      pane("browser_batch"),
      input,
      undefined,
      [...content(`[navigate] navigated to https://example.com/${seed("Example Domain")}`, `[computer:screenshot] Screenshot size: 400x300${seed("Example Domain")}`), image],
      false,
    );
    expect(outcome.images).toEqual([{ step: 1 }]);
    expect(outcome.steps?.map((s) => s.line)).toEqual(["**↗ navigate** `example.com`", "**▣ screenshot** · 400×300"]);
    expect(toolMarkdown(pane("browser_batch"), input, outcome, "compact", undefined, [1])).toBe(
      "**⧉ browser batch** 2 actions\n- **↗ navigate** `example.com`\n- **▣ screenshot** · 400×300 \u001b[36m[▣ 1]\u001b[39m",
    );
  });
});

describe("browser actions with tools off", () => {
  const line = (entry: object) => JSON.stringify(entry) + "\n";
  const say = (id: string, text: string) => line({ type: "assistant", message: { id: `t-${id}`, content: [{ type: "text", text }], stop_reason: "tool_use" } });
  const call = (id: string, name: string, input: object) =>
    line({ type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" } });
  const result = (id: string, ...blocks: object[]) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: blocks }] } });
  const text = (t: string) => ({ type: "text", text: t });
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };

  function turn() {
    const p = new TranscriptParser();
    p.push(
      line({ type: "user", uuid: "u", message: { role: "user", content: "check the page" } }) +
        call("1", tool("navigate"), { url: "https://example.com/" }) +
        result("1", text("Navigated"), text(context("example.com"))) +
        call("2", tool("computer"), { action: "screenshot" }) +
        result("2", text("Successfully captured screenshot (10x10, png)"), text(context("Example")), image) +
        // A tool hidden with tools off does not end the frame.
        call("3", "Read", { file_path: "a.ts" }) +
        result("3", text("1\tx")) +
        call("4", tool("find"), { query: "link" }) +
        result("4", text("Found 2 matching elements\n\n- ref_1: link\n- ref_2: button"), text(context("Example"))) +
        say("5", "Found it.") +
        call("6", tool("computer"), { action: "scroll", scroll_direction: "down", scroll_amount: 3 }) +
        result("6", text("Scrolled"), text(context("Example")), image),
    );
    return p.turns[0];
  }

  it("frames each run of them, numbers the screenshots across the turn and shows what they found", () => {
    const dim = (s: string) => `${ESC}[2m${s}${ESC}[22m`;
    const mark = (n: number) => `${ESC}[36m[▣ ${n}]${ESC}[39m`;
    expect(turnMarkdown(turn(), { tools: "off", thinking: false })).toBe(
      `${CYAN_FRAME}Claude in Chrome · 3 actions · 1 screenshot\n` +
        "- **↗ navigate** `example.com/`\n\n" +
        // The page the navigation led to replaces "example.com", the one it showed while loading.
        "*on Example*\n\n" +
        `- **▣ screenshot** · 10×10 ${mark(1)}\n` +
        `- **⌕ browser find** \`link\` · → 2 elements  \n  ${dim(`ref${ESCAPED_UNDERSCORE}1: link`)}  \n  ${dim(`ref${ESCAPED_UNDERSCORE}2: button`)}\n` +
        `${FRAME_END}\n\n` +
        "Found it.\n\n" +
        `${CYAN_FRAME}Claude in Chrome · 1 action · 1 screenshot\n` +
        "*on Example*\n\n" +
        `- **↕ scroll** down 3 ${mark(2)}\n` +
        FRAME_END,
    );
  });

  it("numbers the screenshots and leaves the frames out when copying", () => {
    expect(turnScreenshots(turn()).map((s) => [s.n, s.block.id, s.index])).toEqual([
      [1, "2", 0],
      [2, "6", 0],
    ]);
    expect(turnMarkdown(turn(), { tools: "off", thinking: false, browser: false })).toBe("Found it.");
  });

  it("names the key that lists the screenshots after their marks only when asked (on screen)", () => {
    const hint = `${ESC}[2m(o)${ESC}[22m`;
    for (const tools of ["off", "compact", "full"] as const) {
      expect(turnMarkdown(turn(), { tools, thinking: false, shotHint: true })).toContain(`[▣ 2]${ESC}[39m ${hint}`);
      expect(turnMarkdown(turn(), { tools, thinking: false })).not.toContain("(o)");
    }
  });

  it("finds a screenshot mark under the pointer", () => {
    const rendered = "│   * ↕ scroll down 3 \u001b[36m[▣ 12]\u001b[39m";
    const at = stripAnsi(rendered).indexOf("[");
    expect(shotAt(rendered, at)).toBe(12);
    expect(shotAt(rendered, at + 5)).toBe(12);
    expect(shotAt(rendered, at - 1)).toBeUndefined();
  });
});
