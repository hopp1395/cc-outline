import { Box, Text, useInput } from "ink";
import { useState } from "react";
import stringWidth from "string-width";
import type { Account } from "../account.js";
import { quotaNote } from "../remote/quota.js";
import { badgeWidth, usageParts } from "../remote/usage.js";
import { usageBadge, type BadgeLooks } from "../rcViewer/usageAccount.js";
import { truncate, type Layout } from "./layout.js";
import { useMouse } from "./mouse.js";
import { useQuota } from "./useQuota.js";
import { UsageBadgeText, UsageText } from "./UsageText.js";

/** The first row: the windows follow the selected session's account. */
export const AUTOMATIC = "Automatic (follows the session)";
const TITLE = "Usage of";
const KEYS = "↑↓ choose · ↵ take · Esc close";
/** The columns an account's windows take: `5h 100% · 7d 100%`. */
const WINDOWS_WIDTH = 17;
const EMAIL_MAX = 32;

/** An account's windows, without the times left: `5h 23% · 7d 41%`; `API` for an API profile, why they could not be read. */
function AccountWindows({ account }: { account: Account }) {
  const quota = useQuota(account);
  if (account.api) return <Text dimColor>API</Text>;
  const parts = usageParts({ limits: quota.limits }, Date.now()).map(({ rest: _, ...p }) => p);
  if (parts.length > 0) return <UsageText parts={parts} stale={quota.stale} />;
  return <Text dimColor>{quota.errorKind ? quotaNote(quota.errorKind) : "…"}</Text>;
}

/**
 * The list the usage line's badge opens (a click on it, `u`), just above it at its right end: "Automatic" (the
 * selected session's account, its badge after it), then every account found with its badge, email and windows, read
 * while the list is open. An API profile has none and cannot be chosen. `↑↓` choose, `Enter` or a click takes it,
 * `Esc` or a click beside it closes.
 */
export function UsageAccountMenu({
  layout,
  bottom,
  right,
  accounts,
  looks,
  auto,
  pinned,
  onChoose,
  onClose,
}: {
  layout: Layout;
  /** The screen row it stands above (the frame's bottom line). */
  bottom: number;
  /** The column its right edge stands before (the usage's end). */
  right: number;
  accounts: Account[];
  looks: BadgeLooks;
  /** The selected session's account, which "Automatic" shows. */
  auto: Account | undefined;
  /** The config folder chosen by hand; none follows the session. */
  pinned: string | undefined;
  /** The config folder chosen, none for "Automatic". */
  onChoose: (dir: string | undefined) => void;
  onClose: () => void;
}) {
  const rows: (Account | undefined)[] = [undefined, ...accounts];
  const disabled = (i: number) => rows[i]?.api !== undefined;
  const [selected, setSelected] = useState(() => Math.max(0, pinned === undefined ? 0 : rows.findIndex((a) => a?.dir === pinned)));
  const take = (i: number) => {
    if (i < 0 || i >= rows.length || disabled(i)) return;
    onChoose(rows[i]?.dir);
  };
  useInput((_input, key) => {
    if (key.escape) return onClose();
    if (key.return) return take(selected);
    const step = key.upArrow ? -1 : key.downArrow ? 1 : 0;
    if (!step) return;
    for (let i = selected + step; i >= 0 && i < rows.length; i += step) {
      if (!disabled(i)) return setSelected(i);
    }
  });

  const badgeOf = (a: Account) => usageBadge(a, looks, {});
  const badgeColumns = Math.max(0, ...accounts.map((a) => badgeWidth(badgeOf(a))));
  const emailColumns = Math.min(EMAIL_MAX, Math.max(0, ...accounts.map((a) => stringWidth(a.email))));
  const autoWidth = stringWidth(AUTOMATIC) + (auto ? 1 + badgeWidth(badgeOf(auto)) : 0);
  const content = Math.max(stringWidth(TITLE), stringWidth(KEYS), 2 + autoWidth, 2 + badgeColumns + 1 + emailColumns + 2 + WINDOWS_WIDTH);
  // The border and a space of padding on each side.
  const width = Math.min(layout.columns, content + 4);
  const room = width - 4;
  const email = Math.max(4, Math.min(emailColumns, room - 2 - badgeColumns - 1 - 2 - WINDOWS_WIDTH));
  const height = rows.length + 4;
  const top = Math.max(0, bottom - height);
  const left = Math.max(0, Math.min(layout.columns - width, right - width));

  useMouse((e) => {
    if (e.kind !== "click") return;
    const row = e.y - top - 2;
    if (e.x < left || e.x >= left + width || e.y < top || e.y >= top + height) return onClose();
    if (row >= 0 && row < rows.length) take(row);
  });

  return (
    <Box position="absolute" top={top} left={left} width={width} height={height} flexDirection="column" borderStyle="round" borderColor="cyan" backgroundColor="#1b1f27" paddingX={1} overflow="hidden">
      <Text bold wrap="truncate">
        {TITLE}
      </Text>
      {rows.map((a, i) => {
        const mark = <Text color="cyan">{i === selected ? "› " : "  "}</Text>;
        if (!a) {
          return (
            <Text key="auto" wrap="truncate" bold={i === selected}>
              {mark}
              {truncate(AUTOMATIC, room - 2)}
              {auto && (
                <Text>
                  {" "}
                  <UsageBadgeText badge={badgeOf(auto)} />
                </Text>
              )}
            </Text>
          );
        }
        const badge = badgeOf(a);
        const name = truncate(a.email, email);
        return (
          <Text key={a.dir} wrap="truncate" dimColor={disabled(i)}>
            {mark}
            <UsageBadgeText badge={badge} />
            {" ".repeat(badgeColumns - badgeWidth(badge) + 1)}
            <Text bold={i === selected}>{name}</Text>
            {" ".repeat(Math.max(0, email - stringWidth(name)) + 2)}
            <AccountWindows account={a} />
          </Text>
        );
      })}
      <Text dimColor wrap="truncate">
        {KEYS}
      </Text>
    </Box>
  );
}
