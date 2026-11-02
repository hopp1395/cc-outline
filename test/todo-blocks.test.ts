import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { proc } from "../src/proc.js";
import { askBlocks, blocksArgs, blocksPrompt, forgetBlocks, parseBlocks, rememberedBlocks } from "../src/todoBlocks.js";
import { claudeOutput, fakeSpawn } from "./helpers/fakeClaude.js";

const realSpawn = proc.spawn;
afterAll(() => {
  proc.spawn = realSpawn;
  forgetBlocks();
});

let fake: ReturnType<typeof fakeSpawn>;
beforeEach(() => {
  fake = fakeSpawn();
  proc.spawn = fake.spawn as unknown as typeof proc.spawn;
  forgetBlocks();
});

describe("parseBlocks", () => {
  it("writes the section only where the blocks stand under more than one", () => {
    const two = claudeOutput([
      { title: "3. Texte", section: "Task #722: Drei Anordnungen", text: "Inhalt: Tipps anpassen\nBeleg: HintCatalogTests" },
      { title: "5. Profil", section: "Task #723: Arbeitsplatz je Gerät", text: "Inhalt: Api-Endpunkte" },
    ]);
    expect(parseBlocks(two).map((b) => b.text)).toEqual([
      "3. Texte\nTask #722: Drei Anordnungen\nInhalt: Tipps anpassen\nBeleg: HintCatalogTests",
      "5. Profil\nTask #723: Arbeitsplatz je Gerät\nInhalt: Api-Endpunkte",
    ]);
    const one = claudeOutput([
      { title: "Block 1", section: "Plan", text: "a" },
      { title: "Block 2", section: "Plan", text: "b" },
    ]);
    expect(parseBlocks(one).map((b) => b.text)).toEqual(["Block 1\na", "Block 2\nb"]);
  });

  it("keeps a block with only a title, and leaves out empty ones", () => {
    expect(parseBlocks(claudeOutput([{ title: "Doku" }, { title: " " }])).map((b) => b.text)).toEqual(["Doku"]);
    expect(parseBlocks(claudeOutput([]))).toEqual([]);
  });

  it("says what went wrong", () => {
    expect(() => parseBlocks(JSON.stringify({ is_error: true, result: "Credit balance too low" }))).toThrow("Credit balance too low");
    expect(() => parseBlocks(JSON.stringify({ is_error: false, result: "plain text" }))).toThrow("no list of blocks");
    expect(() => parseBlocks("Not logged in\nmore")).toThrow(/^Not logged in$/);
    expect(() => parseBlocks("")).toThrow("printed nothing");
  });
});

describe("askBlocks", () => {
  it("runs without a transcript, hooks or tools, and sends the answer on stdin", async () => {
    const run = askBlocks("# Plan", "linux");
    const [spawned] = fake.runs;
    expect(spawned!.command).toBe("claude");
    expect(spawned!.args).toEqual(blocksArgs());
    expect(spawned!.args).toEqual(expect.arrayContaining(["-p", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", JSON.stringify({ disableAllHooks: true })]));
    expect(spawned!.args[spawned!.args.indexOf("--model") + 1]).toBe("haiku");
    expect(spawned!.args[spawned!.args.indexOf("--tools") + 1]).toBe("");
    await expect.poll(() => spawned!.stdin).toBe(blocksPrompt("# Plan"));
    spawned!.finish(claudeOutput([{ title: "A" }, { title: "B" }]));
    await expect(run.result).resolves.toEqual([{ text: "A" }, { text: "B" }]);
  });

  it("goes through the shell on Windows, where claude may be a .cmd shim", () => {
    askBlocks("x", "win32").cancel();
    expect(fake.runs[0]!.options.shell).toBe(true);
    expect(fake.runs[0]!.command).toMatch(/^claude -p --model haiku /);
    // An empty argument and JSON survive cmd.exe.
    expect(fake.runs[0]!.command).toContain('--tools ""');
    expect(fake.runs[0]!.command).toContain('"{""disableAllHooks"":true}"');
  });

  it("does not tie the run to the session the viewer was opened from", () => {
    const before = process.env.CLAUDE_CODE_CHILD_SESSION;
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    askBlocks("x", "linux").cancel();
    if (before === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION;
    else process.env.CLAUDE_CODE_CHILD_SESSION = before;
    expect(fake.runs[0]!.options.env?.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
  });

  it("remembers what it found, but not an empty result", async () => {
    const found = askBlocks("mit Plan", "linux");
    fake.runs[0]!.finish(claudeOutput([{ title: "A" }]));
    await found.result;
    expect(rememberedBlocks("mit Plan")).toEqual([{ text: "A" }]);
    const empty = askBlocks("ohne Plan", "linux");
    fake.runs[1]!.finish(claudeOutput([]));
    await expect(empty.result).resolves.toEqual([]);
    expect(rememberedBlocks("ohne Plan")).toBeUndefined();
  });

  it("stops a run that takes too long, and reports it", async () => {
    const run = askBlocks("x", "linux");
    await expect(run.result).rejects.toThrow(/no answer after/);
    expect(fake.runs[0]!.killed).toBe(true);
  });

  it("kills the run when cancelled and reports nothing", async () => {
    const run = askBlocks("x", "linux");
    let settled = false;
    void run.result.finally(() => (settled = true)).catch(() => {});
    run.cancel();
    expect(fake.runs[0]!.killed).toBe(true);
    await expect.poll(() => fake.runs[0]!.killed).toBe(true);
    expect(settled).toBe(false);
    expect(rememberedBlocks("x")).toBeUndefined();
  });

  it("kills the whole process tree on Windows", () => {
    const run = askBlocks("x", "win32");
    run.cancel();
    // The fake has no pid, so it falls back to the child's kill; with a pid it is taskkill (below).
    expect(fake.runs[0]!.killed).toBe(true);
    const withPid = fakeSpawn();
    proc.spawn = ((command: string, args: unknown, options: unknown) => {
      const child = withPid.spawn(command, args, options);
      child.pid = 4711;
      return child;
    }) as unknown as typeof proc.spawn;
    askBlocks("y", "win32").cancel();
    expect(withPid.runs[1]!.command).toBe("taskkill");
    expect(withPid.runs[1]!.args).toEqual(["/pid", "4711", "/t", "/f"]);
  });
});
