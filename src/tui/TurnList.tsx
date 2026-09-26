import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { Turn } from "../transcript/parse.js";

interface Props {
  turns: Turn[];
  selected: number;
  width: number;
  height: number;
  focused: boolean;
}

function truncate(text: string, width: number): string {
  const line = text.split("\n")[0].replace(/\s+/g, " ").trim();
  if (stringWidth(line) <= width) return line;
  let out = "";
  for (const ch of line) {
    if (stringWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return out + "…";
}

function time(ts?: string): string {
  if (!ts) return "     ";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function TurnList({ turns, selected, width, height, focused }: Props) {
  // Keep the selection roughly centred in the visible window.
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), turns.length - height));
  const visible = turns.slice(start, start + height);
  const textWidth = Math.max(4, width - 7);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {turns.length === 0 && <Text dimColor>Waiting for prompts…</Text>}
      {visible.map((turn, i) => {
        const index = start + i;
        const isSelected = index === selected;
        return (
          <Text key={turn.id + index} wrap="truncate" inverse={isSelected && focused} bold={isSelected}>
            <Text dimColor={!isSelected}>{time(turn.timestamp)} </Text>
            {truncate(turn.prompt, textWidth)}
          </Text>
        );
      })}
    </Box>
  );
}
