import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliFile } from "../src/cliPath.js";
import { diagnose, lastPromptTime, repairsOf, repairSteps, runDoctor, runRepairs, type Finding } from "../src/doctor.js";
import { settingsFile } from "../src/settings.js";
import { claudeDir, projectSlug } from "../src/transcript/locate.js";
import { VERSION } from "../src/version.js";

const cwd = join(tmpdir(), "cco-doctor-project");
const slug = projectSlug(cwd);
/** Not a multiple of 4, so never a Windows pid; far above the usual ones elsewhere. */
const DEAD = 999999;
const NPM_ROOT = join(tmpdir(), "cco-doctor-npm", "node_modules", "cc-outline");
const env = { WT_SESSION: "x" };
let saved: string | undefined;

const cco = (name: string) => join(claudeDir(), "cco", name);
const write = (path: string, data: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
};
const check = (root = NPM_ROOT) => diagnose({ cwd, env, root });
const inGroup = (findings: Finding[], group: Finding["group"]) => findings.filter((f) => f.group === group);
const repairAll = (findings: Finding[]) => runRepairs(repairSteps(repairsOf(findings).filter((r) => !r.commands)), () => {});

function installPlugin(version = VERSION, enabled?: boolean) {
  write(join(claudeDir(), "plugins", "installed_plugins.json"), { version: 2, plugins: { "cco@cc-outline": [{ scope: "user", version }] } });
  if (enabled !== undefined) write(join(claudeDir(), "settings.json"), { enabledPlugins: { "cco@cc-outline": enabled } });
}

beforeEach(() => {
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-doctor-"));
  mkdirSync(join(NPM_ROOT, "dist"), { recursive: true });
  writeFileSync(join(NPM_ROOT, "dist", "cli.js"), "");
});
afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("state files", () => {
  it("is clean without a cco folder", () => {
    expect(inGroup(check(), "State files")).toEqual([expect.objectContaining({ severity: "ok" })]);
  });

  it("finds the files of ended processes and keeps those of live ones", async () => {
    write(cco(`${slug}.claude-${DEAD}.json`), {});
    write(cco(`${slug}.viewer-${DEAD}.json`), { pid: DEAD });
    write(cco(`${slug}.control-${DEAD}.json`), { at: 1 });
    write(cco(`${slug}.viewer.json`), { pid: DEAD });
    write(cco(`${slug}.control.json`), { at: 1 });
    write(cco(`${slug}.claude-${process.pid}.json`), {});
    const findings = check();
    const stale = findings.find((f) => f.repair?.id === "stale");
    expect(stale?.paths).toHaveLength(5);
    await repairAll(findings);
    expect(existsSync(cco(`${slug}.claude-${DEAD}.json`))).toBe(false);
    expect(existsSync(cco(`${slug}.viewer.json`))).toBe(false);
    expect(existsSync(cco(`${slug}.claude-${process.pid}.json`))).toBe(true);
  });

  it("keeps the legacy control file while its viewer runs", () => {
    write(cco(`${slug}.viewer.json`), { pid: process.pid });
    write(cco(`${slug}.control.json`), { at: 1 });
    expect(check().find((f) => f.repair?.id === "stale")).toBeUndefined();
  });

  it("renames files that are no JSON object to .corrupt", async () => {
    write(cco(`${slug}.positions.json`), "{ broken");
    write(cco(`${slug}.views.json`), "[1, 2]");
    const findings = check();
    expect(findings.find((f) => f.repair?.id === "corrupt")?.paths).toHaveLength(2);
    await repairAll(findings);
    expect(existsSync(cco(`${slug}.positions.json`))).toBe(false);
    expect(readFileSync(cco(`${slug}.positions.json.corrupt`), "utf8")).toBe("{ broken");
    // A fresh .corrupt copy is kept for a look.
    expect(check().find((f) => f.repair?.id === "leftovers")).toBeUndefined();
  });

  it("deletes unfinished writes, debug logs and old .corrupt copies", async () => {
    write(cco(`${slug}.positions.json.${DEAD}.tmp`), "{}");
    write(cco(`${slug}.positions.json.${process.pid}.tmp`), "{}");
    write(cco(`debug-${DEAD}.log`), "");
    write(cco(`${slug}.views.json.corrupt`), "x");
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(cco(`${slug}.views.json.corrupt`), old, old);
    const findings = check();
    expect(findings.find((f) => f.repair?.id === "leftovers")?.paths).toHaveLength(3);
    await repairAll(findings);
    expect(existsSync(cco(`${slug}.positions.json.${process.pid}.tmp`))).toBe(true);
    expect(existsSync(cco(`debug-${DEAD}.log`))).toBe(false);
  });

  it("deletes the records of sessions that ended over a day ago", () => {
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    write(cco(`${slug}.json`), { ended: true, updated: old });
    write(cco("C--other.json"), { ended: true, updated: new Date().toISOString() });
    write(cco("C--running.json"), { updated: old });
    write(cco("settings.json"), { ended: true });
    expect(check().find((f) => f.repair?.id === "ended")?.paths).toEqual([cco(`${slug}.json`)]);
  });

  it("deletes the restore state of projects without transcripts", () => {
    write(cco(`${slug}.restore.json`), { open: true, view: "chat" });
    write(cco("C--kept.restore.json"), { open: true, view: "chat" });
    mkdirSync(join(claudeDir(), "projects", "C--kept"), { recursive: true });
    expect(check().find((f) => f.repair?.id === "orphaned")?.paths).toEqual([cco(`${slug}.restore.json`)]);
  });

  it("deletes trash folders without a readable manifest", async () => {
    write(join(claudeDir(), "cco", "trash", slug, "good", "manifest.json"), { id: "good" });
    write(join(claudeDir(), "cco", "trash", slug, "bad", "projects", "x.jsonl"), "");
    mkdirSync(join(claudeDir(), "cco", "trash", "C--empty"), { recursive: true });
    const findings = check();
    expect(findings.find((f) => f.repair?.id === "trash")?.paths).toHaveLength(2);
    await repairAll(findings);
    expect(existsSync(join(claudeDir(), "cco", "trash", slug, "bad"))).toBe(false);
    expect(existsSync(join(claudeDir(), "cco", "trash", slug, "good"))).toBe(true);
  });
});

