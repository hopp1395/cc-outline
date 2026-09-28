import { Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { barChart, bucketMinutes, CHART_AXIS_WIDTH } from "../monitor/chart.js";
import {
  bucketIndex,
  bucketScores,
  dayBuckets,
  dayScore,
  daysWithData,
  median,
  measurable,
  modelsByRecency,
  ResponseIndex,
  scoreOf,
  speedOf,
  typicalBuckets,
  waitOf,
  dayKey,
  type Bucket,
  type Measurements,
} from "../monitor/responses.js";
import { useFocused } from "./focus.js";
import { nextMarked } from "../favorites.js";
import {
  bold,
  dim,
  EntryText,
  flipOrder,
  handleNavigation,
  List,
  markFooter,
  markKeys,
  orderedDir,
  orderedNav,
  orderFooter,
  previewHeader,
  rule,
  Screen,
  Star,
  truncate,
  type Layout,
} from "./layout.js";
import { useSetting } from "./useSetting.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";
import { useFavorites } from "./useFavorites.js";
import { usePositions } from "./usePositions.js";

interface Props {
  layout: Layout;
  /** The view is shown: only then are the transcripts read. */
  visible: boolean;
  /** The view takes keys. */
  active: boolean;
  cwd: string;
}

/** What the chart shows; v steps through them. */
const VALUES = ["score", "speed", "wait", "count"] as const;
type Value = (typeof VALUES)[number];
const VALUE_NAMES: Record<Value, string> = {
  speed: "Speed (output tokens/s)",
  wait: "Wait until the first block (s)",
  count: "Responses",
  score: "Overall (100 = usual speed and wait)",
};
const VALUE_KEYS: Record<Value, string> = { speed: "speed", wait: "wait", count: "responses", score: "overall" };

/** All models together, as a choice of m. */
const ALL = "all models";
const REFRESH_MS = 3000;

/** "opus-5-5" for "claude-opus-5-5". */
const shortModel = (m: string) => m.replace(/^claude-/, "");

/** "Sat 27 Sep" for "2026-09-27". */
function dayName(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);

/**
 * The responses of all projects, read while `visible` and refreshed every
 * few seconds; only what was appended to a transcript is read again.
 */
function useMeasurements(visible: boolean) {
  const index = useRef(new ResponseIndex());
  const [data, setData] = useState<Measurements>();
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let busy = false;
    const scan = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await index.current.scan((done, total) => !cancelled && setProgress({ done, total }));
        if (!cancelled) {
          setData(result);
          setProgress(undefined);
        }
      } finally {
        busy = false;
      }
    };
    void scan();
    const timer = setInterval(() => void scan(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible]);
  return { data, progress };
}

/** A bar's colour: red when clearly worse than usual at that time, green when clearly better. */
function colourFor(value: Value) {
  return (v: number, ref: number | undefined) => {
    if (value === "count" || ref === undefined) return "36";
    // Higher is better for speed and the overall index, lower for the wait.
    const higher = value !== "wait";
    const better = higher ? v > ref * 1.15 : v < ref * 0.85;
    const worse = higher ? v < ref * 0.85 : v > ref * 1.15;
    return better ? "32" : worse ? "31" : "36";
  };
}

const c = (code: string, s: string) => `\u001b[${code}m${s}\u001b[39m`;

/** An overall index, coloured like its bar. */
const scoreText = (score: number | undefined, width = 0) =>
  score === undefined ? dim("–".padStart(width)) : c(colourFor("score")(score, 100), score.toFixed(0).padStart(width));

/** What the colours and marks of the chart mean, below it. */
function legend(value: Value): string[] {
  const usual = `${dim("─")} usual (median of the 30 days before)`;
  const error = `${c("31", "✗")} error`;
  if (value === "count") return [`${c("36", "█")} responses   ${usual}   ${error}`];
  const better = value === "speed" ? "faster" : value === "wait" ? "shorter" : "better";
  const worse = value === "speed" ? "slower" : value === "wait" ? "longer" : "worse";
  return [
    `${c("32", "█")} ${better} than usual   ${c("36", "█")} about usual   ${c("31", "█")} ${worse} than usual ${dim("(by more than 15 %)")}`,
    value === "score" ? `${dim("─")} 100 = usual speed and wait at that time   ${error}` : `${usual}   ${error}`,
  ];
}

