import { Text, useInput } from "ink";
import { useState } from "react";
import { L } from "../i18n/index.js";
import type { AgentExport, ExportOptions } from "../export/session.js";
import { TOOL_LEVELS } from "../transcript/tools.js";
import { Dialog, type Layout } from "./layout.js";

const MAX_WIDTH = 64;

/** A field of the form: its label, its values in order and what each means. */
interface Field<K extends keyof ExportOptions = keyof ExportOptions> {
  key: K;
  label: string;
  values: readonly ExportOptions[K][];
  name: (value: ExportOptions[K]) => string;
}

const onOff = (v: boolean) => (v ? L().settings.values.on : L().settings.values.off);

const FIELDS: Field[] = [
  { key: "tools", label: "tools", values: TOOL_LEVELS, name: (v) => L().settings.values[String(v)] ?? String(v) },
  { key: "thinking", label: "thinking", values: [false, true], name: (v) => onOff(v as boolean) },
  { key: "agents", label: "agents", values: ["none", "reports", "full"], name: (v) => L().dialogs.export.agents[v as AgentExport] ?? String(v) },
  { key: "stats", label: "stats", values: [false, true], name: (v) => onOff(v as boolean) },
] as Field[];

/** The value after (`step` 1) or before (-1) `value`, wrapping around. */
function stepValue<T>(values: readonly T[], value: T, step: number): T {
  const i = values.indexOf(value);
  return values[(i + step + values.length) % values.length]!;
}

/**
 * The export's options in one form, filled with the last choice: ↑↓ pick a field, ←→ or Space change it,
 * Enter exports, Esc cancels. Every export writes all four formats; the backup ignores the fields.
 */
export function ExportDialog({
  layout,
  lines,
  warning,
  initial,
  onExport,
  onClose,
}: {
  layout: Layout;
  /** What is exported and where to. */
  lines: string[];
  /** E.g. that a session is still running. */
  warning?: string;
  initial: ExportOptions;
  onExport: (opts: ExportOptions) => void;
  onClose: () => void;
}) {
  const [opts, setOpts] = useState(initial);
  const [row, setRow] = useState(0);
  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.return) return onExport(opts);
    if (key.upArrow || key.downArrow) return setRow((r) => (r + (key.upArrow ? -1 : 1) + FIELDS.length) % FIELDS.length);
    const step = key.leftArrow ? -1 : key.rightArrow || input === " " ? 1 : 0;
    if (!step) return;
    const field = FIELDS[row]!;
    setOpts((o) => ({ ...o, [field.key]: stepValue(field.values as unknown[], o[field.key], step) }));
  });

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  // Title, blank, lines, blank, formats, blank, fields, blank, warning, keys, plus the border.
  const height = lines.length + FIELDS.length + 9 + (warning ? 1 : 0);
  return (
    <Dialog layout={layout} width={width} height={height}>
      <Text bold color="cyan" wrap="truncate">
        {L().dialogs.export.title}
      </Text>
      <Text> </Text>
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line}
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor wrap="truncate">
        {L().dialogs.export.formats}
      </Text>
      <Text> </Text>
      {FIELDS.map((f, i) => {
        const selected = i === row;
        return (
          <Text key={f.key} wrap="truncate">
            <Text color="cyan">{selected ? "›" : " "}</Text> {(L().dialogs.export.fields[f.label] ?? f.label).padEnd(Math.max(12, ...FIELDS.map((g) => (L().dialogs.export.fields[g.label] ?? g.label).length + 1)))}
            <Text dimColor={!selected}>‹ </Text>
            <Text bold={selected} inverse={selected}>{` ${f.name(opts[f.key] as never)} `}</Text>
            <Text dimColor={!selected}> ›</Text>
          </Text>
        );
      })}
      <Text> </Text>
      {warning && (
        <Text color="yellow" wrap="truncate">
          {warning}
        </Text>
      )}
      <Text wrap="truncate">
        <Text color="yellow">↑↓</Text> {L().dialogs.export.field}{"   "}
        <Text color="yellow">←→</Text> {L().dialogs.export.change}{"   "}
        <Text color="yellow">Enter</Text> {L().dialogs.export.export}{"   "}
        <Text color="yellow">Esc</Text> {L().dialog.cancel}
      </Text>
    </Dialog>
  );
}
