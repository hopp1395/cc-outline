import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "ink";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Account } from "../src/account.js";
import { quotaSource } from "../src/remote/quota.js";
import { updateSettings } from "../src/settings.js";
import { useQuota } from "../src/tui/useQuota.js";
import { renderInk, until } from "./helpers/ink.js";

const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "oauth-usage.json"), "utf8")) as Record<string, unknown>;
const layout = { columns: 60, rows: 5, listWidth: 0, previewWidth: 60, bodyHeight: 5 };

function Shown({ account }: { account?: Account }) {
  const quota = useQuota(account);
  return <Text>{`${quota.reason ?? "read"} ${quota.limits?.fiveHour ? Math.round(quota.limits.fiveHour.utilization * 100) : "-"}`}</Text>;
}

describe("the windows a viewer reads", () => {
  const realGet = quotaSource.get;
  let saved: string | undefined;
  let dir: string;
  let calls: number;
  beforeEach(() => {
    saved = process.env.CLAUDE_CONFIG_DIR;
    dir = process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cco-use-quota-"));
    calls = 0;
    quotaSource.get = async () => {
      calls++;
      return recorded;
    };
  });
  afterEach(() => {
    process.env.CLAUDE_CONFIG_DIR = saved;
    quotaSource.get = realGet;
  });
  afterAll(() => {
    quotaSource.get = realGet;
  });

  const account = (): Account => ({ dir, file: join(dir, ".claude.json"), email: "me@example.com" });

  it("are none while the remote API is off, for an API profile and without an account", async () => {
    const off = renderInk(<Shown account={account()} />, layout);
    await until(() => off.frame().includes("off -"));
    off.unmount();
    updateSettings({ remoteApi: true });
    const api = renderInk(<Shown account={{ ...account(), api: { baseUrl: "http://localhost:1234" } }} />, layout);
    await until(() => api.frame().includes("api -"));
    api.unmount();
    const none = renderInk(<Shown />, layout);
    await until(() => none.frame().includes("none -"));
    none.unmount();
    expect(calls).toBe(0);
  });

  it("are read once for all views of the process with the remote API on", async () => {
    updateSettings({ remoteApi: true });
    const view = renderInk(
      <>
        <Shown account={account()} />
        <Shown account={account()} />
      </>,
      layout,
    );
    await until(() => view.frame().split("\n").filter((l) => l.includes("read 62")).length === 2);
    expect(calls).toBe(1);
    view.unmount();
  });
});
