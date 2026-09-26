import { Box, Text } from "ink";

interface Props {
  lines: string[];
  scroll: number;
  width: number;
  height: number;
}

export function Preview({ lines, scroll, width, height }: Props) {
  const visible = lines.slice(scroll, scroll + height);
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {visible.map((line, i) => (
        // Lines are pre-wrapped to `width`; a lone space keeps empty lines from collapsing.
        <Text key={scroll + i} wrap="truncate">
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}
