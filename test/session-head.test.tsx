import { tmpdir } from "node:os";
import { L } from "../src/i18n/index.js";
import { join } from "node:path";
import { Box } from "ink";
import { describe, expect, it } from "vitest";
import { renderInk } from "./helpers/ink.js";
import type { Account } from "../src/account.js";
import type { SessionSummary } from "../src/transcript/sessions.js";
import { ChoiceDialog } from "../src/tui/ChoiceDialog.js";
import type { Layout } from "../src/tui/layout.js";
import { countHead, sessionHead } from "../src/tui/sessionHead.js";

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const me: Account = { dir: join(tmpdir(), ".claude"), file: "", email: "me@home.de" };
const work: Account = { dir: join(tmpdir(), ".claude-work"), file: "", email: "jan@work.com" };
const session: SessionSummary = {
  id: "s1",
  path: "",
  title: "Orders work",
  prompts: [{ text: "hi" }, { text: "more" }],
  plans: [],
  files: ["a.ts"],
  start: new Date(2026, 9, 12, 9, 14).toISOString(),
  end: new Date(2026, 9, 12, 11, 2).toISOString(),
};

describe("the head of a session's dialogs", () => {
  it("names title, span, account, folder and where it stands", () => {
    const ctx = { accounts: { accounts: [me, work], own: me.dir }, accountColor: "auto" as const };
    expect(sessionHead(session, ctx, { dir: "/projects/orders", gone: false, state: "inactive" }).map(strip)).toEqual([
      "Orders work",
      "2026-10-12 09:14–11:02 · 2 prompts · 1 file",
      "▌ me@home.de · this account",
      "in /projects/orders",
      "runs nowhere",
    ]);
    const other = sessionHead({ ...session, account: work.dir }, ctx, { dir: "/gone", gone: true, state: { trash: "10-12 11:30" } }).map(strip);
    expect(other.slice(2)).toEqual(["▌ jan@work.com", "folder gone: /gone", "in the trash since 10-12 11:30"]);
  });

  it("leaves the account out with a single account, and counts several sessions in one line", () => {
    const ctx = { accounts: { accounts: [me], own: me.dir }, accountColor: "auto" as const };
    expect(sessionHead(session, ctx, { dir: "/x", gone: false, state: "current" })).toHaveLength(4);
    expect(countHead(L().counts.markedSessions(3), "of this project")).toBe("3 marked sessions · of this project");
  });

  it("keeps only the selected option's detail where the dialog would not fit", async () => {
    const layout: Layout = { columns: 80, rows: 14, listWidth: 30, previewWidth: 47, bodyHeight: 10 };
    const options = ["a", "b", "c", "d"].map((id) => ({ id, label: `Option ${id}`, detail: `detail ${id}` }));
    const view = renderInk(
      <Box width={80} height={14}>
        <ChoiceDialog layout={layout} choice={{ title: "Pick", lines: ["one"], options, initial: 1, onChoose: () => {} }} onClose={() => {}} />
      </Box>,
      layout,
    );
    await expect.poll(view.frame).toContain("detail b");
    expect(view.frame()).not.toContain("detail a");
    expect(view.frame()).toContain("Option d");
    view.unmount();
  });
});