describe("settings", () => {
  it("names each invalid, unknown and old key, and rewrites the file once", async () => {
    write(settingsFile(), { mouse: "yes", placement: "top", updateCheck: false, pinnedGroup: true, showTools: true, wrap: false, colour: 1 });
    const findings = inGroup(check(), "Settings");
    expect(findings.map((f) => f.text)).toEqual([
      'mouse: "yes" is not valid; the default true applies',
      'placement: "top" is not valid; the default "right" applies',
      "updateCheck is the former on/off of update, an old format",
      "pinnedGroup is the former name of pinned favorites, an old format",
      'showTools: true is an old format; "compact" applies',
      "unknown setting colour",
    ]);
    expect(repairsOf(findings)).toHaveLength(1);
    await repairAll(findings);
    const stored = JSON.parse(readFileSync(settingsFile(), "utf8"));
    expect(stored).toMatchObject({ mouse: true, placement: "right", updateMode: "off", pinnedFavorites: true, showTools: "compact", wrap: false });
    expect(stored.colour).toBeUndefined();
    expect(inGroup(check(), "Settings")).toEqual([expect.objectContaining({ severity: "ok" })]);
  });
});

describe("installation", () => {
  it("records the CLI when cli.json is missing or names a file that is gone", async () => {
    let findings = check();
    expect(findings.find((f) => f.repair?.id === "cli")?.severity).toBe("warn");
    write(cliFile(), { cli: join(tmpdir(), "gone", "cli.js") });
    findings = check();
    expect(findings.find((f) => f.repair?.id === "cli")?.severity).toBe("error");
    await repairAll(findings);
    expect(JSON.parse(readFileSync(cliFile(), "utf8"))).toEqual({ cli: join(NPM_ROOT, "dist", "cli.js") });
  });

  it("reports a missing or disabled plugin as an error", () => {
    expect(check().find((f) => f.text.includes("not installed"))?.severity).toBe("error");
    installPlugin(VERSION, false);
    expect(check().find((f) => f.text.includes("disabled"))?.severity).toBe("error");
    installPlugin(VERSION, true);
    expect(inGroup(check(), "Installation").filter((f) => f.severity === "error")).toEqual([]);
  });

  it("updates an older plugin of an npm install; a development install only names the commands", () => {
    installPlugin("0.0.1");
    const npm = check().find((f) => f.text.includes(", older than"));
    expect(npm?.repair?.commands).toEqual(["claude plugin marketplace update cc-outline", "claude plugin update cco@cc-outline"]);
    const dev = check(join(tmpdir(), "checkout")).find((f) => f.text.includes(", older than"));
    expect(dev?.repair).toBeUndefined();
    expect(dev?.hint).toContain("claude plugin update");
  });
});

