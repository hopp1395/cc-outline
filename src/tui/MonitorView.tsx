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
  measuredSince,
  type Bucket,
  type Measurements,
} from "../monitor/responses.js";
import { dayLabel } from "./days.js";
import { doubleClicks } from "./openKey.js";
import { useFocused } from "./focus.js";
import { haystack, type FilterText } from "../filter.js";
import {
  bold,
  dim,
  EntryText,
  handleNavigation,
  List,
  markFooter,
  markKeys,
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
import { useReload } from "./reload.js";
import { useListFilter } from "./useListFilter.js";
import { usePositions } from "./usePositions.js";
import { isLoadMore, LOAD_MORE, LoadMoreRow, loadMoreLines, showsLoadMore, useListRange, type LoadMore } from "./loadMore.js";

interface Props {
  layout: Layout;
  /** The view is shown: only then are the transcripts read. */
  visible: boolean;
  /** The view takes keys. */
  active: boolean;
  cwd: string;
  /** The filter dialog opened or closed. */
  onTyping?: (typing: boolean) => void;
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

const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);

const WEEKDAYS_DE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

/** The models that answered on each day. */
function modelsByDay(data: Measurements | undefined): Map<string, Set<string>> {
  const byDay = new Map<string, Set<string>>();
  for (const r of data?.responses ?? []) {
    const day = dayKey(r.start);
    let models = byDay.get(day);
    if (!models) byDay.set(day, (models = new Set()));
    models.add(r.model);
  }
  return byDay;
}

/** What a day is found by in the filter: in the list its date written several ways, in the details the models of that day. */
function dayText(day: string, models: Set<string> | undefined): FilterText {
  const [y, m, d] = day.split("-");
  const weekday = WEEKDAYS_DE[new Date(`${day}T12:00:00`).getDay()];
  return { list: haystack([day, `${d}.${m}.${y}`, `${dayLabel(day, "always")} ${weekday}`]), details: haystack([...(models ?? [])].map(shortModel)) };
}

/**
 * The responses of all projects, read while `visible` and refreshed every
 * few seconds; only what was appended to a transcript is read again.
 * A reload of the view (F5) reads them all again with a new index. With
 * `since`, only transcripts written since then are read, and only the
 * responses since then are returned.
 */
function useMeasurements(visible: boolean, since: number | undefined) {
  const index = useRef(new ResponseIndex());
  const reload = useReload();
  const loaded = useRef(reload.count);
  const [data, setData] = useState<Measurements>();
  // The last finished scan read every transcript (no `since`).
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  useEffect(() => {
    if (!visible) return;
    const fresh = reload.count !== loaded.current;
    loaded.current = reload.count;
    if (fresh) index.current = new ResponseIndex();
    let cancelled = false;
    let busy = false;
    let reloading = fresh;
    // Also when the scan fails or stops early: F5 is refused while a reload runs.
    const finish = () => {
      if (!reloading) return;
      reloading = false;
      reload.done();
    };
    const scan = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await index.current.scan((done, total) => !cancelled && setProgress({ done, total }), since);
        if (!cancelled) {
          setData(measuredSince(result, since));
          setComplete(since === undefined);
          setProgress(undefined);
        }
      } finally {
        busy = false;
        finish();
      }
    };
    void scan();
    const timer = setInterval(() => void scan(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      finish();
    };
  }, [visible, reload.count, since]);
  return { data, progress, complete };
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

/** An entry of the list: a day, or load more after the oldest. */
type Entry = ReturnType<typeof daysWithData>[number] | LoadMore;

export function MonitorView({ layout, visible, active, cwd, onTyping }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const [isDoubleClick] = useState(() => doubleClicks());
  const range = useListRange("monitorRange");
  const { data, progress, complete } = useMeasurements(visible, range.since);
  const more = showsLoadMore(range, complete);
  const positions = usePositions(cwd, "monitor");
  const favorites = useFavorites(cwd, "days");
  const [separators] = useSetting("dateSeparators");
  const [value, setValue] = useState<Value>("score");
  const models = useMemo(() => (data ? modelsByRecency(data) : []), [data]);
  const [modelChoice, setModel] = useState<string>(ALL);
  const model = modelChoice === ALL ? undefined : modelChoice;
  const days = useMemo(() => (data ? daysWithData(data, model) : []), [data, model]);
  // Newest first, then load more while only the range is read.
  // The selection stays on the index of the entry, which is the newest of the days read next.
  const entries: Entry[] = useMemo(() => (more && data ? [...days, LOAD_MORE] : days), [days, more, data]);
  const [index, setIndex] = useState(0);
  // Restores the day selected last, once the days are known.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || days.length === 0) return;
    restored.current = true;
    const i = days.findIndex((d) => d.day === positions.selected);
    if (i > 0) setIndex(i);
  }, [days]);
  const current = Math.min(index, Math.max(0, entries.length - 1));
  const dayModels = useMemo(() => modelsByDay(data), [data]);
  const filter = useListFilter({
    items: entries,
    text: (d) => (isLoadMore(d) ? { list: "", details: "" } : dayText(d.day, dayModels.get(d.day))),
    deps: [dayModels],
    selected: current,
    select: (i) => select(i),
    layout,
    onTyping,
    keep: isLoadMore,
    marked: (d) => !isLoadMore(d) && favorites.isMarked(d.day),
  });
  const picked = filter.none ? undefined : entries[current];
  const onLoadMore = isLoadMore(picked);
  const selected = isLoadMore(picked) ? undefined : picked;
  const loadMore = () => {
    if (!range.requested) range.loadAll();
  };
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
    const title = selected ? `${dayLabel(selected.day)} · ${table ? "Responses" : VALUE_NAMES[value]}` : "Monitor";
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
    if (data && filter.none) return [dim("No day matches the filter")];
    if (data && onLoadMore) return loadMoreLines(range, "days with responses", days.length, range.requested).map(dim);
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
  }, [data, selected?.day, value, model, minutes, viewport, progress, stats, rows, filter.none, onLoadMore, range.since]);
  // The table keeps its own position per day.
  const scroll = positions.scroll(`${selected?.day ?? ""}${table ? "#table" : ""}`, lines.length, viewport);

  const select = (i: number) => setIndex(Math.max(0, Math.min(entries.length - 1, i)));
  const markedCount = days.filter((d) => favorites.isMarked(d.day)).length;
  const choices = [...models, ALL];

  useInput(
    (input, key) => {
      if (filter.handleKey(input, key)) return;
      if (key.return && onLoadMore) return loadMore();
      if (key.return) return setTable((t) => !t);
      if (input === "v" && !table) return setValue((v) => VALUES[(VALUES.indexOf(v) + 1) % VALUES.length]);
      if (input === "m" && models.length > 0) return setModel(choices[(choices.indexOf(modelChoice) + 1) % choices.length]);
      // Checked first: Shift+↑/↓ jump between marked days.
      const mark = markKeys(input, key);
      if (mark === "toggle") {
        if (!selected) return;
        if (favorites.isMarked(selected.day)) filter.unmarking(current);
        return favorites.toggle(selected.day);
      }
      if (mark) {
        const target = filter.nextMark(mark);
        return target !== undefined && select(target);
      }
      handleNavigation(input, key, { ...filter.nav, scroll, page: viewport - 2 });
    },
    { isActive: active && !filter.open },
  );

  const countWidth = Math.max(1, ...days.map((d) => String(d.count).length));
  return (
    <>
    <Screen
      layout={layout}
      mode="monitor"
      status={
        <Text dimColor={!focused}>
          {data ? `${data.responses.length} responses · ${models.length} models${filter.shown ? ` · ${filter.count(days.length)} days` : ""}` : progress ? `reading ${progress.done}/${progress.total}` : "reading…"}
          {markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
        </Text>
      }
      list={
        <List
          onPick={select}
          centre={restored.current}
          // Load more takes a single click; on a day, a double click does what Enter does.
          onClick={(i) => (isLoadMore(entries[i]) ? loadMore() : isDoubleClick(i) && i === current && setTable((t) => !t))}
          items={entries}
          shown={filter.shown}
          pinned={filter.pinned}
          filter={filter.banner}
          selected={current}
          height={bodyHeight}
          empty={filter.empty ?? (data ? "No responses" : "Reading…")}
          itemKey={(d) => (isLoadMore(d) ? "load-more" : d.day)}
          time={(d) => (isLoadMore(d) ? undefined : d.day)}
          period="year"
          render={(d, isSelected) =>
            isLoadMore(d) ? (
              <LoadMoreRow progress={range.requested ? progress : undefined} />
            ) : (
            <>
              {favorites.isMarked(d.day) && <Star />}
              <EntryText
                // The year separators name the year.
                text={dayLabel(d.day, separators ? "never" : "other")}
                width={Math.max(4, listWidth - countWidth - 4 - (favorites.isMarked(d.day) ? 2 : 0))}
                selected={isSelected}
                active={active}
              />
              <Text dimColor={!isSelected}> {String(d.count).padStart(countWidth)}</Text>
              {d.errors > 0 && <Text color="red"> ✗</Text>}
            </>
            )
          }
        />
      }
      preview={
        <Preview header={header} lines={lines} scroll={scroll.scroll} width={previewWidth} height={bodyHeight} onWheel={(d) => scroll.by(d)} />
      }
      footer={[
        { text: "↑↓ day", priority: 4 },
        { text: "PgUp/Dn scroll", priority: 1 },
        ...markFooter(favorites.isMarked(selected?.day), markedCount),
        ...filter.footer,
        onLoadMore ? { text: "↵ load more", priority: 3 } : { text: "↵ table", on: table, priority: 3 },
        ...(table ? [] : [{ text: `v ${VALUE_KEYS[value]}`, on: true, priority: 3 }]),
        { text: `m ${model ? shortModel(model) : "all"}`, on: true, priority: 3 },
        { text: "1-6/tab view", priority: 1 },
      ]}
    />
    {filter.dialog}
    </>
  );
}
