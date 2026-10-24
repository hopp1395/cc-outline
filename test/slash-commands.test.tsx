import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS } from "../src/builtinCommands.js";
import { remote, type RemoteEvent } from "../src/remote/api.js";
import { initCommands, remoteCommands } from "../src/remote/commands.js";
import { SESSIONS_SCOPE } from "../src/remote/credentials.js";
import { commandQuery, folderSkills, frontMatter, matchCommands, parseSkillListing, readSkillListing, sessionCommands, takeCommand, type CommandSource } from "../src/slashCommands.js";
import { PromptEditor } from "../src/tui/PromptEditor.js";
import { SessionComposer, type PromptChannel } from "../src/tui/SessionComposer.js";
import type { Layout } from "../src/tui/layout.js";
import { renderInk } from "./helpers/ink.js";

const listing = (names: string[], isInitial = true) =>
  JSON.stringify({
    type: "attachment",
    isSidechain: false,
    attachment: { type: "skill_listing", content: names.map((n) => `- ${n}: does ${n}`).join("\n"), skillCount: names.length, isInitial, names },
  });

let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cco-commands-"));
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "config");
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

describe("skill listing", () => {
  it("reads names and descriptions, a plugin's with its prefix", () => {
    const skills = parseSkillListing({ content: "- grilling: Grill the user.\n- cco:open: Open the viewer: in a pane\n- other: x", names: ["grilling", "cco:open"] });
    expect(skills).toEqual([
      { name: "grilling", description: "Grill the user." },
      { name: "cco:open", description: "Open the viewer: in a pane" },
    ]);
  });

  it("takes the last whole listing and the skills added after it", async () => {
    const file = join(dir, "s.jsonl");
    const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(2000) } });
    writeFileSync(file, [listing(["old"]), filler, listing(["a", "b"]), filler, listing(["c"], false), filler, ""].join("\n"));
    expect((await readSkillListing(file))?.map((s) => s.name)).toEqual(["a", "b", "c"]);
    writeFileSync(join(dir, "none.jsonl"), `${filler}\n`);
    expect(await readSkillListing(join(dir, "none.jsonl"))).toBeUndefined();
    expect(await readSkillListing(join(dir, "missing.jsonl"))).toBeUndefined();
  });

  it("finds a listing more than a read chunk before the end", async () => {
    const file = join(dir, "big.jsonl");
    const filler = JSON.stringify({ type: "user", message: { content: "y".repeat(300_000) } });
    writeFileSync(file, [listing(["far"]), filler, filler, filler, filler, ""].join("\n"));
    expect((await readSkillListing(file))?.map((s) => s.name)).toEqual(["far"]);
  });
});

describe("folders", () => {
  it("reads front matter", () => {
    expect(frontMatter('---\nname: x\ndescription: "Does x"\nargument-hint: [file]\n---\nbody').fields).toEqual({ name: "x", description: "Does x", "argument-hint": "[file]" });
    expect(frontMatter("no front matter").fields).toEqual({});
  });

  it("lists the user's and the project's skills and commands and those of enabled plugins", () => {
    const config = join(dir, "config");
    const cwd = join(dir, "project");
    write(join(config, "skills", "grilling", "SKILL.md"), "---\nname: grilling\ndescription: Grill\n---\n");
    write(join(config, "skills", "hidden", "SKILL.md"), "---\nname: hidden\ndescription: no\nuser-invocable: false\n---\n");
    write(join(cwd, ".claude", "skills", "release", "SKILL.md"), '---\nname: release\ndescription: Release it\nargument-hint: "[patch|minor]"\ndisable-model-invocation: true\n---\n');
    write(join(cwd, ".claude", "commands", "git", "fix.md"), "# Fix the build\n");
    const plugin = join(config, "plugins", "cache", "cco");
    write(join(plugin, "commands", "open.md"), "---\ndescription: Open the viewer\n---\n");
    write(join(config, "plugins", "cache", "off", "commands", "no.md"), "nope");
    write(
      join(config, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "cco@cc-outline": [{ scope: "user", installPath: plugin }], "off@x": [{ scope: "user", installPath: join(config, "plugins", "cache", "off") }] } }),
    );
    write(join(config, "settings.json"), JSON.stringify({ enabledPlugins: { "cco@cc-outline": true, "off@x": false } }));
    expect(folderSkills({ cwd, configDir: config })).toEqual([
      { name: "grilling", description: "Grill" },
      { name: "release", description: "Release it", argumentHint: "[patch|minor]" },
      { name: "git:fix", description: "Fix the build" },
      { name: "cco:open", description: "Open the viewer" },
    ]);
  });

  it("puts the listing first, the folders' others after it and Claude Code's own last, each name once", async () => {
    const config = join(dir, "config");
    const cwd = join(dir, "project");
    write(join(config, "skills", "grilling", "SKILL.md"), "---\nname: grilling\ndescription: from the folder\n---\n");
    write(join(config, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: only mine\n---\n");
    const transcript = join(dir, "s.jsonl");
    writeFileSync(transcript, `${listing(["grilling", "compact"])}\n`);
    const all = await sessionCommands({ transcript, cwd, configDir: config });
    expect(all.slice(0, 3).map((c) => [c.name, c.description])).toEqual([
      ["grilling", "does grilling"],
      ["compact", "does compact"],
      ["mine", "only mine"],
    ]);
    expect(all.filter((c) => c.name === "compact")).toHaveLength(1);
    expect(all.length).toBe(3 + BUILTIN_COMMANDS.filter((c) => c.name !== "compact").length);
  });
});

