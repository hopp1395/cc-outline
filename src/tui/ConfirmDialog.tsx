import { Text, useInput } from "ink";
import { Dialog, type Layout } from "./layout.js";

export interface Confirmation {
  title: string;
  /** A few lines of detail below the title. */
  lines: string[];
  /** Label of the action, e.g. "move to trash". */
  action: string;
  /** Destructive for good: shown in red. */
  danger?: boolean;
  onConfirm: () => void;
}

const MAX_WIDTH = 64;

/** Asks before an action: y confirms, n or Esc cancels. Takes all keys while open. */
export function ConfirmDialog({
  layout,
  confirmation,
  onClose,
}: {
  layout: Layout;
  confirmation: Confirmation;
  onClose: () => void;
}) {
  useInput((input, key) => {
    if (input === "y") {
      onClose();
      confirmation.onConfirm();
    } else if (input === "n" || key.escape) onClose();
  });

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  const color = confirmation.danger ? "red" : "yellow";
  // Title, blank, lines, blank, keys, plus the border.
  const height = confirmation.lines.length + 6;
  return (
    <Dialog layout={layout} width={width} height={height} borderColor={color}>
      <Text bold color={color} wrap="truncate">
        {confirmation.title}
      </Text>
      <Text> </Text>
      {confirmation.lines.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line}
        </Text>
      ))}
      <Text> </Text>
      <Text wrap="truncate">
        <Text color={color}>y</Text> {confirmation.action}
        {"   "}
        <Text color="yellow">n</Text> / <Text color="yellow">Esc</Text> cancel
      </Text>
    </Dialog>
  );
}
