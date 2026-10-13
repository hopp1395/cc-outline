import { Text, useInput, usePaste } from "ink";
import { useState } from "react";
import stringWidth from "string-width";
import { ALL_AVATAR_PRESETS, AVATAR_MAX_WIDTH, AVATAR_PRESETS, avatarProblem, DEFAULT_AVATAR, emojiInputHint } from "../avatar.js";
import { editLine, insertable, lineOf } from "../filter.js";
import { codeSpan } from "../render/terminal.js";
import { LineField } from "./FilterDialog.js";
import { Dialog, type Layout } from "./layout.js";

const MAX_WIDTH = 56;

/** A row of the dialog: a group's heading, or an option (the default, a preset). */
type DialogRow = { heading: string } | { avatar: string; meaning: string };

/** The default, then the presets by group. */
const ROWS: DialogRow[] = [
  { heading: "Default" },
  { avatar: "", meaning: `the "${DEFAULT_AVATAR}"` },
  ...AVATAR_PRESETS.flatMap((g): DialogRow[] => [{ heading: g.group }, ...g.presets]),
];
const OPTIONS = ROWS.flatMap((r) => ("avatar" in r ? [r.avatar] : []));
/** The index past the options: the text field for one's own. */
const OWN = OPTIONS.length;

/** The rows of `ROWS` shown in `height` rows, so that the option `selected` (or, on the text field, the last) is among them. */
function visibleRows(height: number, selected: number): DialogRow[] {
  if (ROWS.length <= height) return ROWS;
  const target = ROWS.findIndex((r) => "avatar" in r && r.avatar === OPTIONS[Math.min(selected, OWN - 1)]);
  const start = Math.max(0, Math.min(ROWS.length - height, target - Math.floor(height / 2)));
  return ROWS.slice(start, start + height);
}

/** Text with backticks in the chat's inline-code style, as in the Settings view. */
const marks = (text: string) => text.replace(/`([^`]+)`/g, (_, code: string) => codeSpan(code));

/**
 * Chooses the account's avatar: the default "cco", one of the presets (each with what it shows) or one's own text
 * of up to six columns. ↑↓ move (past the last preset into the text field), typing goes into the field, Enter
 * takes it, Esc cancels.
 */
export function AvatarDialog({
  layout,
  value,
  onSave,
  onCancel,
}: {
  layout: Layout;
  /** The setting as stored: "" for the default. */
  value: string;
  onSave: (avatar: string) => void;
  onCancel: () => void;
}) {
  const own = value !== "" && !ALL_AVATAR_PRESETS.some((p) => p.avatar === value);
  const [selected, setSelected] = useState(() => (own ? OWN : Math.max(0, OPTIONS.indexOf(value))));
  const [line, setLine] = useState(() => lineOf(own ? value : ""));
  const problem = avatarProblem(line.text);
  const [shownProblem, setShownProblem] = useState(false);
  const edit = (next: typeof line) => {
    setLine(next);
    setShownProblem(false);
    setSelected(OWN);
  };
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.return) {
      if (selected < OWN) return onSave(OPTIONS[selected]);
      if (problem) return setShownProblem(true);
      return onSave(line.text.trim());
    }
    if (key.upArrow) return setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow || key.tab) return setSelected((i) => Math.min(OWN, i + 1));
    // On a preset, ←→ and Backspace leave the field alone; typing goes into it.
    if (selected < OWN && (key.leftArrow || key.rightArrow || key.backspace || key.delete)) return;
    const next = editLine(line, input, key);
    if (next !== line) edit(next);
  });
  usePaste((text) => edit(editLine(line, insertable(text), {})));

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  // Title, blank, the rows, blank, own label, field, problem, hint, blank, keys, plus the border.
  const fixed = 11;
  const rows = visibleRows(Math.max(3, Math.min(ROWS.length, layout.rows - 2 - fixed)), selected);
  return (
    <Dialog layout={layout} width={width} height={fixed + rows.length}>
      <Text bold color="cyan" wrap="truncate">
        Avatar in the top bar
      </Text>
      <Text> </Text>
      {rows.map((r) => {
        if ("heading" in r) {
          return (
            <Text key={`h:${r.heading}`} dimColor wrap="truncate">
              {r.heading}
            </Text>
          );
        }
        const on = selected < OWN && OPTIONS[selected] === r.avatar;
        const shown = r.avatar || DEFAULT_AVATAR;
        return (
          <Text key={`a:${r.avatar}`} wrap="truncate">
            <Text color={on ? "cyan" : undefined}>{on ? "› " : "  "}</Text>
            <Text inverse={on} bold={on}>
              {` ${shown}${" ".repeat(Math.max(0, AVATAR_MAX_WIDTH - stringWidth(shown)))} `}
            </Text>
            <Text dimColor={!on}>{`  ${r.meaning}`}</Text>
          </Text>
        );
      })}
      <Text> </Text>
      <Text dimColor={selected !== OWN} wrap="truncate">
        Your own, up to {AVATAR_MAX_WIDTH} columns:
      </Text>
      {selected === OWN ? <LineField line={line} width={width} /> : <Text dimColor>{`› ${line.text}`}</Text>}
      <Text color="red" wrap="truncate">
        {shownProblem && problem ? `  ${problem}` : " "}
      </Text>
      <Text dimColor wrap="truncate">
        {marks(emojiInputHint())}
      </Text>
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="yellow">↑↓</Text> choose{"  "}
        <Text color="yellow">Enter</Text> take{"  "}
        <Text color="yellow">Esc</Text> cancel
      </Text>
    </Dialog>
  );
}
