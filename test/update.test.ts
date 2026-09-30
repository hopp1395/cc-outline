import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareVersions,
  fetchReleases,
  installKind,
  mergeReleases,
  parseReleases,
  readCachedReleases,
  releasesBetween,
  remainingCommands,
  runUpdate,
  saveReleases,
  takeSeenVersion,
  updateState,
  UPDATE_STEPS,
} from "../src/update.js";

describe("compareVersions", () => {
  it("compares numerically, ignoring a leading v and a prerelease suffix", () => {
    expect(compareVersions("0.10.0", "0.9.1")).toBe(1);
    expect(compareVersions("v0.7.0", "0.7.0")).toBe(0);
    expect(compareVersions("0.7", "0.7.0")).toBe(0);
    expect(compareVersions("0.7.0", "0.7.1")).toBe(-1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0);
  });
});

describe("parseReleases", () => {
  it("keeps published releases, newest first, with notes and date", () => {
    const releases = parseReleases([
      { tag_name: "v0.6.0", name: "v0.6.0", body: "a\r\nb", published_at: "2026-09-01T10:00:00Z", html_url: "https://x/v0.6.0" },
      { tag_name: "v0.8.0", draft: true },
      { tag_name: "v0.7.1-rc.1", prerelease: true },
      { tag_name: "v0.7.0", name: "", body: null },
      { name: "no tag" },
    ]);
    expect(releases?.map((r) => r.tag)).toEqual(["v0.7.0", "v0.6.0"]);
    expect(releases?.[0]).toMatchObject({ version: "0.7.0", title: "v0.7.0", body: "" });
    expect(releases?.[1]).toMatchObject({ body: "a\nb", date: "2026-09-01T10:00:00Z", url: "https://x/v0.6.0" });
  });

  it("drops the closing link to the full changelog", () => {
    const body = "### Chat\r\n\r\n- New\r\n\r\n**Full changelog:** https://github.com/hopp1395/cc-outline/compare/v0.6.0...v0.7.0\r\n";
    expect(parseReleases([{ tag_name: "v0.7.0", body }])?.[0].body).toBe("### Chat\n\n- New");
  });

  it("is undefined for an answer that is no list (an error message)", () => {
    expect(parseReleases({ message: "API rate limit exceeded" })).toBeUndefined();
  });
});

describe("fetchReleases", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes the version from npm and the notes from GitHub", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      Response.json(url.includes("npmjs") ? { version: "0.8.0" } : [{ tag_name: "v0.8.0", body: "new" }]),
    );
    const fetched = await fetchReleases();
    expect(fetched.latest).toBe("0.8.0");
    expect(fetched.releases?.[0].body).toBe("new");
  });

  it("leaves out the part whose source fails", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("npmjs") ? Response.json({ version: "0.8.0" }) : new Response("rate limited", { status: 403 }),
    );
    expect(await fetchReleases()).toEqual({ latest: "0.8.0", releases: undefined });
  });
});

describe("the cache", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-update-"));
  });
  afterEach(() => {
    process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it("keeps what a failed source had before", () => {
    const cached = { latest: "0.7.0", releases: [{ tag: "v0.7.0", version: "0.7.0", title: "v0.7.0", body: "old" }], checkedAt: 1 };
    const merged = mergeReleases(cached, { latest: "0.8.0" }, 5);
    expect(merged).toEqual({ ...cached, latest: "0.8.0", checkedAt: 5 });
    // Nothing reached: the cache as it was, with its time.
    expect(mergeReleases(cached, {}, 9)).toBe(cached);
    expect(mergeReleases(undefined, {})).toBeUndefined();
  });

  it("is written and read back", () => {
    expect(readCachedReleases()).toBeUndefined();
    saveReleases({ latest: "0.8.0", releases: [], checkedAt: 3 });
    expect(readCachedReleases()).toEqual({ latest: "0.8.0", releases: [], checkedAt: 3 });
  });
});

