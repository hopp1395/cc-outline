import { Text } from "ink";
import type { UsageLevel, UsagePart } from "../remote/usage.js";

/** A window's percentage: no colour below 75 %, yellow from 75 %, red from 90 % (as the status line). */
export const LEVEL_COLOR: Record<UsageLevel, string | undefined> = { low: undefined, mid: "yellow", high: "red" };

/**
 * The parts of the usage line, `5h 42% ↻ 2h13m · 7d 18% ↻ 3d4h`: labels and times left dim, percentages coloured by
 * their level; all dim while they are `stale`. Its width is `usageWidth(parts)`.
 */
export function UsageText({ parts, stale = false, dimLabels = true }: { parts: UsagePart[]; stale?: boolean; dimLabels?: boolean }) {
  return (
    <Text dimColor={stale}>
      {parts.map((p, i) => (
        <Text key={p.label}>
          {i > 0 && <Text dimColor>{" · "}</Text>}
          <Text dimColor={dimLabels}>{p.label} </Text>
          <Text color={stale ? undefined : p.level && LEVEL_COLOR[p.level]}>{p.value}</Text>
          {p.rest && <Text dimColor> {p.rest}</Text>}
        </Text>
      ))}
    </Text>
  );
}
