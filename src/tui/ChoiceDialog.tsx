import { Text, useInput } from "ink";
import { useState } from "react";
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
  // Title, blank, lines, blank, two rows per option, blank, keys, plus the border.
  const height = choice.lines.length + options.length * 2 + 7;
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
        return [
          <Text key={`${o.id}-label`} wrap="truncate" dimColor={o.disabled !== undefined}>
            <Text color="yellow">{i + 1}</Text> <Text color="cyan">{isSelected ? "›" : " "}</Text>{" "}
            <Text bold={isSelected} inverse={isSelected}>{` ${o.label} `}</Text>
          </Text>,
          <Text key={`${o.id}-detail`} wrap="truncate" dimColor color={o.disabled ? "yellow" : undefined}>
            {"     "}
            {o.disabled ?? o.detail}
          </Text>,
        ];
      })}
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="yellow">↑↓</Text> choose{"   "}
        <Text color="yellow">Enter</Text> ok{"   "}
        <Text color="yellow">{options.map((_, i) => i + 1).join(" ")}</Text> take{"   "}
        <Text color="yellow">Esc</Text> cancel
      </Text>
    </Dialog>
  );
}