describe("the version seen", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-seen-"));
  });
  afterEach(() => {
    process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it("returns the version run before once a newer one runs, and keeps the newest", () => {
    expect(takeSeenVersion("0.8.0")).toBeUndefined();
    expect(takeSeenVersion("0.8.0")).toBeUndefined();
    expect(takeSeenVersion("0.9.1")).toBe("0.8.0");
    expect(takeSeenVersion("0.9.1")).toBeUndefined();
    // An older viewer still running neither shows notes nor lowers it.
    expect(takeSeenVersion("0.8.0")).toBeUndefined();
    expect(takeSeenVersion("0.10.0")).toBe("0.9.1");
  });

  it("picks the releases after one version up to another, skipped ones included", () => {
    const release = (version: string) => ({ tag: `v${version}`, version, title: `v${version}`, body: "" });
    const releases = ["0.11.0", "0.10.0", "0.9.2", "0.9.1", "0.8.0"].map(release);
    expect(releasesBetween(releases, "0.8.0", "0.10.0").map((r) => r.version)).toEqual(["0.10.0", "0.9.2", "0.9.1"]);
  });
});

describe("installKind", () => {
  it("tells an npm install from a checkout or an npx cache", () => {
    expect(installKind("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\cc-outline")).toBe("npm");
    expect(installKind("/usr/lib/node_modules/cc-outline")).toBe("npm");
    expect(installKind("C:\\Workspace\\cc-outline")).toBe("dev");
    expect(installKind("/home/me/.npm/_npx/1234/node_modules/cc-outline")).toBe("dev");
  });
});

describe("updateState", () => {
  it("offers an update, a restart or neither", () => {
    expect(updateState("0.8.0", "0.7.0", "npm", "0.7.0")).toEqual({ kind: "update", target: "0.8.0" });
    expect(updateState("0.7.0", "0.7.0", "npm", "0.7.0")).toEqual({ kind: "none" });
    expect(updateState(undefined, "0.7.0", "npm", "0.7.0")).toEqual({ kind: "none" });
    // Another viewer installed it already: only a restart is needed.
    expect(updateState("0.8.0", "0.7.0", "npm", "0.8.0")).toEqual({ kind: "restart", target: "0.8.0" });
  });

  it("only points to the new version from a checkout", () => {
    expect(updateState("0.8.0", "0.7.0", "dev", "0.9.0")).toEqual({ kind: "dev", target: "0.8.0" });
    expect(updateState("0.7.0", "0.7.0", "dev", "0.9.0")).toEqual({ kind: "none" });
  });
});

describe("runUpdate", () => {
  it("runs the steps in order and reports their output", async () => {
    const ran: string[] = [];
    const reports: string[][] = [];
    const ok = await runUpdate(
      (steps) => reports.push(steps.map((s) => s.status)),
      async (command, onOutput) => {
        ran.push(command);
        onOutput("ok\n");
        return 0;
      },
    );
    expect(ok).toBe(true);
    expect(ran).toEqual(UPDATE_STEPS.map((s) => s.command));
    expect(reports.at(-1)).toEqual(["done", "done", "done"]);
  });

  it("stops at the first failing step and leaves the rest to run by hand", async () => {
    let last: Parameters<Parameters<typeof runUpdate>[0]>[0] = [];
    const ok = await runUpdate(
      (steps) => (last = steps),
      async (command, onOutput) => {
        if (command.startsWith("claude")) {
          onOutput("'claude' is not recognized\n");
          return 1;
        }
        return 0;
      },
    );
    expect(ok).toBe(false);
    expect(last.map((s) => s.status)).toEqual(["done", "failed", "pending"]);
    expect(last[1].output).toContain("not recognized");
    expect(remainingCommands(last)).toEqual(UPDATE_STEPS.slice(1).map((s) => s.command));
  });

  it("counts a command that cannot start as failed", async () => {
    const ok = await runUpdate(
      () => {},
      async () => {
        throw new Error("spawn ENOENT");
      },
    );
    expect(ok).toBe(false);
  });
});
