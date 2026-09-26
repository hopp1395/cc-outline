import clipboard from "clipboardy";
import { Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { diffLines } from "../git/linediff.js";
import { renderDiff } from "../render/diff.js";
import { renderMarkdown } from "../render/markdown.js";
import type { Plan, PlanStatus } from "../transcript/parse.js";
import { nextMarked } from "../favorites.js";
import { useFocused } from "./focus.js";
import { useFavorites } from "./useFavorites.js";
import {
  bold,
  handleNavigation,
  List,
  markFooter,
  markKeys,
  previewHeader,
  rule,
  Screen,
  Star,
  truncate,
  useScroll,
  type Layout,
} from "./layout.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";

interface Props {
  cwd: string;
  plans: Plan[];
  /** A session is shown (otherwise there is nothing to take plans from). */
  hasSession: boolean;
  layout: Layout;
  active: boolean;
  /** Reports whether the changes view is open, so Esc closes it instead of quitting. */
  onDiffOpen?: (open: boolean) => void;
}

const STATUS: Record<PlanStatus, { icon: string; color: string; label: string; ansi: string }> = {
  approved: { icon: "✓", color: "green", label: "approved", ansi: "32" },
  rejected: { icon: "✗", color: "red", label: "rejected", ansi: "31" },
  pending: { icon: "●", color: "yellow", label: "waiting for approval", ansi: "33" },
};

/** The plan's first heading, or its first line. */
export function planTitle(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  const heading = lines.find((l) => /^#{1,6}\s+\S/.test(l));
  return (heading ?? lines.find((l) => l) ?? "Plan").replace(/^#{1,6}\s+/, "");
}

function time(ts?: string): string {
  if (!ts) return "     ";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const dim = (s: string) => `\u001b[2m${s}\u001b[22m`;

/** Title, status and origin of a plan above its text; the rule names what Enter switches to. */
function planHeader(plan: Plan, version: number, width: number, showDiff: boolean, hasPrevious: boolean): string[] {
  const status = STATUS[plan.status];
  const details = [`v${version} · ${status.label} · ${time(plan.timestamp).trim()}${showDiff ? ` · changes to v${version - 1}` : ""}`];
  if (plan.prompt) details.push(`for: ${truncate(plan.prompt, width - 8)}`);
  if (plan.feedback) details.push(`feedback: ${truncate(plan.feedback, width - 13)}`);
  const header = previewHeader(planTitle(plan.text), width, {
    marker: `\u001b[${status.ansi}m${status.icon}\u001b[39m `,
    style: bold,
    details,
  });
  const label = showDiff ? "↵ plan" : hasPrevious ? `↵ changes to v${version - 1}` : undefined;
  return [...header.slice(0, -1), rule(width, label)];
}

export function PlanView({ cwd, plans, hasSession, layout, active, onDiffOpen }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const last = plans.length - 1;
  const [selected, setSelected] = useState(last);
  // Following: the newest plan stays selected when Claude presents another one.
  const [follow, setFollow] = useState(true);
  const [showDiff, setShowDiff] = useState(false);
  const [flash, setFlash] = useState<string>();
  // Marked plans of the project, by tool call id.
  const favorites = useFavorites(cwd, "plans");
  const markedCount = plans.filter((p) => favorites.isMarked(p.id)).length;

  useEffect(() => {
    if (follow) setSelected(last);
  }, [follow, last]);

  const index = Math.max(0, Math.min(selected, last));
  const plan = plans[index];
  const previous = index > 0 ? plans[index - 1] : undefined;
  const diffOpen = showDiff && previous !== undefined;

  const header = useMemo(() => {
    if (!plan) return [];
    const full = planHeader(plan, index + 1, previewWidth, diffOpen, previous !== undefined);
    const fitted = fitHeader(full, bodyHeight);
    // Keep the labelled rule even when the header had to be shortened.
    return fitted.length < full.length ? [...fitted.slice(0, -1), full.at(-1)!] : fitted;
  }, [plan, index, previewWidth, bodyHeight, diffOpen, previous]);
  const lines = useMemo(() => {
    if (!plan) return [];
    if (diffOpen) {
      const diff = diffLines(previous!.text, plan.text);
      return diff.hunks.length ? renderDiff(diff, "plan.md", previewWidth).lines : [dim("Same text as the previous version.")];
    }
    return renderMarkdown(plan.text, previewWidth);
  }, [plan, previous, diffOpen, previewWidth]);
  const viewport = bodyHeightBelow(header, bodyHeight);
  const scroll = useScroll(lines.length, viewport);

  const toggleDiff = (open: boolean) => {
    setShowDiff(open);
    onDiffOpen?.(open);
    scroll.set(0);
  };
  const select = (next: number) => {
    const target = Math.max(0, Math.min(last, next));
    setFollow(target === last);
    if (target === index) return;
    setSelected(target);
    scroll.set(0);
  };
  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(undefined), 2000);
  };

  useInput(
    (input, key) => {
      // Checked first: Space marks instead of paging, Shift+←/→ jump between marked plans.
      const mark = markKeys(input, key);
      if (mark === "toggle") return plan && favorites.toggle(plan.id);
      if (mark) {
        const target = nextMarked(
          plans.map((p) => p.id),
          favorites.marks,
          index,
          mark,
        );
        return target !== undefined && select(target);
      }
      const nav = {
        select: (delta: number) => select(index + delta),
        first: () => select(0),
        last: () => select(last),
        scroll,
        page: viewport - 2,
      };
      if (handleNavigation(input, key, nav)) return;
      if (key.return && previous) return toggleDiff(!showDiff);
      if (key.escape && diffOpen) return toggleDiff(false);
      if (input === "c" && plan) {
        clipboard.write(plan.text).then(
          () => notify("copied the plan to the clipboard"),
          (err: Error) => notify(`copy failed: ${err.message}`),
        );
      }
    },
    { isActive: active },
  );

  let preview;
  if (!hasSession) preview = <Text dimColor>No Claude Code session found</Text>;
  else if (!plan)
    preview = (
      <Text dimColor>
        No plan in this session yet. In Claude Code, Shift+Tab switches to plan mode; the plans Claude presents show up here.
      </Text>
    );
  else
    preview = (
      <Preview header={header} lines={lines} scroll={scroll.scroll} width={previewWidth} height={bodyHeight} />
    );

  const counts = plans.reduce<Record<PlanStatus, number>>(
    (acc, p) => ({ ...acc, [p.status]: acc[p.status] + 1 }),
    { approved: 0, rejected: 0, pending: 0 },
  );

  return (
    <Screen
      layout={layout}
      mode="plan"
      status={
        <Text dimColor={!focused}>
          {plans.length} {plans.length === 1 ? "plan" : "plans"}
          {counts.approved > 0 && <Text color="green">{` · ${counts.approved} approved`}</Text>}
          {counts.rejected > 0 && <Text color="red">{` · ${counts.rejected} rejected`}</Text>}
          {counts.pending > 0 && <Text color="yellow">{` · ${counts.pending} waiting`}</Text>}
          {plan && ` · ${scroll.position}`}
          {markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
          {follow && plans.length > 0 && <Text color="green"> · FOLLOW</Text>}
        </Text>
      }
      list={
        <List
          items={plans}
          selected={index}
          height={bodyHeight}
          empty="No plans yet"
          itemKey={(p) => p.id}
          render={(p, isSelected) => {
            const status = STATUS[p.status];
            const marked = favorites.isMarked(p.id);
            return (
              <>
                {marked && <Star />}
                <Text dimColor={!isSelected}>{time(p.timestamp)} </Text>
                <Text color={status.color}>{status.icon} </Text>
                {truncate(planTitle(p.text), Math.max(4, listWidth - 8 - (marked ? 2 : 0)))}
              </>
            );
          }}
        />
      }
      preview={preview}
      footer={
        flash ?? [
          { text: "←→ plan", priority: 4 },
          { text: "↑↓ scroll", priority: 1 },
          ...(previous ? [{ text: "↵ changes", on: diffOpen }] : []),
          ...markFooter(favorites.isMarked(plan?.id), markedCount),
          { text: "c copy", priority: 2 },
          { text: "1/2/3 view", priority: 1 },
        ]
      }
    />
  );
}
