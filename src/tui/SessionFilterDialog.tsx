import { Text, useInput } from "ink";
import { basename } from "node:path";
import { useState, type ReactNode } from "react";
import stringWidth from "string-width";
import type { Account } from "../account.js";
import { otherAccounts } from "../accountContinue.js";
import { SESSIONS_BACKGROUND_VALUES, type SessionsBackground, type SessionsFolders } from "../settings.js";
import { accountChosen, type SessionFilter } from "../sessionFilter.js";
import { Dialog, type Layout } from "./layout.js";
import { legendMark, SESSION_LEGEND } from "./sessionLegend.js";

const MAX_WIDTH = 60;

/** An account the dialog offers: its config folder and how it is named. */
export interface FilterAccount {
  dir: string;
  label: string;
}

/** The accounts the dialog offers, of those found: this viewer's (`own`, its config folder) first, then the others. */
export function filterAccounts(accounts: Account[], own: string): FilterAccount[] {
  const others = otherAccounts(accounts, own);
  const mine = accounts.find((a) => !others.includes(a));
  return [
    { dir: own, label: `${mine?.email ?? "this account"} (${basename(own)}) · this account` },
    ...others.map((a) => ({ dir: a.dir, label: `${a.email} (${basename(a.dir)})` })),
  ];
}

/** The marks of the list in short, as many to a line as fit in `width` columns. */
export function legendLines(width: number): string[] {
  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const m of SESSION_LEGEND) {
    const size = stringWidth(`${m.mark} ${m.short}`);
    if (used > 0 && used + 2 + size > width) {
      lines.push(line);
      line = "";
      used = 0;
    }
    line += `${used > 0 ? "  " : ""}${legendMark(m)} ${m.short}`;
    used += (used > 0 ? 2 : 0) + size;
  }
  if (line) lines.push(line);
  return lines;
}

type Row ={ kind: "folder"; which: "this" | "other" } | { kind: "account"; dir: string } | { kind: "background" };

const BACKGROUND_NAMES: Record<SessionsBackground, string> = { show: "show", only: "only", hide: "hide" };

/** The folders value with `which` switched on or off. */
function toggleFolder(folders: SessionsFolders, which: "this" | "other"): SessionsFolders | undefined {
  const on = { this: folders !== "other", other: folders !== "this" };
  on[which] = !on[which];
  if (!on.this && !on.other) return undefined;
  return on.this && on.other ? "all" : on.this ? "this" : "other";
}

/**
 * What the Sessions view lists, as check boxes: the project folders (this one, the others), the accounts found
 * (`accounts`, the own one first; left out with one alone or in the trash) and the background sessions (show,
 * only, hide). ↑↓ pick a row, Space switches it (←→ step the background), Enter applies, Esc cancels. The last
 * box of a group stays checked, so the list is never empty by choice.
 */
export function SessionFilterDialog({
  layout,
  initial,
  folderName,
  accounts,
  onApply,
  onClose,
}: {
  layout: Layout;
  initial: SessionFilter;
  /** The project folder's name, for "this folder". */
  folderName: string;
  /** The accounts to choose from; fewer than two leave the group out. */
  accounts: FilterAccount[];
  onApply: (filter: SessionFilter) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState(initial);
  const [at, setAt] = useState(0);
  const [notice, setNotice] = useState<string>();
  const withAccounts = accounts.length >= 2;
  const rows: Row[] = [
    { kind: "folder", which: "this" },
    { kind: "folder", which: "other" },
    ...(withAccounts ? accounts.map((a): Row => ({ kind: "account", dir: a.dir })) : []),
    { kind: "background" },
  ];

  const toggle = (row: Row, step: 1 | -1) => {
    if (row.kind === "background") {
      const i = SESSIONS_BACKGROUND_VALUES.indexOf(filter.background);
      const n = SESSIONS_BACKGROUND_VALUES.length;
      return setFilter({ ...filter, background: SESSIONS_BACKGROUND_VALUES[(i + step + n) % n]! });
    }
    if (row.kind === "folder") {
      const folders = toggleFolder(filter.folders, row.which);
      return folders ? setFilter({ ...filter, folders }) : setNotice("one folder stays checked");
    }
    const chosen = accountChosen(filter, row.dir);
    if (chosen && filter.accounts.length === 1) return setNotice("one account stays checked");
    // In the order offered, the own account first.
    const next = accounts.map((a) => a.dir).filter((dir) => (dir === row.dir ? !chosen : accountChosen(filter, dir)));
    setFilter({ ...filter, accounts: next });
  };

  useInput((input, key) => {
    setNotice(undefined);
    if (key.escape) return onClose();
    if (key.return) return onApply(filter);
    if (key.upArrow || key.downArrow) return setAt((r) => (r + (key.upArrow ? -1 : 1) + rows.length) % rows.length);
    const row = rows[at]!;
    if (input === " ") return toggle(row, 1);
    if (row.kind === "background" && (key.leftArrow || key.rightArrow)) return toggle(row, key.leftArrow ? -1 : 1);
  });

  const box = (on: boolean) => (on ? "[x]" : "[ ]");
  const line = (index: number, mark: string, label: ReactNode) => {
    const selected = index === at;
    return (
      <Text key={index} wrap="truncate">
        <Text color="cyan">{selected ? "›" : " "}</Text> {mark && <Text color={selected ? "cyan" : undefined}>{`${mark} `}</Text>}
        <Text bold={selected}>{label}</Text>
      </Text>
    );
  };
  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  const legend = legendLines(width - 4);
  // Title, blank, three headings, the rows, blank, the legend's heading and lines, blank, notice, keys, plus the border.
  const height = 2 + (withAccounts ? 3 : 2) + rows.length + 2 + legend.length + 3 + 2;
  const accountsAt = 2;
  const backgroundAt = rows.length - 1;
  return (
    <Dialog layout={layout} width={width} height={height}>
      <Text bold color="cyan" wrap="truncate">
        Show sessions
      </Text>
      <Text> </Text>
      <Text dimColor>Folders</Text>
      {line(0, box(filter.folders !== "other"), `this folder (${folderName})`)}
      {line(1, box(filter.folders !== "this"), "other folders")}
      {withAccounts && <Text dimColor>Accounts</Text>}
      {withAccounts && accounts.map((a, i) => line(accountsAt + i, box(accountChosen(filter, a.dir)), a.label))}
      <Text dimColor>Background (claude -p, SDK, daemon)</Text>
      {line(
        backgroundAt,
        "",
        <>
          {SESSIONS_BACKGROUND_VALUES.map((v) => (
            <Text key={v} color={v === filter.background ? "green" : undefined} dimColor={v !== filter.background}>
              {`${v === filter.background ? "(•)" : "( )"} ${BACKGROUND_NAMES[v]}  `}
            </Text>
          ))}
        </>,
      )}
      <Text> </Text>
      <Text dimColor>Marks in the list</Text>
      {legend.map((l, i) => (
        <Text key={`legend-${i}`} wrap="truncate">
          {l}
        </Text>
      ))}
      <Text> </Text>
      <Text color="yellow" wrap="truncate">
        {notice ?? " "}
      </Text>
      <Text wrap="truncate">
        <Text color="yellow">↑↓</Text> row{"  "}
        <Text color="yellow">Space</Text> switch{"  "}
        <Text color="yellow">Enter</Text> apply{"  "}
        <Text color="yellow">Esc</Text> cancel
      </Text>
    </Dialog>
  );
}
