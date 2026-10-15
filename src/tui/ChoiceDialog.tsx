import { Text, useInput } from "ink";
import { useState } from "react";
import { L } from "../i18n/index.js";
import { Dialog, type Layout } from "./layout.js";
import type { ChoiceOption } from "./resumeChoice.js";

export interface Choice<T extends string = string> {
  title: string;
  /** A few lines of detail below the title. */
  lines: string[];
  options: ChoiceOption<T>[];
  /** The option selected at first. */
  initial: number;
  onChoose: (id: T) => void;
}

const MAX_WIDTH = 64;

/**
 * Asks which of a few options to take: ↑↓ move (past disabled ones), Enter takes the selected one,
 * the digits take theirs at once, Esc cancels. Takes all keys while open.
 */
export function ChoiceDialog<T extends string>({
  layout,
  choice,
  onClose,
}: {
  layout: Layout;
  choice: Choice<T>;
  onClose: () => void;
}) {
  const { options } = choice;
  const [selected, setSelected] = useState(choice.initial);
  const take = (i: number) => {
    const option = options[i];
    if (!option || option.disabled) return;
    choice.onChoose(option.id);
  };
  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.return) return take(selected);
    const digit = Number(input);
    if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) return take(digit - 1);
    const step = key.upArrow ? -1 : key.downArrow ? 1 : 0;
    if (!step) return;
    for (let i = selected + step; i >= 0 && i < options.length; i += step) {
      if (!options[i]!.disabled) return setSelected(i);
    }
  });

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  // Title, blank, lines, blank, two rows per option, blank, keys, plus the border. Where that is taller than
  // the pane, only the selected option keeps its detail row.
  const zone = options.findIndex((o) => o.danger);
  const full = choice.lines.length + options.length * 2 + 7 + (zone >= 0 ? 1 : 0);
  const compact = full > layout.rows - 1;
  const height = compact ? choice.lines.length + options.length + 8 + (zone >= 0 ? 1 : 0) : full;
  return (
    <Dialog layout={layout} width={width} height={height}>
      <Text bold color="cyan" wrap="truncate">
        {choice.title}
      </Text>
      <Text> </Text>
      {choice.lines.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line}
        </Text>
      ))}
      <Text> </Text>
      {options.map((o, i) => {
        const isSelected = i === selected;
        const rule =
          i === zone ? (
            <Text key={`${o.id}-zone`} color="red" wrap="truncate">
              {`── ${L().dialog.dangerZone} ${"─".repeat(Math.max(0, width - 8 - L().dialog.dangerZone.length))}`}
            </Text>
          ) : null;
        const label = (
          <Text key={`${o.id}-label`} wrap="truncate" dimColor={o.disabled !== undefined}>
            <Text color="yellow">{i + 1}</Text> <Text color="cyan">{isSelected ? "›" : " "}</Text>{" "}
            <Text bold={isSelected} inverse={isSelected} color={o.danger ? "red" : undefined}>{` ${o.label} `}</Text>
          </Text>
        );
        if (compact && !isSelected) return [rule, label];
        return [
          rule,
          label,
          <Text key={`${o.id}-detail`} wrap="truncate" dimColor color={o.disabled ? "yellow" : undefined}>
            {"     "}
            {o.disabled ?? o.detail}
          </Text>,
        ];
      })}
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="yellow">↑↓</Text> {L().dialog.choose}{"   "}
        <Text color="yellow">Enter</Text> {L().dialog.ok}{"   "}
        <Text color="yellow">{options.map((_, i) => i + 1).join(" ")}</Text> {L().dialog.take}{"   "}
        <Text color="yellow">Esc</Text> {L().dialog.cancel}
      </Text>
    </Dialog>
  );
}
