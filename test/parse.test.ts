import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TranscriptParser, turnMarkdown } from "../src/transcript/parse.js";

const fixture = readFileSync(new URL("./fixtures/session.jsonl", import.meta.url), "utf8");

describe("TranscriptParser", () => {
  it("builds one turn per real prompt", () => {
    const p = new TranscriptParser();
    p.push(fixture);
    expect(p.turns.map((t) => t.prompt)).toEqual([
      "Explain **hooks**",
      "/color green",
      "Second prompt",
      "also add tests",
    ]);
  });

  it("starts a turn for a prompt sent while Claude was working", () => {
    const p = new TranscriptParser();
    p.push(fixture);
    const [before, queued] = p.turns.slice(-2);
    expect(before.queued).toBeUndefined();
    expect(before.blocks).toEqual([{ kind: "text", text: "Working on it." }]);
    expect(queued).toMatchObject({ id: "q1", prompt: "also add tests", queued: true });
    expect(queued.blocks).toEqual([{ kind: "text", text: "Tests added." }]);
  });

  it("takes the text of a queued prompt with a pasted image", () => {
    const queued = (uuid: string, prompt: unknown) =>
      JSON.stringify({ type: "attachment", uuid, attachment: { type: "queued_command", prompt, humanTurn: true } }) + "\n";
    const p = new TranscriptParser();
    p.push(
      queued("q1", [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        { type: "text", text: "what is on this screenshot?" },
      ]) + queued("q2", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]),
    );
    expect(p.turns.map((t) => t.prompt)).toEqual(["what is on this screenshot?", "[Image]"]);
  });

  it("starts a turn for a prompt of images only", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const user = (uuid: string, content: unknown[]) =>
      JSON.stringify({ type: "user", uuid, message: { role: "user", content } }) + "\n";
    const p = new TranscriptParser();
    p.push(
      user("u1", [image, image, image]) +
        user("u2", [image]) +
        user("u3", [image, { type: "text", text: "and this?" }]) +
        // A tool's image result is no prompt.
        user("u4", [{ type: "tool_result", tool_use_id: "t1", content: [image] }]),
    );
    expect(p.turns.map((t) => t.prompt)).toEqual(["[3 images]", "[Image]", "and this?"]);
  });

  describe("turn state", () => {
    const line = (entry: object) => JSON.stringify(entry) + "\n";
    const prompt = (uuid: string, text: string) => line({ type: "user", uuid, message: { role: "user", content: text } });
    const assistant = (stop: string | null, content: object[] = [{ type: "text", text: "…" }], extra = {}) =>
      line({ type: "assistant", message: { id: "m", content, stop_reason: stop }, ...extra });
    const userText = (text: string, extra = {}) =>
      line({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, ...extra });

    it("is running until Claude ends its turn", () => {
      const p = new TranscriptParser();
      p.push(prompt("a", "fix it") + assistant("tool_use", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]));
      expect(p.turns[0].done).toBe(false);
      p.push(assistant("end_turn"));
      expect(p.turns[0].done).toBe(true);
      expect(p.turns[0].interrupted).toBeUndefined();
    });

    it("is done after the turn_duration entry", () => {
      const p = new TranscriptParser();
      p.push(prompt("a", "fix it") + assistant(null));
      expect(p.turns[0].done).toBe(false);
      expect(p.push(line({ type: "system", subtype: "turn_duration", durationMs: 5 }))).toBe(true);
      expect(p.turns[0].done).toBe(true);
    });

    it("marks interrupts without starting a turn", () => {
      const p = new TranscriptParser();
      p.push(prompt("a", "one") + assistant("tool_use") + userText("[Request interrupted by user for tool use]"));
      p.push(prompt("b", "two") + userText("[Request interrupted by user]"));
      expect(p.turns.map((t) => [t.prompt, t.interrupted, t.done])).toEqual([
        ["one", "tool", true],
        ["two", "user", true],
      ]);
    });

    it("ignores interrupts of subagents", () => {
      const p = new TranscriptParser();
      p.push(prompt("a", "one") + userText("[Request interrupted by user]", { isSidechain: true }));
      expect(p.turns[0].interrupted).toBeUndefined();
      expect(p.turns[0].done).toBeUndefined();
    });

    it("ends local commands with their output", () => {
      const p = new TranscriptParser();
      p.push(prompt("a", "<command-name>/color</command-name><command-args>green</command-args>"));
      expect(p.turns[0].done).toBeUndefined();
      p.push(userText("<local-command-stdout>Session color set</local-command-stdout>"));
      expect(p.turns[0].done).toBe(true);
    });

    it("shows slash commands recorded as system entries (/rename), finished", () => {
      const local = (uuid: string, content: string) => line({ type: "system", subtype: "local_command", uuid, content, isMeta: false });
      const p = new TranscriptParser();
      p.push(
        local("r1", "<command-name>/rename</command-name>\n            <command-message>rename</command-message>\n            <command-args>test</command-args>") +
          local("r2", "<local-command-stdout>Session renamed to: test</local-command-stdout>") +
          line({ type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>\nThe user named this session \"test\".\n</system-reminder>" } }),
      );
      expect(p.turns).toEqual([{ id: "r1", prompt: "/rename test", timestamp: undefined, blocks: [], done: true }]);
    });

    it("puts a recap below the answer it follows, without the hint on turning it off", () => {
      const p = new TranscriptParser();
      p.push(
        prompt("a", "fix it") +
          assistant("end_turn", [{ type: "text", text: "Fixed." }]) +
          line({ type: "system", subtype: "away_summary", content: "Goal: fix it. Next: `npm test`. (disable recaps in /config)" }),
      );
      expect(p.turns).toHaveLength(1);
      expect(p.turns[0].done).toBe(true);
      expect(p.turns[0].blocks).toEqual([
        { kind: "text", text: "Fixed." },
        { kind: "recap", text: "Goal: fix it. Next: `npm test`." },
      ]);
      // Not part of the answer's Markdown (copied with c).
      expect(turnMarkdown(p.turns[0], { tools: "off", thinking: false })).toBe("Fixed.");
    });

    it("names the answer a continued transcript starts with, whose prompt is in the one before", () => {
      const p = new TranscriptParser();
      p.push(
        line({ type: "system", subtype: "compact_boundary", uuid: "b", compactMetadata: { trigger: "auto", preTokens: 200000, postTokens: 9000 } }) +
          assistant("end_turn", [{ type: "text", text: "Merged." }], { sessionId: "next" }),
      );
      expect(p.turns.map((t) => [t.id, t.prompt, t.continuation])).toEqual([
        ["start", "Continued from an earlier session", { sessionId: "next", compact: { trigger: "auto", preTokens: 200000, postTokens: 9000, durationMs: undefined } }],
      ]);
    });

    const summary = (uuid: string, body: string) =>
      line({
        type: "user",
        uuid,
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: {
          role: "user",
          content:
            "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n" +
            body +
            "\n\nIf you need specific details from before compaction (like exact code snippets), read the full transcript at: C:\\x.jsonl\nContinue the conversation from where it left off without asking the user any further questions.",
        },
      });

    it("shows /compact once, with the summary as its answer", () => {
      const p = new TranscriptParser();
      p.push(
        // Written as typed first, then as a command once the conversation is compacted.
        prompt("raw", "/compact") +
          line({ type: "system", subtype: "compact_boundary", uuid: "b", compactMetadata: { trigger: "manual", preTokens: 216765, postTokens: 9633, durationMs: 43287 } }) +
          summary("s", "1. Primary Request:\n   - fix it") +
          prompt("c", "<command-name>/compact</command-name>\n<command-args></command-args>") +
          prompt("o", "<local-command-stdout>Compacted</local-command-stdout>"),
      );
      expect(p.turns.map((t) => t.prompt)).toEqual(["/compact"]);
      expect(p.turns[0].done).toBe(true);
      // Only the summary: the lines meant for Claude are left out.
      expect(p.turns[0].blocks).toEqual([
        { kind: "compact", text: "1. Primary Request:\n   - fix it", info: { trigger: "manual", preTokens: 216765, postTokens: 9633, durationMs: 43287 } },
      ]);
    });

    it("makes an automatic compaction mid-turn an entry of its own, which the work after it belongs to", () => {
      const p = new TranscriptParser();
      p.push(
        prompt("a", "refactor it") +
          assistant("tool_use", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]) +
          line({ type: "system", subtype: "compact_boundary", uuid: "b", compactMetadata: { trigger: "auto", preTokens: 167000, postTokens: 12000 } }) +
          summary("s", "Refactoring half done.") +
          assistant("end_turn", [{ type: "text", text: "Done now." }]),
      );
      expect(p.turns.map((t) => [t.prompt, t.compacted, t.blocks.map((b) => b.kind)])).toEqual([
        ["refactor it", undefined, ["tool"]],
        ["Conversation compacted automatically", true, ["compact", "text"]],
      ]);
    });

    it("notes where the session continues, and with dedupe skips the entries copied there", () => {
      const p = new TranscriptParser({ dedupe: true });
      const answer = line({ type: "assistant", uuid: "r", message: { id: "m1", content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" } });
      p.push(
        prompt("a", "fix it") +
          answer +
          prompt("c", "/compact") +
          line({ type: "system", subtype: "informational", content: "Backgrounding after the current tool finishes…" }) +
          line({ type: "system", subtype: "compact_boundary", uuid: "b", compactMetadata: { trigger: "manual", preTokens: 216765, postTokens: 9633, durationMs: 43287 } }) +
          line({ type: "continued-in", sessionId: "first", continuedInSessionId: "next" }),
      );
      expect(p.continuedIn).toBe("next");
      // Where it went on is an entry of its own.
      expect(p.turns.at(-1)).toMatchObject({
        id: "continued-next",
        prompt: "Session continues in next",
        done: true,
        continuation: {
          sessionId: "next",
          fromSessionId: "first",
          compact: { trigger: "manual", preTokens: 216765, postTokens: 9633, durationMs: 43287 },
          backgrounded: true,
        },
      });
      p.nextFile();
      // The continued transcript starts with copies of the last entries, then goes on.
      p.push(answer + prompt("c", "/compact") + assistant("end_turn", [{ type: "text", text: "Compacted, go on." }]));
      expect(p.turns.map((t) => [t.prompt, t.blocks.map((b) => (b.kind === "text" ? b.text : b.kind))])).toEqual([
        ["fix it", ["Done."]],
        ["/compact", []],
        // Claude's answers after it belong to it: no prompt comes before them.
        ["Session continues in next", ["Compacted, go on."]],
      ]);
    });

    it("makes a ! command one finished turn with its output as the answer", () => {
      // As Claude Code writes it once the command ended: caveat, input, output (escaped, with color codes).
      const p = new TranscriptParser();
      p.push(
        line({ type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat: …</local-command-caveat>" } }) +
          prompt("b1", "<bash-input> gh auth refresh -s workflow &amp;&amp; echo ok</bash-input>") +
          prompt("b2", "<bash-stdout>\u001b[32mok\u001b[39m &lt;done&gt;</bash-stdout><bash-stderr>warning: `x`</bash-stderr>"),
      );
      expect(p.turns).toHaveLength(1);
      expect(p.turns[0]).toMatchObject({ id: "b1", prompt: "! gh auth refresh -s workflow && echo ok", done: true });
      expect(p.turns[0].blocks).toEqual([{ kind: "text", text: "```\nok <done>\nwarning: `x`\n```" }]);
    });

    it("shows a ! command without output as such, and fences output that contains a fence", () => {
      const p = new TranscriptParser();
      p.push(prompt("a", "<bash-input>true</bash-input>") + prompt("b", "<bash-stdout></bash-stdout><bash-stderr></bash-stderr>"));
      p.push(prompt("c", "<bash-input>cat x.md</bash-input>") + prompt("d", "<bash-stdout>```js\n1\n```</bash-stdout><bash-stderr></bash-stderr>"));
      expect(p.turns.map((t) => [t.prompt, t.done, t.blocks])).toEqual([
        ["! true", true, [{ kind: "text", text: "*(no output)*" }]],
        ["! cat x.md", true, [{ kind: "text", text: "````\n```js\n1\n```\n````" }]],
      ]);
    });
  });

  it("collects assistant blocks in order and skips sidechains", () => {
    const p = new TranscriptParser();
    p.push(fixture);
    expect(p.turns[0].blocks.map((b) => b.kind)).toEqual(["thinking", "text", "tool", "text"]);
    expect(JSON.stringify(p.turns)).not.toContain("subagent chatter");
  });

  it("buffers incomplete lines across chunks", () => {
    const p = new TranscriptParser();
    const cut = fixture.indexOf("Second prompt");
    expect(p.push(fixture.slice(0, cut))).toBe(true);
    expect(p.turns).toHaveLength(2);
    expect(p.push(fixture.slice(cut))).toBe(true);
    expect(p.turns).toHaveLength(4);
  });

  it("builds Markdown with optional tools and thinking", () => {
    const p = new TranscriptParser();
    p.push(fixture);
    const turn = p.turns[0];
    expect(turnMarkdown(turn, { tools: "off", thinking: false })).toBe(
      "## Hooks\n\n- **Stop** runs after a reply\n\nDone.",
    );
    const full = turnMarkdown(turn, { tools: "compact", thinking: true });
    expect(full).toContain("> Let me think");
    expect(full).toContain("**⚙ Bash** `ls -la`");
  });
});
