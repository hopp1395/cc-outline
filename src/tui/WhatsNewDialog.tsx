import { Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { renderMarkdown } from "../render/markdown.js";
import type { Release } from "../update.js";
import { VERSION } from "../version.js";
import { Dialog, dim, rule, type Layout } from "./layout.js";

const MAX_WIDTH = 100;

/** The notes of the given releases (newest first), each under a rule with its version and date. */
export function whatsNewLines(releases: Release[], width: number): string[] {
  const lines: string[] = [];
  for (const r of releases) {
    const label = r.date ? `v${r.version} · ${r.date.slice(0, 10)}` : `v${r.version}`;
    if (lines.length > 0) lines.push("");
    lines.push(rule(width, label), "");
    lines.push(...(r.body.trim() ? renderMarkdown(r.body, width) : [dim("No notes for this release.")]));
  }
  return lines;
}

/**
 * After an update: the notes of every version since the one run before, the
 * skipped ones too. Scrolls with ↑↓, PgUp/PgDn, Home/End; Enter or Esc closes
 * it. Takes all keys while open.
 */
export function WhatsNewDialog({ layout, releases, from, onClose }: { layout: Layout; releases: Release[]; from?: string; onClose: () => void }) {
  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  const height = Math.max(8, layout.rows - 4);
  // Border and padding take four columns; title, blank, blank and keys, plus the border, six rows.
  const inner = Math.max(10, width - 4);
  const visible = height - 6;
  const lines = useMemo(() => whatsNewLines(releases, inner), [releases, inner]);
  const maxScroll = Math.max(0, lines.length - visible);
  const [scroll, setScroll] = useState(0);
  const to = (n: number) => setScroll(Math.max(0, Math.min(maxScroll, n)));

  useInput((input, key) => {
    if (key.return || key.escape || input === "q") onClose();
    else if (key.upArrow) to(scroll - 1);
    else if (key.downArrow) to(scroll + 1);
    else if (key.pageUp) to(scroll - (visible - 1));
    else if (key.pageDown || input === " ") to(scroll + (visible - 1));
    else if (key.home) to(0);
    else if (key.end) to(maxScroll);
  });

  const shown = lines.slice(scroll, scroll + visible);
  const count = releases.length === 1 ? "1 release" : `${releases.length} releases`;
  const position = maxScroll > 0 ? ` · ${Math.round((scroll / maxScroll) * 100)}%` : "";
  return (
    <Dialog layout={layout} width={width} height={height} borderColor="green">
      <Text bold color="green" wrap="truncate">
        {`cco updated to v${VERSION}`}
        {from && <Text color="gray">{` from v${from} · ${count}`}</Text>}
      </Text>
      <Text> </Text>
      {shown.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line || " "}
        </Text>
      ))}
      {Array.from({ length: visible - shown.length }, (_, i) => (
        <Text key={`pad${i}`}> </Text>
      ))}
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="green">Enter</Text> close
        {maxScroll > 0 && (
          <>
            {"   "}
            <Text color="yellow">↑↓ PgUp/PgDn</Text> scroll{position}
          </>
        )}
        {"   "}
        <Text color="gray">Claude Code needs a restart for the plugin</Text>
      </Text>
    </Dialog>
  );
}