describe("matching", () => {
  const commands = [
    { name: "compact", description: "" },
    { name: "cco:open", description: "" },
    { name: "open-pr", description: "" },
    { name: "usage", description: "", aliases: ["cost"] },
    { name: "recompile", description: "" },
  ];

  it("opens only while the command's name is typed at the prompt's start", () => {
    expect(commandQuery("/com", 4)).toBe("com");
    expect(commandQuery("/", 1)).toBe("");
    expect(commandQuery("/compact now", 12)).toBeUndefined();
    expect(commandQuery("/compact now", 3)).toBe("co");
    expect(commandQuery("see src/x", 9)).toBeUndefined();
    expect(commandQuery("/x", 0)).toBeUndefined();
  });

  it("puts names starting with the text first, a plugin's by its part after the prefix too, then the rest", () => {
    expect(matchCommands(commands, "op").map((c) => c.name)).toEqual(["cco:open", "open-pr"]);
    expect(matchCommands(commands, "comp").map((c) => c.name)).toEqual(["compact", "recompile"]);
    expect(matchCommands(commands, "cost").map((c) => c.name)).toEqual(["usage"]);
    expect(matchCommands(commands, "").length).toBe(5);
  });

  it("takes a command in place of the name typed, keeping what follows", () => {
    expect(takeCommand("/com", "compact")).toEqual({ text: "/compact ", cursor: 9 });
    expect(takeCommand("/co keep this", "compact")).toEqual({ text: "/compact keep this", cursor: 9 });
  });
});

const layout: Layout = { columns: 80, rows: 24, listWidth: 0, previewWidth: 80, bodyHeight: 24 };

/** A session whose transcript lists grilling and git-review, in a project folder of its own. */
function source(): CommandSource {
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, `${listing(["grilling", "git-review"])}\n`);
  return { transcript, cwd: join(dir, "project"), configDir: join(dir, "config") };
}

describe("the prompt line's list", () => {
  it("opens on /, filters, and sends the command chosen with Enter", async () => {
    const sent: string[] = [];
    const channel: PromptChannel = { send: async (text) => void sent.push(text), interrupt: async () => {} };
    const view = renderInk(
      <SessionComposer layout={layout} channel={channel} title="t" working={false} focused onFocus={() => {}} notify={() => {}} onHeight={() => {}} commands={source()} />,
      layout,
    );
    await view.press("/gr");
    await expect.poll(view.frame).toContain("/grilling");
    expect(view.frame()).toContain("does grilling");
    expect(view.frame()).not.toContain("/git-review");
    await view.press("\u001b");
    await expect.poll(view.frame).not.toContain("does grilling");
    // Another name typed opens it again.
    await view.press("\u007f");
    await view.press("it");
    await expect.poll(view.frame).toContain("/git-review");
    await view.press("\r");
    await expect.poll(() => sent).toEqual(["/git-review"]);
    view.unmount();
  });

  it("offers nothing without a source, as for a remote session", async () => {
    const channel: PromptChannel = { send: async () => {}, interrupt: async () => {} };
    const view = renderInk(<SessionComposer layout={layout} channel={channel} title="t" working={false} focused onFocus={() => {}} notify={() => {}} onHeight={() => {}} />, layout);
    await view.press("/gr");
    await expect.poll(view.frame).toContain("› /gr");
    expect(view.frame()).not.toContain("Esc close the list");
    view.unmount();
  });
});

