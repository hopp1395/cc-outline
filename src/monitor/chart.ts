import stringWidth from "string-width";

/** Eighths of a cell, from one to eight. */
const EIGHTHS = "▁▂▃▄▅▆▇█";

/** Stretch lengths the chart can use; the smallest whose whole day fits the width wins. */
const STEPS = [5, 10, 15, 20, 30, 60];

/** Minutes per bar so that a whole day fits into `columns` bars. */
export function bucketMinutes(columns: number): number {
  return STEPS.find((m) => Math.ceil(1440 / m) <= columns) ?? 60;
}

const colour = (code: string, s: string) => (code ? `\u001b[${code}m${s}\u001b[39m` : s);
const dim = (s: string) => `\u001b[2m${s}\u001b[22m`;

export interface ChartOptions {
  /** Rows of bars. */
  height: number;
  /** Typical value per bar, drawn as a dimmed ─ where the bar does not reach it. */
  reference?: (number | undefined)[];
  /** Bars with an error get a ✗ on the time axis. */
  errors?: boolean[];
  /** Minutes per bar, for the hour labels. */
  minutes: number;
  /** Tick label of a value on the y axis, e.g. "80". */
  format: (value: number) => string;
  /** SGR colour code of a bar, e.g. "32" (green); from its value and the typical one. */
  colourOf?: (value: number, reference: number | undefined) => string;
}

/** A round top for the y axis: 1, 1.5, 2, 2.5, 3, 4, 5 or 7.5 times a power of ten, at least `max`. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].find((f) => f * power >= max) ?? 10) * power;
}

/**
 * A bar chart of `values` (one bar per stretch, undefined = no data) as
 * ANSI lines: a y axis with three ticks, `height` rows of bars in eighths,
 * and a time axis with hour labels and ✗ for errors.
 */
export function barChart(values: (number | undefined)[], opts: ChartOptions): string[] {
  const { height, reference = [], errors = [], minutes } = opts;
  const top = niceMax(Math.max(0, ...values.map((v) => v ?? 0), ...reference.map((v) => v ?? 0)));
  const ticks = new Map([
    [height - 1, top],
    [Math.floor((height - 1) / 2), top / 2],
  ]);
  const axisWidth = Math.max(...[...ticks.values(), 0].map((v) => stringWidth(opts.format(v)))) + 1;
  const pad = (s: string) => " ".repeat(Math.max(0, axisWidth - stringWidth(s))) + s;

  const lines: string[] = [];
  for (let row = height - 1; row >= 0; row--) {
    // Rows count from the bottom; the tick rows are the top one and the middle one.
    const label = row === 0 ? pad(opts.format(0)) : ticks.has(row) ? pad(opts.format(ticks.get(row)!)) : " ".repeat(axisWidth);
    let cells = "";
    values.forEach((v, i) => {
      const ref = reference[i];
      const filled = v === undefined ? 0 : Math.round((v / top) * height * 8);
      const here = Math.max(0, Math.min(8, filled - row * 8));
      // v > 0 always shows at least the lowest eighth, so a slow stretch is not mistaken for none.
      const eighths = row === 0 && here === 0 && v !== undefined && v > 0 ? 1 : here;
      if (eighths > 0) {
        cells += colour(opts.colourOf?.(v!, ref) ?? "36", EIGHTHS[eighths - 1]);
      } else if (ref !== undefined && Math.min(height - 1, Math.floor((ref / top) * height)) === row) {
        cells += dim("─");
      } else {
        cells += " ";
      }
    });
    lines.push(`${label}${row === 0 ? "┼" : "┤"}${cells}`);
  }

  // Hour labels as far apart as they need to be: every 1, 2, 3, 4 or 6 hours.
  const perHour = 60 / minutes;
  const step = [1, 2, 3, 4, 6, 12].find((h) => h * perHour >= 4) ?? 12;
  let axis = "";
  let labels = "";
  values.forEach((_, i) => {
    const minute = i * minutes;
    const tick = minute % (step * 60) === 0;
    axis += errors[i] ? colour("31", "✗") : tick ? "┬" : "─";
    // A label only where it keeps a space to the previous one.
    if (tick && (i === 0 || labels.length < i)) labels += " ".repeat(i - labels.length) + String(minute / 60).padStart(2, "0");
  });
  lines.push(`${" ".repeat(axisWidth)}└${axis}`);
  lines.push(`${" ".repeat(axisWidth + 1)}${labels}`);
  return lines;
}

/** Width the y axis and its line take up, for fitting the bars into a pane. */
export const CHART_AXIS_WIDTH = 6;
