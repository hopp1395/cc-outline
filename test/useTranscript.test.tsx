import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { Text, render } from "ink";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { useTranscript } from "../src/tui/useTranscript.js";

const line = (entry: object) => JSON.stringify(entry) + "\n";
const prompt = (uuid: string, text: string) => line({ type: "user", uuid, message: { role: "user", content: text } });
const answer = (uuid: string, text: string) =>
  line({ type: "assistant", uuid, message: { id: `m-${uuid}`, content: [{ type: "text", text }], stop_reason: "end_turn" } });

function Probe({ path }: { path: string }) {
  const t = useTranscript(path);
  const turns = t.turns.map((turn) => `${turn.prompt}=${turn.blocks.map((b) => (b.kind === "text" ? b.text : b.kind)).join("+")}@${basename(turn.transcript ?? "")}`);
  return <Text>{`${basename(t.file ?? "")}|${turns.join("|")}`}</Text>;
}

function renderProbe(path: string): { frame: () => string; unmount: () => void } {
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 300, rows: 10 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let output = "";
  stdout.on("data", (chunk) => {
    const frame = stripAnsi(String(chunk));
    if (frame.trim()) output = frame.trim();
  });
  const app = render(<Probe path={path} />, { stdout: stdout as never, stdin: stdin as never, debug: true, patchConsole: false });
  return { frame: () => output, unmount: () => app.unmount() };
}

describe("useTranscript", () => {
  it("opened on a continued transcript, starts with the turns of the ones before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cco-continue-"));
    writeFileSync(
      join(dir, "first.jsonl"),
      prompt("a", "fix it") + answer("r", "Done.") + prompt("c", "/compact") + line({ type: "continued-in", continuedInSessionId: "next" }),
    );
    const next = join(dir, "next.jsonl");
    // As after /resume: the viewer opens the later transcript, which starts with the boundary and copies.
    writeFileSync(
      next,
      line({ type: "system", subtype: "compact_boundary", uuid: "b" }) + answer("r", "Done.") + prompt("c", "/compact") + answer("n", "Go on."),
    );
    const probe = renderProbe(next);
    await expect
      .poll(probe.frame, { timeout: 3000 })
      .toBe("next.jsonl|fix it=Done.@first.jsonl|/compact=Go on.@first.jsonl");
    probe.unmount();
  });

  it("reads on in the transcript a session continued in, keeping its turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cco-continue-"));
    const first = join(dir, "first.jsonl");
    const next = join(dir, "next.jsonl");
    writeFileSync(first, prompt("a", "fix it") + answer("r", "Done.") + prompt("c", "/compact"));
    const probe = renderProbe(first);
    await expect.poll(probe.frame, { timeout: 3000 }).toBe("first.jsonl|fix it=Done.@first.jsonl|/compact=@first.jsonl");

    // As Claude Code does it: the new transcript starts with copies of the last entries.
    writeFileSync(next, answer("r", "Done.") + prompt("c", "/compact"));
    appendFileSync(first, line({ type: "continued-in", continuedInSessionId: "next" }));
    appendFileSync(next, answer("n", "Go on."));
    await expect
      .poll(probe.frame, { timeout: 5000 })
      .toBe("next.jsonl|fix it=Done.@first.jsonl|/compact=Go on.@first.jsonl");

    appendFileSync(next, prompt("d", "more") + answer("m", "More."));
    await expect.poll(probe.frame, { timeout: 5000 }).toContain("|more=More.@next.jsonl");
    probe.unmount();
  });
});