const formatValue = (value: Value) => (v: number) => (value === "wait" && v < 10 ? v.toFixed(1) : v.toFixed(0));
/** The bars of `value` and the usual values they are compared with. */
function chartValues(value: Value, buckets: Bucket[], typical: Bucket[]) {
  if (value === "score") {
    return { values: bucketScores(buckets, typical), reference: typical.map((t) => (t.speed || t.wait ? 100 : undefined)) };
  }
  const pick = (b: Bucket) => (value === "count" ? (b.count > 0 ? b.count : undefined) : b[value]);
  return { values: buckets.map(pick), reference: typical.map(pick) };
}

const dayResponses = (data: Measurements, day: string, model: string | undefined) =>
  data.responses.filter((r) => dayKey(r.start) === day && (model === undefined || r.model === model));

/** The figures of the day below the chart. */
function dayFigures(data: Measurements, day: string, model: string | undefined, buckets: Bucket[], typical: Bucket[]): string[] {
  const rs = dayResponses(data, day, model);
  const measured = rs.filter(measurable);
  const usual = (key: "speed" | "wait") => median(typical.map((b) => b[key]).filter((v): v is number => v !== undefined));
  const fmt = (v: number | undefined, unit: string, digits = 0) => (v === undefined ? "–" : `${v.toFixed(digits)}${unit}`);
  const speed = median(measured.map(speedOf));
  const wait = median(measured.map(waitOf));
  // Slowest and fastest hour of the day by median speed.
  const hours: { hour: number; speed: number }[] = [];
  for (let h = 0; h < 24; h++) {
    const s = median(measured.filter((r) => new Date(r.start).getHours() === h).map(speedOf));
    if (s !== undefined) hours.push({ hour: h, speed: s });
  }
  hours.sort((a, b) => a.speed - b.speed);
  const hourName = (h: number) => `${String(h).padStart(2, "0")}:00`;
  const errors = buckets.flatMap((b) => b.errors);
  return [
    `${bold("Overall")}    ${scoreText(dayScore(buckets, typical))}${dim(" · 100 = usual speed and wait at those times")}`,
    `${bold("Speed")}      median ${fmt(speed, " tok/s")}${dim(` · usual ${fmt(usual("speed"), " tok/s")}`)}`,
    `${bold("Wait")}       median ${fmt(wait, " s", 1)}${dim(` · usual ${fmt(usual("wait"), " s", 1)}`)}`,
    `${bold("Responses")}  ${rs.length}${measured.length < rs.length ? dim(` · ${measured.length} long enough to time`) : ""}`,
    ...(hours.length > 1
      ? [`${bold("Slowest")}    ${hourName(hours[0].hour)} ${fmt(hours[0].speed, " tok/s")} · ${bold("fastest")} ${hourName(hours.at(-1)!.hour)} ${fmt(hours.at(-1)!.speed, " tok/s")}`]
      : []),
    ...(errors.length
      ? ["", `${bold("Errors")}`, ...errors.map((e) => `\u001b[31m✗\u001b[39m ${hhmm(e.at)}  ${e.text}`)]
      : []),
    "",
    dim("Speed: output tokens per second of a response. Wait: until its first finished block,"),
    dim("an upper bound of the time to the first token. Usual: median of the 30 days before."),
    dim("Overall: speed / usual and usual / wait, their geometric mean × 100."),
    dim("Transient API errors (overloaded, retries) are not written to transcripts."),
  ];
}

const hhmmss = (at: number) => new Date(at).toTimeString().slice(0, 8);

