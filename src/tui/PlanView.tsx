import { Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import { diffLines } from "../git/linediff.js";
import { renderDiff } from "../render/diff.js";
import { renderMarkdown } from "../render/markdown.js";
import { readFileSync, statSync } from "node:fs";
import type { Plan, PlanModeState, PlanStatus } from "../transcript/parse.js";
import { watchFile } from "../transcript/tail.js";
import { doubleClicks } from "./openKey.js";
import { useFocused } from "./focus.js";
import { useClipboard } from "./useClipboard.js";
import { haystack } from "../filter.js";
import { useFavorites } from "./useFavorites.js";
import { useReload } from "./reload.js";
import { useListFilter } from "./useListFilter.js";
import { usePositions } from "./usePositions.js";
import { useSetting } from "./useSetting.js";
import {
  bold,
  handleNavigation,
  List,
  markFooter,
  markKeys,
  previewHeader,
  rule,
  Screen,
  EntryText,
  flipOrder,
  orderFooter,
  Star,
  truncate,
  type Layout,
} from "./layout.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";

interface Props {
  cwd: string;
  /** Plans Claude presented (ExitPlanMode calls). */
  plans: Plan[];
  /** Plan mode while it is on; its plan file shows the plan being written. */
  planMode?: PlanModeState;
  /** A session is shown (otherwise there is nothing to take plans from). */
  hasSession: boolean;
  layout: Layout;
  active: boolean;
  /** Reports whether the changes view is open, so Esc closes it instead of quitting. */
  onDiffOpen?: (open: boolean) => void;
  /** The filter dialog opened or closed. */
  onTyping?: (typing: boolean) => void;
}

const STATUS: Record<PlanStatus, { icon: string; color: string; label: string; ansi: string }> = {
  draft: { icon: "✎", color: "cyan", label: "being written, not presented yet", ansi: "36" },
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

/** Columns moved per Ctrl+←/→ when lines are not wrapped. */
const HSCROLL_STEP = 8;

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

/** How often the plan file is checked besides the file watcher. */
const DRAFT_POLL_MS = 1000;

/**
 * The plan being written in plan mode, read from its plan file: Claude writes
 * the plan there before presenting it, while the transcript only gets the
 * ExitPlanMode call once the user decided. Undefined when there is none: plan
 * mode is off, the file is older than plan mode (a previous plan), or it holds
 * the plan that was presented last (e.g. rejected, not rewritten yet).
 */
export function draftPlan(
  planMode: PlanModeState | undefined,
  file: { text: string; mtime: number } | undefined,
  presented: Plan[],
): Plan | undefined {
  if (!planMode || !file?.text.trim()) return undefined;
  if (planMode.since && file.mtime < Date.parse(planMode.since)) return undefined;
  const last = presented.filter((p) => !planMode.since || (p.timestamp ?? "") >= planMode.since).at(-1);
  if (last && last.text.trim() === file.text.trim()) return undefined;
  return { id: "draft", text: file.text, timestamp: new Date(file.mtime).toISOString(), prompt: planMode.prompt, status: "draft" };
}

/** Text and modification time of the plan file while plan mode is on, kept current; read again on F5. */
function usePlanFile(planMode: PlanModeState | undefined) {
  const [file, setFile] = useState<{ text: string; mtime: number }>();
  const { count } = useReload();
  useEffect(() => {
    setFile(undefined);
    if (!planMode) return;
    const path = planMode.file;
    const read = () => {
      try {
        const { mtimeMs } = statSync(path);
        setFile((prev) => (prev?.mtime === mtimeMs ? prev : { text: readFileSync(path, "utf8"), mtime: mtimeMs }));
      } catch {
        setFile(undefined);
      }
    };
    read();
    const watcher = watchFile(path, read);
    const timer = setInterval(read, DRAFT_POLL_MS);
    return () => {
      clearInterval(timer);
      void watcher.close();
    };
  }, [planMode?.file, planMode?.since, count]);
  return file;
}

export function PlanView({ cwd, plans: presented, planMode, hasSession, layout, active, onDiffOpen, onTyping }: Props) {
  const planFile = usePlanFile(planMode);
  const copy = useClipboard();
  const draft = draftPlan(planMode, planFile, presented);
  // The plan being written comes last, after the ones already presented.
  const plans = useMemo(() => (draft ? [...presented, draft] : presented), [presented, draft?.text, draft?.timestamp]);
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const [isDoubleClick] = useState(() => doubleClicks());
  const newest = plans.length - 1;
  const [selected, setSelected] = useState(newest);
  // Following: the newest plan stays selected when Claude presents another one.
  const [follow, setFollow] = useState(true);
  const [showDiff, setShowDiff] = useState(false);
  const [flash, setFlash] = useState<string>();
  const [wrap, setWrap] = useSetting("planWrap");
  const [order, setOrder] = useSetting("planOrder");
  const reversed = order === "newest-first";
  const [hscroll, setHscroll] = useState(0);
  // Marked plans of the project, by tool call id.
  const favorites = useFavorites(cwd, "plans");
  const markedCount = plans.filter((p) => favorites.isMarked(p.id)).length;
  const index = Math.max(0, Math.min(selected, newest));
  // Selection and each plan's scroll position survive switching plans and restarting the viewer.
  const positions = usePositions(cwd, "plan");
  // A plan is found by its title; its details are its text, its status and the feedback it got.
  const filter = useListFilter({
    items: plans,
    text: (p) => ({ list: planTitle(p.text), details: haystack([p.text, p.status, STATUS[p.status].label, p.feedback]) }),
    selected: index,
    select: (i) => select(i),
    reversed,
    layout,
    onTyping,
    marked: (p) => favorites.isMarked(p.id),
    restoreCopy: positions.follow === false && positions.pinned ? (p) => p.id === positions.selected : undefined,
  });
  // The newest plan shown: following stays on it, also while a filter is on.
  const last = filter.last;

  useEffect(() => {
    if (follow && last >= 0) setSelected(last);
  }, [follow, last]);

  const restored = useRef(false);
  const justRestored = useRef(false);
  // Once the plans are there: back to the plan selected last time, unless the newest was being followed.
  useEffect(() => {
    if (restored.current || plans.length === 0) return;
    restored.current = true;
    const at = positions.follow === false ? plans.findIndex((p) => p.id === positions.selected) : -1;
    if (at < 0) return;
    justRestored.current = true;
    setFollow(false);
    setSelected(at);
  }, [plans.length]);

  const plan = filter.none ? undefined : plans[index];
  const previous = index > 0 ? plans[index - 1] : undefined;
  const diffOpen = showDiff && previous !== undefined;

  const header = useMemo(() => {
    if (!plan) return [];
    const full = planHeader(plan, index + 1, previewWidth, diffOpen, previous !== undefined);
    const fitted = fitHeader(full, bodyHeight);
    // Keep the labelled rule even when the header had to be shortened.
    return fitted.length < full.length ? [...fitted.slice(0, -1), full.at(-1)!] : fitted;
  }, [plan, index, previewWidth, bodyHeight, diffOpen, previous]);
  const rendered = useMemo(() => {
    const none = { lines: [] as string[], hunkStarts: [] as number[], gutterWidth: 0 };
    if (!plan) return none;
    if (diffOpen) {
      const diff = diffLines(previous!.text, plan.text);
      return diff.hunks.length
        ? renderDiff(diff, "plan.md", previewWidth, wrap)
        : { ...none, lines: [dim("Same text as the previous version.")] };
    }
    return { ...none, lines: renderMarkdown(plan.text, previewWidth, wrap) };
  }, [plan, previous, diffOpen, previewWidth, wrap]);
  const { lines } = rendered;
  const viewport = bodyHeightBelow(header, bodyHeight);
  // A plan and its changes to the previous version each keep their own position.
  const scroll = positions.scroll(plan && (diffOpen ? `${plan.id}#diff` : plan.id), lines.length, viewport);

  useEffect(() => {
    // The commit that restored the selection still shows the old one; the next saves the restored one.
    if (!restored.current || justRestored.current) {
      justRestored.current = false;
      return;
    }
    if (plan) positions.select(plan.id, follow, filter.copySelected);
  }, [plan?.id, follow, filter.copySelected]);

  // How far unwrapped lines can be shifted until the longest one ends at the right edge.
  const maxHscroll = useMemo(
    () => (wrap ? 0 : Math.max(0, ...lines.map((l) => stringWidth(l))) - previewWidth),
    [lines, wrap, previewWidth],
  );
  const shift = (delta: number) => setHscroll((h) => Math.max(0, Math.min(maxHscroll, h + delta)));

  const toggleDiff = (open: boolean) => {
    setShowDiff(open);
    onDiffOpen?.(open);
    setHscroll(0);
  };
  const select = (next: number) => {
    if (last < 0) return;
    const target = Math.max(0, Math.min(last, next));
    setFollow(target === last);
    if (target === index) return;
    setSelected(target);
    setHscroll(0);
  };
  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(undefined), 2000);
  };

  useInput(
    (input, key) => {
      if (filter.handleKey(input, key)) return;
      // Checked first: Shift+↑/↓ jump between marked plans.
      const mark = markKeys(input, key);
      if (mark === "toggle") {
        if (plan?.status === "draft") return notify("a plan can be marked once it is presented");
        if (!plan) return;
        if (favorites.isMarked(plan.id)) filter.unmarking(index);
        return favorites.toggle(plan.id);
      }
      if (mark) {
        const target = filter.nextMark(mark);
        return target !== undefined && select(target);
      }
      if (key.ctrl && (key.leftArrow || key.rightArrow)) return shift(key.leftArrow ? -HSCROLL_STEP : HSCROLL_STEP);
      if (input === "w") {
        setWrap((w) => !w);
        return setHscroll(0);
      }
      if (input === "s") return setOrder(flipOrder);
      const nav = { ...filter.nav, scroll, page: viewport - 2 };
      if (handleNavigation(input, key, nav)) return;
      if (key.return && plan && previous) return toggleDiff(!showDiff);
      if (key.escape && diffOpen) return toggleDiff(false);
      if (input === "c" && plan) {
        copy(plan.text).then(
          () => notify("copied the plan to the clipboard"),
          (err: Error) => notify(`copy failed: ${err.message}`),
        );
      }
    },
    { isActive: active && !filter.open },
  );

  let preview;
  if (!hasSession) preview = <Text dimColor>No Claude Code session found</Text>;
  else if (filter.none) preview = <Text dimColor>No plan matches the filter</Text>;
  else if (!plan)
    preview = (
      <Text dimColor>
        {planMode
          ? "Plan mode is on. The plan shows up here as soon as Claude writes it."
          : "No plan in this session yet. In Claude Code, Shift+Tab switches to plan mode; the plans Claude presents show up here."}
      </Text>
    );
  else
    preview = (
      <Preview
        onWheel={(d) => scroll.by(d)}
        onLink={(url) => notify(`opened ${url}`)}
        header={header}
        lines={lines}
        scroll={scroll.scroll}
        width={previewWidth}
        height={bodyHeight}
        hscroll={Math.min(hscroll, maxHscroll)}
        frozen={rendered.gutterWidth}
        pinned={rendered.hunkStarts}
      />
    );

  const counts = plans.reduce<Record<PlanStatus, number>>(
    (acc, p) => ({ ...acc, [p.status]: acc[p.status] + 1 }),
    { draft: 0, approved: 0, rejected: 0, pending: 0 },
  );

  return (
    <>
    <Screen
      layout={layout}
      mode="plan"
      status={
        <Text dimColor={!focused}>
          {filter.count(plans.length)} {plans.length === 1 ? "plan" : "plans"}
          {counts.approved > 0 && <Text color="green">{` · ${counts.approved} approved`}</Text>}
          {counts.rejected > 0 && <Text color="red">{` · ${counts.rejected} rejected`}</Text>}
          {counts.pending > 0 && <Text color="yellow">{` · ${counts.pending} waiting`}</Text>}
          {counts.draft > 0 && <Text color="cyan">{" · 1 being written"}</Text>}
          {plan && ` · ${scroll.position}`}
          {markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
          {!wrap && hscroll > 0 && ` · → ${Math.min(hscroll, maxHscroll)} cols`}
        </Text>
      }
      list={
        <List
            reversed={reversed}
            onPick={select}
            centre={restored.current}
          // A double click does what Enter does.
          onClick={(i) => isDoubleClick(i) && i === index && plan && previous && toggleDiff(!showDiff)}
          items={plans}
          shown={filter.shown}
          pinned={filter.pinned}
          filter={filter.banner}
          selected={index}
          height={bodyHeight}
          empty={filter.empty ?? "No plans yet"}
          itemKey={(p) => p.id}
          time={(p) => p.timestamp}
          render={(p, isSelected, stars) => {
            const status = STATUS[p.status];
            const marked = stars && favorites.isMarked(p.id);
            return (
              <>
                {marked && <Star />}
                <Text dimColor={!isSelected}>{time(p.timestamp)} </Text>
                <Text color={status.color}>{status.icon} </Text>
                <EntryText
                  text={planTitle(p.text)}
                  width={Math.max(4, listWidth - 8 - (marked ? 2 : 0))}
                  selected={isSelected}
                  active={active}
                />
              </>
            );
          }}
        />
      }
      preview={preview}
      footer={
        flash ?? [
          { text: "↑↓ plan", priority: 4 },
          orderFooter(order, "oldest-first"),
          { text: "PgUp/Dn scroll", priority: 1 },
          ...(previous ? [{ text: "↵ changes", on: diffOpen }] : []),
          ...markFooter(favorites.isMarked(plan?.id), markedCount),
          ...filter.footer,
          ...(wrap ? [] : [{ text: "^←→ side", priority: 4 }]),
          { text: "w wrap", on: wrap, priority: 2 },
          ...(plans.length > 0 ? [{ text: "End follow", on: follow, priority: 2 }] : []),
          { text: "c copy", priority: 2 },
          { text: "1-6/tab view", priority: 1 },
        ]
      }
    />
    {filter.dialog}
    </>
  );
}
