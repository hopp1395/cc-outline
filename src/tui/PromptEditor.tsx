import { Box, Text, useInput, usePaste } from "ink";
import { useEffect, useRef, useState } from "react";
import stringWidth from "string-width";
import { readClipboardImages } from "../clipboardImage.js";
import { editLine, nextBoundary, previousBoundary, type LineState } from "../filter.js";
import { detectTerminal, openInDefaultApp } from "../open.js";
import {
  draftImages,
  fromPromptText,
  nextImageNumber,
  placeholder,
  promptImageDir,
  promptText,
  readDraft,
  referenced,
  removeImage,
  saveDraft,
  type PromptDraft,
  type PromptImage,
} from "../promptDraft.js";
import { parseMouse } from "./mouse.js";
import { pastable, promptRows } from "./PromptDialog.js";
import type { Layout } from "./layout.js";

/** The button that hands the prompt over, at the right end of the status row. */
export const HAND_OVER = "[ Hand over to Claude ]";
/** How many images the list shows while it has the keys; the others scroll. */
const IMAGE_ROWS = 5;
/** A draft is written this long after the last change, and at once when the editor closes. */
const SAVE_DELAY_MS = 300;

type Focus = "text" | "images" | "button";

/** Ctrl+Enter: a line feed in Windows Terminal (like Ctrl+J), CSI u or xterm's modifyOtherKeys where the terminal sends them. */
const isCtrlEnter = (input: string, key: { return?: boolean; ctrl?: boolean }) =>
  input === "\n" || (key.return === true && key.ctrl === true) || input === "[13;5u" || input === "[27;5;13~";