describe("environment", () => {
  it("warns without a terminal cco can open panes in", () => {
    expect(inGroup(diagnose({ cwd, env: {}, root: NPM_ROOT }), "Environment").find((f) => f.text.includes("tmux"))?.severity).toBe("warn");
    expect(inGroup(diagnose({ cwd, env: { WT_PROFILE_ID: "x" }, root: NPM_ROOT }), "Environment").find((f) => f.text.includes("WT_SESSION"))?.severity).toBe("warn");
  });
});

describe("lastPromptTime", () => {
  it("takes the last prompt typed, not tool results, reminders or shell output", () => {
    const file = join(claudeDir(), "t.jsonl");
    const line = (o: object) => JSON.stringify(o);
    write(
      file,
      [
        line({ type: "user", timestamp: "2026-10-01T08:00:00Z", message: { content: "first" } }),
        line({ type: "user", timestamp: "2026-10-01T09:00:00Z", message: { content: [{ type: "text", text: "second" }] } }),
        line({ type: "assistant", timestamp: "2026-10-01T09:01:00Z", message: { content: [] } }),
        line({ type: "user", timestamp: "2026-10-01T09:02:00Z", message: { content: [{ type: "tool_result", content: "x" }] } }),
        line({ type: "user", timestamp: "2026-10-01T09:03:00Z", isMeta: true, message: { content: "reminder" } }),
        line({ type: "user", timestamp: "2026-10-01T09:04:00Z", message: { content: "<bash-stdout>x</bash-stdout>" } }),
        "",
      ].join("\n"),
    );
    expect(lastPromptTime(file)).toBe(Date.parse("2026-10-01T09:00:00Z"));
  });
});

describe("runRepairs", () => {
  it("runs every step, also after one failed", async () => {
    const done: string[] = [];
    const ok = await runRepairs(
      [
        { label: "a", command: "fails" },
        { label: "b", apply: () => done.push("b") },
        {
          label: "c",
          apply: () => {
            throw new Error("nope");
          },
        },
      ],
      () => {},
      async () => 1,
    );
    expect(ok).toBe(false);
    expect(done).toEqual(["b"]);
  });
});

describe("runDoctor", () => {
  it("fails on errors, repairs with fix and checks again", async () => {
    installPlugin(VERSION, true);
    write(cliFile(), { cli: join(tmpdir(), "gone", "cli.js") });
    write(cco(`${slug}.claude-${DEAD}.json`), {});
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    expect(await runDoctor({ cwd, env, root: NPM_ROOT, out, color: false })).toBe(1);
    expect(lines.at(-1)).toBe("1 error, 1 warning. cco doctor --fix repairs 2 of them.");
    lines.length = 0;
    expect(await runDoctor({ cwd, env, root: NPM_ROOT, out, color: false, fix: true })).toBe(0);
    expect(lines).toContain("After the repair");
    expect(lines.at(-1)).toBe("no problems.");
  });
});
