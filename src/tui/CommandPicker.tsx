import { Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { remoteCommands } from "../remote/commands.js";
import { commandQuery, matchCommands, modifiedAt, sessionCommands, takeCommand, type CommandSource, type SlashCommand } from "../slashCommands.js";

/** The rows the list takes at most; more matches scroll with the selection. */
export const PICKER_ROWS = 8;
/** A remote session's commands are asked for again after this long, when the list opens. */
const REMOTE_FRESH_MS = 5 * 60 * 1000;

/** The commands read last per source, kept while its transcript is unchanged (a remote session's for a while). */
const read = new Map<string, { at: number; commands: Promise<SlashCommand[]> }>();

const keyOf = (source: CommandSource) => ("remoteId" in source ? `remote|${source.remoteId}` : `${source.configDir}|${source.cwd}|${source.transcript ?? ""}`);

/** The commands of `source`, read when `wanted` turns true (the list opens) and again once its transcript changed. */
function useSlashCommands(source: CommandSource | undefined, wanted: boolean): SlashCommand[] | undefined {
  const [commands, setCommands] = useState<{ key: string; list: SlashCommand[] }>();
  const key = source ? keyOf(source) : undefined;
  useEffect(() => {
    if (!wanted || !source || !key) return;
    const remote = "remoteId" in source;
    const at = remote ? Math.floor(Date.now() / REMOTE_FRESH_MS) : modifiedAt(source.transcript);
    let entry = read.get(key);
    if (!entry || entry.at !== at) {
      entry = { at, commands: remote ? remoteCommands(source.remoteId) : sessionCommands(source) };
      read.set(key, entry);
    }
    const asked = entry;
    let live = true;
    asked.commands.then(
      (list) => live && setCommands({ key, list }),
      () => {
        // Not kept: the next opening asks again (claude.ai did not answer, the login expired).
        if (read.get(key) === asked) read.delete(key);
        if (live) setCommands({ key, list: [] });
      },
    );
    return () => {
      live = false;
    };
  }, [wanted, key]);
  return commands && commands.key === key ? commands.list : undefined;
}

export interface CommandPicker {
  /** The list shows: the prompt is a command name being typed, it has matches and was not closed with Esc. */
  open: boolean;
  matches: SlashCommand[];
  selected: number;
  /** One step up (`-1`) or down; wraps around. */
  move(step: number): void;
  /** The prompt with the selected (or the `index`th) command taken in. */
  take(index?: number): { text: string; cursor: number };
  /** Esc: closed until the name typed changes. */
  close(): void;
}

/**
 * The `/` list of a prompt line: while the prompt starts with `/` and the cursor is in the command's name, the
 * commands of the session (`source`; none without one, such as a remote session) whose name holds what is typed.
 */
export function useCommandPicker(text: string, cursor: number, source: CommandSource | undefined): CommandPicker {
  const query = source ? commandQuery(text, cursor) : undefined;
  const commands = useSlashCommands(source, query !== undefined);
  const [selected, setSelected] = useState(0);
  const [closedAt, setClosedAt] = useState<string>();
  const matches = query !== undefined && commands ? matchCommands(commands, query) : [];
  // Another name typed: the best match is selected again, and a list closed with Esc opens again.
  const last = useRef(query);
  if (last.current !== query) {
    last.current = query;
    if (selected !== 0) setSelected(0);
    if (closedAt !== undefined && closedAt !== query) setClosedAt(undefined);
  }
  const at = Math.min(selected, Math.max(0, matches.length - 1));
  return {
    open: query !== undefined && matches.length > 0 && closedAt !== query,
    matches,
    selected: at,
    move: (step) => setSelected((at + step + matches.length) % Math.max(1, matches.length)),
    take: (index = at) => takeCommand(text, matches[index]!.name),
    close: () => setClosedAt(query),
  };
}

/** The first match the list shows, so the selected one is in it. */
export function pickerFirst(picker: CommandPicker): number {
  return Math.max(0, Math.min(picker.selected - Math.floor(PICKER_ROWS / 2), picker.matches.length - PICKER_ROWS));
}

/** The rows `CommandList` takes for `picker`. */
export const pickerRows = (picker: CommandPicker) => (picker.open ? Math.min(PICKER_ROWS, picker.matches.length) : 0);

/** The list of `picker`: per command its name, its argument hint and its description, dimmed, cut to `width`. */
export function CommandList({ picker, width, active = true }: { picker: CommandPicker; width: number; active?: boolean }) {
  if (!picker.open) return null;
  const first = pickerFirst(picker);
  const shown = picker.matches.slice(first, first + PICKER_ROWS);
  const nameWidth = Math.min(Math.max(...shown.map((c) => c.name.length + 1)), Math.floor(width / 2));
  return (
    <>
      {shown.map((c, i) => {
        const at = first + i === picker.selected;
        const name = `/${c.name}`;
        return (
          <Text key={c.name} wrap="truncate">
            <Text color={at && active ? "cyan" : undefined} bold={at} inverse={at && active}>
              {name.padEnd(nameWidth)}
            </Text>
            {"  "}
            {c.argumentHint && <Text color="yellow" dimColor>{`${c.argumentHint}  `}</Text>}
            <Text dimColor>{c.description.slice(0, width * 2)}</Text>
          </Text>
        );
      })}
    </>
  );
}