const PLACEHOLDER_SPLIT = /(\[Image #\d+\])/;

/** `text` with its image placeholders in magenta. */
function Painted({ text }: { text: string }) {
  return (
    <>
      {text.split(PLACEHOLDER_SPLIT).map((part, i) =>
        i % 2 === 1 ? (
          <Text key={i} color="magenta">
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </>
  );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The cursor one word to the left (`-1`) or right (`1`): over spaces, then over the word. */
export function wordStep(text: string, cursor: number, dir: -1 | 1): number {
  let at = cursor;
  const charAt = (i: number) => text.slice(i, nextBoundary(text, i));
  if (dir < 0) {
    while (at > 0 && /\s/.test(charAt(previousBoundary(text, at)))) at = previousBoundary(text, at);
    while (at > 0 && !/\s/.test(charAt(previousBoundary(text, at)))) at = previousBoundary(text, at);
  } else {
    while (at < text.length && !/\s/.test(charAt(at))) at = nextBoundary(text, at);
    while (at < text.length && /\s/.test(charAt(at))) at = nextBoundary(text, at);
  }
  return at;
}

/** The cursor `rows` rows up (negative) or down, at the same column as far as that row reaches. */
export function rowStep(text: string, cursor: number, room: number, rows: number): number {
  const { rows: all, row, column } = promptRows(text, cursor, room);
  const target = all[Math.max(0, Math.min(all.length - 1, row + rows))]!;
  if (target === all[row]) return rows < 0 ? 0 : text.length;
  let offset = 0;
  for (const { segment } of graphemes.segment(target.text)) {
    if (stringWidth(target.text.slice(0, offset + segment.length)) > stringWidth(all[row]!.text.slice(0, column))) break;
    offset += segment.length;
  }
  return target.start + offset;
}

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

/** One image of the list: number, pixels, size, source, time; marked when its placeholder is no longer in the text. */
export function imageLine(image: PromptImage, inText: boolean): string {
  const pixels = image.width && image.height ? `${image.width}×${image.height}` : "?×?";
  return [`#${image.n}`, pixels, kb(image.bytes), image.source, clock(image.at), inText ? "" : "not in the text"].filter(Boolean).join("  ");
}

/**
 * cco's prompt editor (`e` in the viewer, Ctrl+G in Claude Code with VISUAL set up): the whole pane for writing a
 * prompt as in Notepad. Enter starts a new line; Ctrl+Enter, Ctrl+S or the button hand it over. Alt+V (or a paste
 * that brings no text) takes the clipboard's image: saved below `~/.claude/cco/images`, it shows as `[Image #n]`,
 * which becomes the image's path in quotes when handed over. The draft is kept per session on disk, also when
 * closed with Esc. `initialText` (Ctrl+G with text in Claude Code's prompt line) takes the place of the draft's text.
 */
export function PromptEditor({
  layout,
  title,
  detail,
  draftKey,
  initialText,
  active = true,
  onSubmit,
  onCancel,
}: {
  layout: Layout;
  title: string;
  /** A dim line below the title: where the prompt goes. */
  detail: string;
  draftKey: string;
  initialText?: string;
  active?: boolean;
  /** The text with the images' paths, and the draft it came from (the caller clears or keeps it). */
  onSubmit: (text: string, draft: PromptDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraftState] = useState<PromptDraft>(() => {
    const saved = readDraft(draftKey);
    return initialText?.trim() ? fromPromptText(initialText.replace(/\r\n?/g, "\n").replace(/\n+$/, ""), saved.images) : saved;
  });
  const [cursor, setCursor] = useState(() => draft.text.length);
  const [focus, setFocus] = useState<Focus>("text");
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState<string>();
  const [reading, setReading] = useState(false);
  const top = useRef(0);
  const dirty = useRef(false);
  const latest = useRef(draft);
  latest.current = draft;

  // Written a moment after typing stops, and once more when the editor goes.
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => saveDraft(draftKey, latest.current), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => () => void (dirty.current && saveDraft(draftKey, latest.current)), []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(undefined), 4000);
    return () => clearTimeout(timer);
  }, [message]);

  const setDraft = (next: PromptDraft, at?: number) => {
    dirty.current = true;
    setDraftState(next);
    if (at !== undefined) setCursor(at);
  };
  const edit = (text: string, at: number) => setDraft({ ...draft, text }, at);
  const insert = (add: string) => edit(draft.text.slice(0, cursor) + add + draft.text.slice(cursor), cursor + add.length);

  const pasteImage = () => {
    if (reading) return;
    setReading(true);
    setMessage("reading the clipboard…");
    readClipboardImages(promptImageDir()).then(
      (read) => {
        setReading(false);
        if (read.images.length === 0) return setMessage("reason" in read ? read.reason : "no image in the clipboard");
        const current = latest.current;
        const images = draftImages(read.images, nextImageNumber(current.images));
        const before = current.text.slice(0, cursor);
        const lead = before && !/\s$/.test(before) ? " " : "";
        const add = lead + images.map((i) => placeholder(i.n)).join(" ") + " ";
        setDraft({ text: before + add + current.text.slice(cursor), images: [...current.images, ...images] }, cursor + add.length);
        setMessage(`added ${images.map((i) => placeholder(i.n)).join(", ")}`);
      },
      () => {
        setReading(false);
        setMessage("the clipboard could not be read");
      },
    );
  };

  const submit = () => {
    const text = promptText(latest.current);
    if (!text) return setMessage("nothing to hand over yet");
    // Kept until the hand-over worked: the caller clears it then.
    saveDraft(draftKey, latest.current);
    dirty.current = false;
    onSubmit(text, latest.current);
  };
  const cancel = () => {
    if (dirty.current) saveDraft(draftKey, latest.current);
    dirty.current = false;
    onCancel();
  };

  const inner = Math.max(10, layout.columns - 4);
  const room = Math.max(4, inner - 2);
  const inText = referenced(draft.text);
  const images = draft.images;
  const imageRows = images.length === 0 ? 0 : focus === "images" ? 1 + Math.min(IMAGE_ROWS, images.length) : 1;
  // Border, title and detail, the images, the status row and the help line.
  const textRows = Math.max(3, layout.rows - 2 - 2 - imageRows - 2);
  const { rows, row, column } = promptRows(draft.text, cursor, room);
  if (row < top.current) top.current = row;
  if (row >= top.current + textRows) top.current = row - textRows + 1;
  top.current = Math.max(0, Math.min(top.current, Math.max(0, rows.length - textRows)));
  const first = top.current;
  const order: Focus[] = images.length > 0 ? ["text", "images", "button"] : ["text", "button"];
  const cycle = (dir: 1 | -1) => setFocus(order[(order.indexOf(focus) + dir + order.length) % order.length]!);
  const sel = Math.min(selected, Math.max(0, images.length - 1));
  const buttonRow = layout.rows - 3;
  const buttonLeft = 2 + inner - HAND_OVER.length;

  useInput(
    (input, key) => {
      if (input.startsWith("[<")) {
        for (const e of parseMouse(input)) {
          if (e.kind === "click" && e.y === buttonRow && e.x >= buttonLeft && e.x < buttonLeft + HAND_OVER.length) return submit();
          if (e.kind === "wheel" && focus === "text") setCursor(rowStep(draft.text, cursor, room, e.delta * 3));
        }
        return;
      }
      if (input === "[I" || input === "[O") return;
      if (key.ctrl && input === "s") return submit();
      if (key.meta && (input === "v" || input === "V")) return pasteImage();
      if (key.tab) return cycle(key.shift ? -1 : 1);
      if (focus === "button") {
        if (key.escape) return setFocus("text");
        if (key.return || input === " ") return submit();
        return;
      }
      if (focus === "images") {
        if (key.escape) return setFocus("text");
        if (key.upArrow) return setSelected(Math.max(0, sel - 1));
        if (key.downArrow) return setSelected(Math.min(images.length - 1, sel + 1));
        const image = images[sel];
        if (!image) return;
        if (key.return) return openInDefaultApp(image.path);
        if (input === "d" || key.delete) {
          const next = removeImage(draft, image.n);
          setDraft(next, Math.min(cursor, next.text.length));
          setMessage(`removed ${placeholder(image.n)}`);
          if (next.images.length === 0) setFocus("text");
        }
        return;
      }
      if (key.escape) return cancel();
      if (isCtrlEnter(input, key)) return submit();
      if (key.return) return insert("\n");
      if (key.upArrow || key.downArrow) return setCursor(rowStep(draft.text, cursor, room, key.upArrow ? -1 : 1));
      if (key.pageUp || key.pageDown) return setCursor(rowStep(draft.text, cursor, room, (key.pageUp ? -1 : 1) * textRows));
      if (key.home) return setCursor(key.ctrl ? 0 : rows[row]!.start);
      if (key.end) return setCursor(key.ctrl ? draft.text.length : rows[row]!.start + rows[row]!.text.length);
      if (key.ctrl && (key.leftArrow || key.rightArrow)) return setCursor(wordStep(draft.text, cursor, key.leftArrow ? -1 : 1));
      // Backspace right after a placeholder takes the whole of it; the image stays listed.
      if (key.backspace) {
        const hit = /\[Image #\d+\]$/.exec(draft.text.slice(0, cursor));
        if (hit) return edit(draft.text.slice(0, hit.index) + draft.text.slice(cursor), hit.index);
      }
      const line: LineState = { text: draft.text, cursor, selected: false };
      const next = editLine(line, input, key);
      if (next !== line) edit(next.text, next.cursor);
    },
    { isActive: active },
  );
  // Windows Terminal pastes Ctrl+V itself: text arrives as a paste, an image as nothing (or an empty paste).
  usePaste(
    (text) => {
      if (!text.trim()) return pasteImage();
      if (focus === "text") insert(pastable(text));
    },
    { isActive: active },
  );

  const tmux = detectTerminal() === "tmux";
  const handKeys = tmux ? "^S" : "^Enter/^S";
  const help: [string, string][] =
    focus === "images"
      ? [["↑↓", "choose"], ["Enter", "open"], ["d", "remove"], ["Tab", "button"], ["Esc", "text"]]
      : focus === "button"
        ? [["Enter", "hand over"], ["Tab", "text"], ["Esc", "text"]]
        : [["Enter", "new line"], [handKeys, "hand over"], ["Alt+V", "image"], ["Tab", images.length > 0 ? "images" : "button"], ["Esc", "close, keep"]];
  const lineNo = `line ${draft.text.slice(0, cursor).split("\n").length}/${draft.text.split("\n").length}`;
  const status = message ?? [lineNo, `${draft.text.length} chars`, images.length > 0 ? `${images.length} ${images.length === 1 ? "image" : "images"}` : ""].filter(Boolean).join(" · ");
  const statusRoom = Math.max(0, inner - HAND_OVER.length - 1);
  const imageFirst = Math.max(0, Math.min(sel - Math.floor(IMAGE_ROWS / 2), images.length - IMAGE_ROWS));

  return (
    <Box
      width={layout.columns}
      height={layout.rows}
      flexDirection="column"
      borderStyle="round"
      borderColor={focus === "text" ? "cyan" : "gray"}
      backgroundColor="#1b1f27"
      paddingX={1}
      overflow="hidden"
    >
      <Text bold color="cyan" wrap="truncate">
        {title}
      </Text>
      <Text dimColor wrap="truncate">
        {detail}
      </Text>
      {Array.from({ length: textRows }, (_, i) => {
        const at = first + i;
        const r = rows[at];
        if (!r) return <Text key={i}> </Text>;
        const lead = <Text color="yellow">{at === 0 ? "› " : "  "}</Text>;
        if (at !== row || focus !== "text")
          return (
            <Text key={i} wrap="truncate">
              {lead}
              <Painted text={r.text} />
            </Text>
          );
        const rest = r.text.slice(column);
        const char = [...graphemes.segment(rest)][0]?.segment ?? "";
        return (
          <Text key={i} wrap="truncate">
            {lead}
            <Painted text={r.text.slice(0, column)} />
            <Text inverse>{char || " "}</Text>
            <Painted text={rest.slice(char.length)} />
          </Text>
        );
      })}
      {images.length > 0 && (
        <Text wrap="truncate" color={focus === "images" ? "magenta" : undefined} dimColor={focus !== "images"}>
          {`⎘ ${images.length} ${images.length === 1 ? "image" : "images"}`}
          {focus === "images" ? "" : `: ${images.map((i) => `#${i.n}`).join(" ")} · Tab to list them`}
        </Text>
      )}
      {focus === "images" &&
        images.slice(imageFirst, imageFirst + IMAGE_ROWS).map((image, i) => {
          const at = imageFirst + i === sel;
          return (
            <Text key={image.n} wrap="truncate" inverse={at} dimColor={!at && !inText.has(image.n)}>
              {at ? "▶ " : "  "}
              {imageLine(image, inText.has(image.n))}
            </Text>
          );
        })}
      <Box>
        <Box width={statusRoom}>
          <Text wrap="truncate" dimColor={!message} color={message ? "yellow" : undefined}>
            {status}
          </Text>
        </Box>
        <Text> </Text>
        <Text inverse={focus === "button"} color="green" bold>
          {HAND_OVER}
        </Text>
      </Box>
      <Text wrap="truncate">
        {help.map(([k, what], i) => (
          <Text key={i}>
            <Text color="yellow">{k}</Text> {what}
            {"  "}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
