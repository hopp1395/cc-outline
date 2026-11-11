import { Text } from "ink";
import { ACCOUNT_COLORS, type AccountColorName } from "../account.js";
import { badgeText, PIN, type UsageBadge, type UsageLevel, type UsagePart } from "../remote/usage.js";

/** A window's percentage: no colour below 75 %, yellow from 75 %, red from 90 % (as the status line). */
export const LEVEL_COLOR: Record<UsageLevel, string | undefined> = { low: undefined, mid: "yellow", high: "red" };

/** An account's badge: 📌 where it was chosen by hand, its avatar on its colour as the top bar's "cco", and its note dim. Its width is `badgeWidth(badge)`. */
export function UsageBadgeText({ badge }: { badge: UsageBadge }) {
  const color = badge.color as AccountColorName | undefined;
  return (
    <Text>
      {badge.pinned && PIN}
      <Text bold color={color ? ACCOUNT_COLORS[color] : undefined} backgroundColor={color}>
        {badgeText(badge)}
      </Text>
      {badge.note && <Text dimColor>{` ${badge.note}`}</Text>}
    </Text>
  );
}

/**
 * The parts of the usage line, `5h 42% ↻ 2h13m · 7d 18% ↻ 3d4h`: labels and times left dim, percentages coloured by
 * their level; all dim while they are `stale`. With a `badge` it stands before the windows, after `Ctx` (`Ctx 62k · 🦊 5h 42%`).
 * Its width is `usageWidth(parts, badgeWidth(badge))`.
 */
export function UsageText({ parts, stale = false, dimLabels = true, badge }: { parts: UsagePart[]; stale?: boolean; dimLabels?: boolean; badge?: UsageBadge }) {
  // The badge goes before the first window, else at the end.
  const at = badge ? (parts.findIndex((p) => p.label !== "Ctx") + 1 || parts.length + 1) - 1 : -1;
  const badgeNode = badge && (
    <Text key="badge">
      {at > 0 && <Text dimColor>{" · "}</Text>}
      <UsageBadgeText badge={badge} />
      {at < parts.length && " "}
    </Text>
  );
  return (
    <Text>
      {parts.map((p, i) => (
        <Text key={p.label}>
          {i === at && badgeNode}
          {i > 0 && i !== at && <Text dimColor>{" · "}</Text>}
          <Text dimColor={stale}>
            <Text dimColor={dimLabels}>{p.label} </Text>
            <Text color={stale ? undefined : p.level && LEVEL_COLOR[p.level]}>{p.value}</Text>
            {p.rest && <Text dimColor> {p.rest}</Text>}
          </Text>
        </Text>
      ))}
      {at === parts.length && badgeNode}
    </Text>
  );
}
