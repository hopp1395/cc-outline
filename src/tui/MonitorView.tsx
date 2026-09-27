import { Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { barChart, bucketMinutes, CHART_AXIS_WIDTH } from "../monitor/chart.js";
import {
  dayBuckets,
  daysWithData,
  median,
  measurable,
  modelsByRecency,
  ResponseIndex,
  speedOf,
  typicalBuckets,
  waitOf,
  dayKey,
  type Bucket,
  type Measurements,
} from "../monitor/responses.js";
import { useFocused } from "./focus.js";
import { bold, dim, EntryText, handleNavigation, List, previewHeader, Screen, type Layout } from "./layout.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";
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
const VALUES = ["speed", "wait", "count"] as const;
type Value = (typeof VALUES)[number];
const VALUE_NAMES: Record<Value, string> = { speed: "Speed (output tokens/s)", wait: "Wait until the first block (s)", count: "Responses" };
const VALUE_KEYS: Record<Value, string> = { speed: "speed", wait: "wait", count: "responses" };

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
    const better = value === "speed" ? v > ref * 1.15 : v < ref * 0.85;
    const worse = value === "speed" ? v < ref * 0.85 : v > ref * 1.15;
    return better ? "32" : worse ? "31" : "36";
  };
}

const formatValue = (value: Value) => (v: number) => (value === "wait" && v < 10 ? v.toFixed(1) : v.toFixed(0));
const pick = (value: Value) => (b: Bucket) => (value === "count" ? (b.count > 0 ? b.count : undefined) : b[value]);

/** The figures of the day below the chart. */
function dayFigures(data: Measurements, day: string, model: string | undefined, buckets: Bucket[], typical: Bucket[]): string[] {
  const rs = data.responses.filter((r) => dayKey(r.start) === day && (model === undefined || r.model === model));
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
    dim("Transient API errors (overloaded, retries) are not written to transcripts."),
  ];
}

export function MonitorView({ layout, visible, active, cwd }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const { data, progress } = useMeasurements(visible);
  const positions = usePositions(cwd, "monitor");
  const [value, setValue] = useState<Value>("speed");
  const models = useMemo(() => (data ? modelsByRecency(data) : []), [data]);
  const [chosenModel, setModel] = useState<string>();
  // Until one is chosen with m: the model used last.
  const modelChoice = chosenModel ?? models[0] ?? ALL;
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
  const header = useMemo(
    () =>
      fitHeader(
        previewHeader(selected ? `${dayName(selected.day)} · ${VALUE_NAMES[value]}` : "Monitor", previewWidth, {
          marker: "▁▅█ ",
          style: bold,
          details: [`${model ? shortModel(model) : ALL} · ${minutes} min per bar${selected?.day === dayKey(Date.now()) ? " · live" : ""}`],
        }),
        bodyHeight,
      ),
    [selected?.day, value, model, minutes, previewWidth, bodyHeight],
  );
  const viewport = bodyHeightBelow(header, bodyHeight);
  const lines = useMemo(() => {
    if (!data || !selected) return [dim(progress ? `reading transcripts ${progress.done}/${progress.total}…` : "reading transcripts…")];
    const buckets = dayBuckets(data, selected.day, minutes, model);
    const typical = typicalBuckets(data, selected.day, minutes, model);
    const height = Math.max(4, Math.min(12, viewport - 12));
    const chart = barChart(buckets.map(pick(value)), {
      height,
      minutes,
      reference: typical.map(pick(value)),
      errors: buckets.map((b) => b.errors.length > 0),
      format: formatValue(value),
      colourOf: colourFor(value),
    });
    return [...chart, "", ...dayFigures(data, selected.day, model, buckets, typical)];
  }, [data, selected?.day, value, model, minutes, viewport, progress]);
  const scroll = positions.scroll(selected?.day ?? "", lines.length, viewport);

  const select = (i: number) => setIndex(Math.max(0, Math.min(days.length - 1, i)));
  const choices = [...models, ALL];

  useInput(
    (input, key) => {
      if (input === "v") return setValue((v) => VALUES[(VALUES.indexOf(v) + 1) % VALUES.length]);
      if (input === "m" && models.length > 0) return setModel(choices[(choices.indexOf(modelChoice) + 1) % choices.length]);
      handleNavigation(input, key, {
        select: (delta) => select(index + delta),
        first: () => select(0),
        last: () => select(days.length - 1),
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
        </Text>
      }
      list={
        <List
          onPick={select}
          items={days}
          selected={Math.min(index, Math.max(0, days.length - 1))}
          height={bodyHeight}
          empty={data ? "No responses" : "Reading…"}
          itemKey={(d) => d.day}
          render={(d, isSelected) => (
            <>
              <EntryText text={dayName(d.day)} width={Math.max(4, listWidth - countWidth - 4)} selected={isSelected} active={active} />
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
        { text: "←→ day", priority: 4 },
        { text: "↑↓ scroll", priority: 1 },
        { text: `v ${VALUE_KEYS[value]}`, on: true, priority: 3 },
        { text: `m ${model ? shortModel(model) : "all"}`, on: true, priority: 3 },
        { text: "1-6 view", priority: 1 },
      ]}
    />
  );
}