/** Column headings and rows of the table of the day's responses and errors, oldest first. */
function responseTable(data: Measurements, day: string, model: string | undefined, minutes: number, typical: Bucket[]) {
  const rs = dayResponses(data, day, model);
  const modelWidth = Math.min(16, Math.max(5, ...rs.map((r) => shortModel(r.model).length)));
  const cell = (s: string, width: number) => s.padStart(width);
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const heading = `Time      ${"Model".padEnd(modelWidth)}  ${cell("Wait", 7)}  ${cell("Took", 7)}  ${cell("Tokens", 6)}  ${cell("tok/s", 5)}  ${cell("Index", 5)}`;
  const rows = [
    ...rs.map((r) => {
      const timed = measurable(r);
      const score = timed ? scoreOf({ speed: speedOf(r), wait: waitOf(r) }, typical[bucketIndex(r.start, minutes)]) : undefined;
      const values = `${hhmmss(r.start)}  ${truncate(shortModel(r.model), modelWidth).padEnd(modelWidth)}  ${cell(secs(r.first - r.start), 7)}  ${cell(
        secs(r.end - r.start),
        7,
      )}  ${cell(String(r.outputTokens), 6)}  ${cell(timed ? speedOf(r).toFixed(0) : "–", 5)}  `;
      // Responses too short to time are dimmed; they only count.
      return { at: r.start, line: timed ? `${values}${scoreText(score, 5)}` : dim(`${values}${cell("–", 5)}`) };
    }),
    ...data.errors.filter((e) => dayKey(e.at) === day).map((e) => ({ at: e.at, line: `${hhmmss(e.at)}  ${c("31", `✗ ${e.text}`)}` })),
  ].sort((a, b) => a.at - b.at);
  return { heading, rows: rows.length ? rows.map((r) => r.line) : [dim("No responses on this day.")] };
}

