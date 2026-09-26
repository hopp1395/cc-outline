import { Box, Text, useWindowSize } from "ink";
import { useState, type ReactNode } from "react";
import stringWidth from "string-width";

export type Mode = "chat" | "git";

export interface Layout {
  columns: number;
  rows: number;
  listWidth: number;
  previewWidth: number;
  bodyHeight: number;
}

export function useLayout(): Layout {
  const { columns, rows } = useWindowSize();
  const listWidth = Math.min(40, Math.max(20, Math.floor(columns * 0.3)));
  return {
    columns,
    rows,
    listWidth,
    // list + border + padding
    previewWidth: Math.max(20, columns - listWidth - 3),
    bodyHeight: Math.max(3, rows - 2),
  };
}

/** Vertical scroll position within `lineCount` lines shown `height` at a time. */
export function useScroll(lineCount: number, height: number) {
  const [scroll, setScroll] = useState(0);
  const max = Math.max(0, lineCount - height);
  const clamped = Math.min(scroll, max);
  return {
    scroll: clamped,
    max,
    set: (n: number) => setScroll(Math.max(0, Math.min(max, n))),
    by: (delta: number) => setScroll((s) => Math.max(0, Math.min(max, Math.min(s, max) + delta))),
    position: lineCount > height ? `${Math.round(((clamped + height) / lineCount) * 100)}%` : "all",
  };
}

export function truncate(text: string, width: number): string {
  const line = text.split("\n")[0].replace(/\s+/g, " ").trim();
  if (stringWidth(line) <= width) return line;
  let out = "";
  for (const ch of line) {
    if (stringWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return out + "…";
}

function Tabs({ mode }: { mode: Mode }) {
  const tab = (key: string, label: string, m: Mode) =>
    m === mode ? (
      <Text inverse bold>{` ${key} ${label} `}</Text>
    ) : (
      <Text dimColor>{` ${key} ${label} `}</Text>
    );
  return (
    <Text>
      <Text bold color="cyan">cce </Text>
      {tab("1", "Chat", "chat")}
      {tab("2", "Changes", "git")}
    </Text>
  );
}

interface ScreenProps {
  layout: Layout;
  mode: Mode;
  status: ReactNode;
  list: ReactNode;
  preview: ReactNode;
  footer: string;
}

/** Common frame: tab/status bar, list | preview body, key help footer. */
export function Screen({ layout, mode, status, list, preview, footer }: ScreenProps) {
  return (
    <Box flexDirection="column" width={layout.columns} height={layout.rows}>
      <Box width={layout.columns}>
        <Text wrap="truncate">
          <Tabs mode={mode} />
          <Text> </Text>
          {status}
        </Text>
      </Box>
      <Box height={layout.bodyHeight}>
        <Box flexDirection="column" width={layout.listWidth} height={layout.bodyHeight}>
          {list}
        </Box>
        <Box
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderDimColor
          paddingLeft={1}
          height={layout.bodyHeight}
        >
          {preview}
        </Box>
      </Box>
      <Text dimColor wrap="truncate">
        {footer}
      </Text>
    </Box>
  );
}

interface ListProps<T> {
  items: T[];
  selected: number;
  height: number;
  focused: boolean;
  empty: string;
  itemKey: (item: T, index: number) => string;
  render: (item: T, selected: boolean) => ReactNode;
}

/** Selectable list that keeps the selection roughly centred. */
export function List<T>({ items, selected, height, focused, empty, itemKey, render }: ListProps<T>) {
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
  if (items.length === 0) return <Text dimColor>{empty}</Text>;
  return (
    <>
      {items.slice(start, start + height).map((item, i) => {
        const index = start + i;
        const isSelected = index === selected;
        return (
          <Text key={itemKey(item, index)} wrap="truncate" inverse={isSelected && focused} bold={isSelected}>
            {render(item, isSelected)}
          </Text>
        );
      })}
    </>
  );
}
