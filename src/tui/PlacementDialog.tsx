import { Text, useInput } from "ink";
import { PLACEMENT_VALUES, type Placement } from "../settings.js";
import { Dialog, type Layout } from "./layout.js";
import { placementMeaning, shortValueName } from "./SettingsView.js";
import { L } from "../i18n/index.js";

const MAX_WIDTH = 64;

/**
 * Asks where the viewer should run: 1 right, 2 left, 3 a window of its own.
 * Takes all keys while open; Esc cancels.
 */
export function PlacementDialog({
  layout,
  current,
  canMove,
  onChoose,
  onClose,
}: {
  layout: Layout;
  /** Where the viewer runs now, if known. */
  current?: Placement;
  /** A supported terminal runs the viewer; otherwise the choice is only remembered. */
  canMove: boolean;
  onChoose: (placement: Placement) => void;
  onClose: () => void;
}) {
  useInput((input, key) => {
    const choice = PLACEMENT_VALUES[Number(input) - 1];
    if (choice) {
      onClose();
      onChoose(choice);
    } else if (key.escape || input === "p") onClose();
  });

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  const t = L().placement;
  const note = canMove ? t.reopens : t.remembered;
  const names = PLACEMENT_VALUES.map((p) => shortValueName(p));
  const column = Math.max(...names.map((n) => n.length)) + 1;
  // Title, blank, three places, blank, note, blank, keys, plus the border.
  const height = PLACEMENT_VALUES.length + 8;
  return (
    <Dialog layout={layout} width={width} height={height}>
      <Text bold color="cyan" wrap="truncate">
        {t.title}
      </Text>
      <Text> </Text>
      {PLACEMENT_VALUES.map((p, i) => (
        <Text key={p} wrap="truncate">
          <Text color="yellow">{i + 1}</Text> {p === current ? <Text color="green">●</Text> : " "}{" "}
          <Text bold={p === current}>{names[i].padEnd(column)}</Text>
          <Text dimColor>{placementMeaning(p)}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor wrap="truncate">
        {note}
      </Text>
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="yellow">1 2 3</Text> {t.choose}{"   "}
        <Text color="yellow">Esc</Text> {t.cancel}
      </Text>
    </Dialog>
  );
}