describe("the prompt editor's list", () => {
  it("takes a command with Tab or Enter and goes on writing", async () => {
    let handed: string | undefined;
    const view = renderInk(
      <PromptEditor layout={layout} title="Prompt" detail="where" draftKey="cmd" commands={source()} onSubmit={(text) => (handed = text)} onCancel={() => {}} />,
      layout,
    );
    await view.press("/gi");
    await expect.poll(view.frame).toContain("/git-review");
    expect(view.frame()).not.toContain("/grilling");
    await view.press("\u007f");
    await view.press("r");
    await expect.poll(view.frame).toContain("/grilling");
    await view.press("\r");
    await expect.poll(view.frame).toContain("› /grilling");
    expect(view.frame()).not.toContain("does grilling");
    await view.press("my plan");
    await view.press("\u0013");
    await expect.poll(() => handed).toBe("/grilling my plan");
    view.unmount();
  });
});

/** The recording of an initialize sent to a Remote Control session (2.1.310): the request, the answer, the init. */
const recorded = readFileSync(join(import.meta.dirname, "fixtures", "remote-initialize.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => (JSON.parse(l) as { data: Record<string, unknown> }).data);
const asEvent = (raw: Record<string, unknown>): RemoteEvent => ({ sequence: Number(raw.sequence_num), source: raw.source as string, payload: raw.payload as Record<string, unknown> });

describe("a remote session's commands", () => {
  it("are the recorded init's slash commands without the terminal's, described where Claude Code's own", () => {
    const commands = initCommands(recorded.map(asEvent))!;
    const names = commands.map((c) => c.name);
    expect(names).toContain("cco:open");
    expect(names).toContain("compact");
    for (const hidden of ["exit", "doctor", "statusline", "color", "focus", "reload-plugins"]) expect(names).not.toContain(hidden);
    expect(commands.find((c) => c.name === "compact")!.description).toBe(BUILTIN_COMMANDS.find((c) => c.name === "compact")!.description);
    expect(commands.find((c) => c.name === "grilling")!.description).toBe("");
    // The answer to initialize lists no commands for a Remote Control session.
    const answer = recorded.find((e) => (e.payload as { type?: string }).type === "control_response")!;
    expect((answer.payload as { response: { response: { commands: unknown[] } } }).response.response.commands).toEqual([]);
    // A worker before 2.1.310 wrote its init with the session id only.
    expect(initCommands([{ sequence: 1, payload: { type: "system", subtype: "init", session_id: "cse_1" } }])).toBeUndefined();
  });

  describe("from claude.ai", () => {
    const realFetch = remote.fetch;
    let posted: Record<string, unknown>[];
    let served: Record<string, unknown>[];
    beforeEach(() => {
      const config = process.env.CLAUDE_CONFIG_DIR!;
      mkdirSync(config, { recursive: true });
      writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 3_600_000, scopes: [SESSIONS_SCOPE] } }));
      writeFileSync(join(config, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", organizationUuid: "org-1" } }));
      posted = [];
      served = [];
      remote.fetch = async (_url, init) => {
        if (init.method === "POST") {
          posted.push(...(JSON.parse(String(init.body)) as { events: { payload: Record<string, unknown> }[] }).events.map((e) => e.payload));
          // The worker answers with the init.
          served = recorded;
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify({ data: [...served].reverse() }), { status: 200 });
      };
    });
    afterEach(() => {
      remote.fetch = realFetch;
    });

    it("asks with initialize only when no init lists them yet", async () => {
      const commands = await remoteCommands("cse_1", async () => {});
      expect(posted).toEqual([{ type: "control_request", request_id: expect.any(String), request: { subtype: "initialize" } }]);
      expect(commands.map((c) => c.name)).toContain("grilling");
      posted = [];
      expect((await remoteCommands("cse_1", async () => {})).length).toBe(commands.length);
      expect(posted).toEqual([]);
    });

    it("lists them in a remote session viewer's prompt line", async () => {
      served = recorded;
      const channel: PromptChannel = { send: async () => {}, interrupt: async () => {} };
      const view = renderInk(
        <SessionComposer layout={layout} channel={channel} title="◈ t" working={false} focused onFocus={() => {}} notify={() => {}} onHeight={() => {}} commands={{ remoteId: "cse_remote" }} />,
        layout,
      );
      await view.press("/cco:o");
      await expect.poll(view.frame).toContain("/cco:open");
      view.unmount();
    });
  });
});