export function MonitorView({ layout, visible, active, cwd }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const { data, progress } = useMeasurements(visible);
  const positions = usePositions(cwd, "monitor");
  const favorites = useFavorites(cwd, "days");
  // Days are kept newest first; oldest first only mirrors the list and its keys.
  const [order, setOrder] = useSetting("monitorOrder");
  const reversed = order === "oldest-first";
  const [value, setValue] = useState<Value>("score");
  const models = useMemo(() => (data ? modelsByRecency(data) : []), [data]);
  const [modelChoice, setModel] = useState<string>(ALL);
  const model = modelChoice === ALL ? undefined : modelChoice;
  const days = useMemo(() => (data ? daysWithData(data, model) : []), [data, model]);
  const [index, setIndex] = useState(0);
  // Restores the day selected last, once the days are known.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || days.length === 0) return;
    restored.current = true;
    const i = days.findIndex((d) => d.day === positions.selected);
    if (i > 0) setIndex(i);
  }, [days]);
  const selected = days[Math.min(index, Math.max(0, days.length - 1))];
  useEffect(() => {
    if (selected && restored.current) positions.select(selected.day);
  }, [selected?.day]);

  const columns = Math.max(24, previewWidth - CHART_AXIS_WIDTH);
  const minutes = bucketMinutes(columns);
  // ↵ shows the day's responses as a table instead of the chart.
  const [table, setTable] = useState(false);
  const stats = useMemo(
    () =>
      data && selected
        ? { buckets: dayBuckets(data, selected.day, minutes, model), typical: typicalBuckets(data, selected.day, minutes, model) }
        : undefined,
    [data, selected?.day, minutes, model],
  );
  const rows = useMemo(
    () => (table && data && selected && stats ? responseTable(data, selected.day, model, minutes, stats.typical) : undefined),
    [table, data, selected?.day, model, minutes, stats],
  );
  const header = useMemo(() => {
    const live = selected?.day === dayKey(Date.now()) ? " · live" : "";
    const modelName = model ? shortModel(model) : ALL;
    const title = selected ? `${dayName(selected.day)} · ${table ? "Responses" : VALUE_NAMES[value]}` : "Monitor";
    const lines = previewHeader(title, previewWidth, {
      marker: "▁▅█ ",
      style: bold,
      details: [
        table && stats
          ? `${modelName} · overall ${scoreText(dayScore(stats.buckets, stats.typical))} · index 100 = usual at that time${live}`
          : `${modelName} · ${minutes} min per bar${live}`,
      ],
    });
    // The column headings stay above the scrolled rows.
    const separator = rule(previewWidth, table ? "↵ chart" : "↵ table");
    return fitHeader([...lines.slice(0, -1), ...(rows ? [bold(rows.heading)] : []), separator], bodyHeight);
  }, [selected?.day, value, model, minutes, previewWidth, bodyHeight, table, stats, rows]);
  const viewport = bodyHeightBelow(header, bodyHeight);
  const lines = useMemo(() => {
    if (!data || !selected || !stats) return [dim(progress ? `reading transcripts ${progress.done}/${progress.total}…` : "reading transcripts…")];
    if (rows) return rows.rows;
    const { buckets, typical } = stats;
    const height = Math.max(4, Math.min(12, viewport - 12));
    const { values, reference } = chartValues(value, buckets, typical);
    const chart = barChart(values, {
      height,
      minutes,
      reference,
      errors: buckets.map((b) => b.errors.length > 0),
      format: formatValue(value),
      colourOf: colourFor(value),
    });
    return [...chart, ...legend(value), "", ...dayFigures(data, selected.day, model, buckets, typical)];
  }, [data, selected?.day, value, model, minutes, viewport, progress, stats, rows]);
  // The table keeps its own position per day.
  const scroll = positions.scroll(`${selected?.day ?? ""}${table ? "#table" : ""}`, lines.length, viewport);

  const select = (i: number) => setIndex(Math.max(0, Math.min(days.length - 1, i)));
  const current = Math.min(index, Math.max(0, days.length - 1));
  const markedCount = days.filter((d) => favorites.isMarked(d.day)).length;
  const choices = [...models, ALL];

  useInput(
    (input, key) => {
      if (key.return) return setTable((t) => !t);
      if (input === "v" && !table) return setValue((v) => VALUES[(VALUES.indexOf(v) + 1) % VALUES.length]);
      if (input === "m" && models.length > 0) return setModel(choices[(choices.indexOf(modelChoice) + 1) % choices.length]);
      // Checked first: Shift+↑/↓ jump between marked days.
      const mark = markKeys(input, key);
      if (mark === "toggle") return selected && favorites.toggle(selected.day);
      if (mark) {
        const target = nextMarked(
          days.map((d) => d.day),
          favorites.marks,
          current,
          orderedDir(reversed, mark),
        );
        return target !== undefined && select(target);
      }
      if (input === "s") return setOrder(flipOrder);
      handleNavigation(input, key, {
        ...orderedNav(reversed, {
          select: (delta: number) => select(index + delta),
          first: () => select(0),
          last: () => select(days.length - 1),
        }),
        scroll,
        page: viewport - 2,
      });
    },
    { isActive: active },
  );

  const countWidth = Math.max(1, ...days.map((d) => String(d.count).length));
  return (
    <Screen
      layout={layout}
      mode="monitor"
      status={
        <Text dimColor={!focused}>
          {data ? `${data.responses.length} responses · ${models.length} models` : progress ? `reading ${progress.done}/${progress.total}` : "reading…"}
          {markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
        </Text>
      }
      list={
        <List
          reversed={reversed}
          onPick={select}
          items={days}
          selected={current}
          height={bodyHeight}
          empty={data ? "No responses" : "Reading…"}
          itemKey={(d) => d.day}
          render={(d, isSelected) => (
            <>
              {favorites.isMarked(d.day) && <Star />}
              <EntryText
                text={dayName(d.day)}
                width={Math.max(4, listWidth - countWidth - 4 - (favorites.isMarked(d.day) ? 2 : 0))}
                selected={isSelected}
                active={active}
              />
              <Text dimColor={!isSelected}> {String(d.count).padStart(countWidth)}</Text>
              {d.errors > 0 && <Text color="red"> ✗</Text>}
            </>
          )}
        />
      }
      preview={
        <Preview header={header} lines={lines} scroll={scroll.scroll} width={previewWidth} height={bodyHeight} onWheel={(d) => scroll.by(d)} />
      }
      footer={[
        { text: "↑↓ day", priority: 4 },
        orderFooter(order, "newest-first"),
        { text: "PgUp/Dn scroll", priority: 1 },
        ...markFooter(favorites.isMarked(selected?.day), markedCount),
        { text: "↵ table", on: table, priority: 3 },
        ...(table ? [] : [{ text: `v ${VALUE_KEYS[value]}`, on: true, priority: 3 }]),
        { text: `m ${model ? shortModel(model) : "all"}`, on: true, priority: 3 },
        { text: "1-6/tab view", priority: 1 },
      ]}
    />
  );
}
