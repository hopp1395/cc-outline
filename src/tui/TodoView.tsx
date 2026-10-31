import { Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import { renderMarkdown } from "../render/markdown.js";
import { itemTitle, moveItem, newList, progress, readTodos, subscribeTodos, updateTodos, type TodoItem, type TodoList, type TodoStatus } from "../todos.js";
import { ConfirmDialog, type Confirmation } from "./ConfirmDialog.js";
import { FocusContext, useFocused } from "./focus.js";
import { haystack } from "../filter.js";
import { bold, dim, EntryText, flipOrder, handleNavigation, List, markFooter, markKeys, orderFooter, previewHeader, rule, Screen, Star, truncate, type Layout } from "./layout.js";
import { useFavorites } from "./useFavorites.js";
import { useListFilter } from "./useListFilter.js";
import { usePositions } from "./usePositions.js";
import { useSetting } from "./useSetting.js";
import { PromptDialog } from "./PromptDialog.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";
import { useReload } from "./reload.js";

interface Props {
  cwd: string;
  layout: Layout;
  active: boolean;
  /** Why an item cannot be sent to Claude Code (nothing to type into); undefined when it can. */
  blocked?: string;
  /** Claude works on a prompt now: sending asks first. */
  busy: boolean;
  /** Types the text into Claude Code's prompt line and sends it; resolves with what to tell the user. */
  send: (text: string) => Promise<string>;
  /** A dialog opened or closed: App ignores its keys meanwhile. */
  onModal?: (open: boolean) => void;
  /** A list to go to with its first item active, as it was just made (`n` tells one request from the next). */
  goTo?: { id: string; n: number };
}

const STATUS: Record<TodoStatus, { icon: string; ansi: string; label: string }> = {
  open: { icon: "○", ansi: "2", label: "open" },
  doing: { icon: "◐", ansi: "33", label: "sent to Claude" },
  done: { icon: "✓", ansi: "32", label: "done" },
};

const color = (ansi: string, s: string) => `\u001b[${ansi}m${s}\u001b[39m\u001b[22m`;

/** The lines of a list's items; the selected item shows its whole text below its title. Returns where each item starts. */
export function itemLines(
  items: TodoItem[],
  selected: number | undefined,
  width: number,
  /** The items have the keys: the selected item's text is open below its title. Else it is closed. */
  open: boolean,
  /** The selected title is shown as the lists show a selection (the window has the focus too); else in quiet grey. */
  hot: boolean,
): { lines: string[]; starts: number[] } {
  const lines: string[] = [];
  const starts: number[] = [];
  const digits = String(items.length).length;
  items.forEach((item, i) => {
    // A blank line sets the items apart.
    if (i > 0) lines.push("");
    starts.push(lines.length);
    const status = STATUS[item.status];
    const title = truncate(itemTitle(item.text), width - digits - 6);
    if (i === selected) {
      // The title spans the column, as the selection of a list does.
      const plain = `${status.icon} ${String(i + 1).padStart(digits)}. ${title}`;
      const row = plain + " ".repeat(Math.max(0, width - stringWidth(plain)));
      lines.push(hot ? `\u001b[7;1m${row}\u001b[27;22m` : `\u001b[48;2;58;61;65m${row}\u001b[49m`);
    } else {
      lines.push(`${color(status.ansi, status.icon)} ${dim(`${String(i + 1).padStart(digits)}.`)} ${item.status === "done" ? dim(title) : title}`);
    }
    if (i === selected && open) {
      const body = item.text.split("\n").slice(1).join("\n").trim();
      const first = item.text.split("\n")[0]!;
      // The title line is a heading or the point's first line; the rest, and the whole of a long first line, below.
      const rest = itemTitle(first).length < first.replace(/^#{1,6}\s+/, "").length || body ? item.text : "";
      if (rest) for (const l of renderMarkdown(rest, width - 5, true)) lines.push("     " + l);
    }
  });
  return { lines, starts };
}

/** The project's to-do lists, read again when one is changed here. */
function useTodos(cwd: string): TodoList[] {
  const [lists, setLists] = useState(() => readTodos(cwd));
  const { count } = useReload();
  useEffect(() => {
    const read = () => setLists(readTodos(cwd));
    read();
    return subscribeTodos(read);
  }, [cwd, count]);
  return lists;
}

type Dialog =
  | { kind: "edit"; title: string; text: string; apply: (text: string) => void }
  | { kind: "confirm"; confirmation: Confirmation };

export function TodoView({ cwd, layout, active, blocked, busy, send, onModal, goTo }: Props) {
  const lists = useTodos(cwd);
  const focused = useFocused();
  const { listWidth, previewWidth, bodyHeight, headerHeight = bodyHeight, listHeight = bodyHeight } = layout;
  const [selected, setSelected] = useState(0);
  const [inItems, setInItems] = useState(false);
  const [item, setItem] = useState(0);
  const [dialog, setDialog] = useState<Dialog>();
  const [typing, setTyping] = useState(false);
  const [flash, setFlash] = useState<string>();
  const [top, setTop] = useState(0);
  const [order, setOrder] = useSetting("todoOrder");
  const reversed = order === "newest-first";

  const index = Math.max(0, Math.min(selected, lists.length - 1));
  // Marked lists of the project, by list id.
  const favorites = useFavorites(cwd, "todos");
  const markedCount = lists.filter((l) => favorites.isMarked(l.id)).length;
  // The selected list, and each list's selected item, survive restarting the viewer.
  const positions = usePositions(cwd, "todo");
  const itemKey = (l: TodoList) => `${l.id}#item`;
  // A list is found by its name; its details are the texts of its items.
  const filter = useListFilter({
    items: lists,
    text: (l) => ({ list: l.name, details: haystack([l.name, ...l.items.map((i) => i.text)]) }),
    selected: index,
    select: (i) => selectList(i),
    reversed,
    layout,
    onTyping: setTyping,
    marked: (l) => favorites.isMarked(l.id),
    restoreCopy: positions.pinned ? (l) => l.id === positions.selected : undefined,
  });
  const list = filter.none ? undefined : lists[index];
  const itemIndex = list ? Math.max(0, Math.min(item, list.items.length - 1)) : 0;
  const current = list?.items[itemIndex];

  useEffect(() => onModal?.(dialog !== undefined || typing), [dialog !== undefined, typing]);
  const restored = useRef(false);
  const justRestored = useRef(false);
  // A list just made: selected, with the keys in its items and the first one active, so Enter sends it.
  const went = useRef<number>(undefined);
  useEffect(() => {
    if (!goTo || went.current === goTo.n) return;
    const at = lists.findIndex((l) => l.id === goTo.id);
    if (at < 0) return;
    went.current = goTo.n;
    restored.current = true;
    setSelected(at);
    setItem(0);
    setInItems(true);
  }, [goTo, lists]);
  // Once the lists are there: back to the list and item selected last time.
  useEffect(() => {
    if (restored.current || lists.length === 0) return;
    restored.current = true;
    const at = lists.findIndex((l) => l.id === positions.selected);
    if (at < 0) return;
    justRestored.current = true;
    setSelected(at);
    setItem(positions.get(itemKey(lists[at]!)));
  }, [lists.length]);
  useEffect(() => {
    // The commit that restored the selection still shows the old one; the next saves the restored one.
    if (!restored.current || justRestored.current) {
      justRestored.current = false;
      return;
    }
    if (list) positions.select(list.id, false, filter.copySelected);
  }, [list?.id, filter.copySelected]);
  useEffect(() => {
    if (restored.current && list) positions.set(itemKey(list), itemIndex);
  }, [list?.id, itemIndex]);
  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(undefined), 2500);
  };

  const change = (fn: (list: TodoList) => TodoList) => {
    if (!list) return;
    updateTodos(cwd, (all) => all.map((l) => (l.id === list.id ? fn(l) : l)));
  };
  const setStatus = (status: TodoStatus) => current && change((l) => ({ ...l, items: l.items.map((i) => (i.id === current.id ? { ...i, status } : i)) }));

  const sendCurrent = () => {
    if (!current) return;
    const go = () => {
      setStatus("doing");
      void send(current.text).then(notify);
    };
    if (blocked) return notify(blocked);
    if (busy) {
      return setDialog({
        kind: "confirm",
        confirmation: { title: "Claude is still working", lines: ["Send this item anyway? Claude Code queues it behind the current prompt."], onConfirm: go },
      });
    }
    go();
  };

  const rendered = useMemo(() => itemLines(list?.items ?? [], itemIndex, previewWidth, inItems, inItems && focused), [list, inItems, focused, itemIndex, previewWidth]);
  const header = useMemo(() => {
    if (!list) return [];
    const { done, total } = progress(list);
    const details = [`${done}/${total} done · made ${new Date(list.created).toLocaleDateString()}${list.sessionId ? ` · session ${list.sessionId.slice(0, 8)}` : ""}`];
    const full = previewHeader(list.name, previewWidth, { marker: color("36", "☰") + " ", style: bold, details });
    const fitted = fitHeader(full, headerHeight);
    const label = inItems ? "↵ send · ␣ done · esc lists" : "↵ items";
    return [...fitted.slice(0, -1), rule(previewWidth, label)];
  }, [list, previewWidth, headerHeight, inItems]);
  const viewport = bodyHeightBelow(header, bodyHeight);

  // The selected item stays in view.
  useEffect(() => {
    const start = rendered.starts[itemIndex] ?? 0;
    const end = (rendered.starts[itemIndex + 1] ?? rendered.lines.length) - 1;
    setTop((t) => (start < t ? start : end >= t + viewport ? Math.max(0, Math.min(start, end - viewport + 1)) : t));
  }, [inItems, itemIndex, rendered, viewport]);
  const maxTop = Math.max(0, rendered.lines.length - viewport);

  const selectList = (next: number) => {
    const at = Math.max(0, Math.min(lists.length - 1, next));
    setSelected(at);
    // Each list keeps its selected item.
    setItem(lists[at] ? positions.get(itemKey(lists[at]!)) : 0);
  };
  const selectItem = (next: number) => list && setItem(Math.max(0, Math.min(list.items.length - 1, next)));

  const rename = () =>
    list &&
    setDialog({ kind: "edit", title: "Rename the list", text: list.name, apply: (text) => change((l) => ({ ...l, name: text.split("\n")[0]!.trim() || l.name })) });
  const removeList = () =>
    list &&
    setDialog({
      kind: "confirm",
      confirmation: {
        title: `Delete the list "${truncate(list.name, 40)}"?`,
        lines: [`${list.items.length} items, ${progress(list).done} done. This cannot be undone.`],
        danger: true,
        onConfirm: () => {
          updateTodos(cwd, (all) => all.filter((l) => l.id !== list.id));
          setInItems(false);
        },
      },
    });
  const addItem = () => list && setDialog({ kind: "edit", title: "New item", text: "", apply: (text) => change((l) => ({ ...l, items: [...l.items, ...newList("", [{ text }]).items] })) });
  const editItem = () =>
    current &&
    setDialog({ kind: "edit", title: "Edit the item", text: current.text, apply: (text) => change((l) => ({ ...l, items: l.items.map((i) => (i.id === current.id ? { ...i, text } : i)) })) });
  const removeItem = () =>
    list &&
    current &&
    setDialog({
      kind: "confirm",
      confirmation: {
        title: "Delete the item?",
        lines: [truncate(itemTitle(current.text), 56)],
        danger: true,
        onConfirm: () => change((l) => ({ ...l, items: l.items.filter((i) => i.id !== current.id) })),
      },
    });

  useInput(
    (input, key) => {
      if (inItems) {
        if (key.escape) return setInItems(false);
        if (input === "J" || input === "K") {
          if (!list) return;
          const delta = input === "J" ? 1 : -1;
          change((l) => ({ ...l, items: moveItem(l.items, itemIndex, delta) }));
          return selectItem(itemIndex + delta);
        }
        const nav = { select: (d: number) => selectItem(itemIndex + d), first: () => selectItem(0), last: () => selectItem(Infinity), scroll: { by: (d: number) => setTop((t) => Math.max(0, Math.min(maxTop, t + d))), set: (n: number) => setTop(n), max: maxTop } as never, page: viewport - 2 };
        if (handleNavigation(input, key, nav)) return;
        if (key.return) return sendCurrent();
        if (input === " " || input === "x") {
          if (!current) return;
          if (current.status === "done") return setStatus("open");
          // Ticked off: on to the next item.
          setStatus("done");
          return selectItem(itemIndex + 1);
        }
        if (input === "o") return current && setStatus("open");
        if (input === "a") return addItem();
        if (input === "m") return editItem();
        if (input === "d") return removeItem();
        return;
      }
      if (filter.handleKey(input, key)) return;
      // Checked first: Shift+↑/↓ jump between marked lists.
      const mark = markKeys(input, key);
      if (mark === "toggle") {
        if (!list) return;
        if (favorites.isMarked(list.id)) filter.unmarking(index);
        return favorites.toggle(list.id);
      }
      if (mark) {
        const target = filter.nextMark(mark);
        return target !== undefined && selectList(target);
      }
      if (input === "s") return setOrder(flipOrder);
      const nav = { ...filter.nav, scroll: { by: () => {}, set: () => {}, max: 0 } as never, page: 1 };
      if (handleNavigation(input, key, nav)) return;
      if (key.return && list) return setInItems(true);
      if (input === "m") return rename();
      if (input === "d") return removeList();
    },
    { isActive: active && !dialog && !filter.open },
  );

  const done = lists.reduce((n, l) => n + progress(l).done, 0);
  const total = lists.reduce((n, l) => n + progress(l).total, 0);

  let preview;
  if (!list) preview = <Text dimColor>No to-do lists yet. In Chat, T makes one from the answer of the selected turn.</Text>;
  else if (list.items.length === 0) preview = <Text dimColor>No items. a adds one.</Text>;
  else
    preview = (
      <Preview
        header={header}
        lines={rendered.lines}
        scroll={top}
        width={previewWidth}
        height={bodyHeight}
        onWheel={(d) => setTop((t) => Math.max(0, Math.min(maxTop, t + d)))}
        onLineClick={(line) => {
          const at = rendered.starts.findIndex((s, i) => line >= s && line < (rendered.starts[i + 1] ?? Infinity));
          if (at < 0) return;
          setInItems(true);
          selectItem(at);
        }}
      />
    );

  return (
    <>
      <Screen
        layout={layout}
        mode="todo"
        status={
          <Text dimColor={!focused}>
            {filter.count(lists.length)} {lists.length === 1 ? "list" : "lists"}
            {total > 0 && ` · ${done}/${total} done`}
            {markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
          </Text>
        }
        list={
          // The selected list is quiet grey while the items have the keys.
          <FocusContext.Provider value={focused && !inItems}>
          <List
            reversed={reversed}
            onPick={(i) => {
              selectList(i);
              setInItems(false);
            }}
            items={lists}
            shown={filter.shown}
            pinned={filter.pinned}
            filter={filter.banner}
            selected={index}
            height={listHeight}
            empty={filter.empty ?? "No lists yet"}
            itemKey={(l) => l.id}
            time={(l) => l.created}
            render={(l, isSelected) => {
              const p = progress(l);
              const marked = favorites.isMarked(l.id);
              const tail = ` ${p.done}/${p.total}`;
              // A list being worked off shows the item's ◐: one sent to Claude, or some done and some open.
              const working = l.items.some((i) => i.status === "doing") || (p.done > 0 && p.done < p.total);
              return (
                <>
                  {marked && <Star />}
                  {working ? (
                    <Text color="yellow">{"◐ "}</Text>
                  ) : (
                    <Text color={p.total > 0 && p.done === p.total ? "green" : undefined}>{p.total > 0 && p.done === p.total ? "✓ " : "☰ "}</Text>
                  )}
                  <EntryText text={l.name} width={Math.max(4, listWidth - 4 - tail.length - (marked ? 2 : 0))} selected={isSelected} active={active && !inItems} />
                  <Text dimColor>{tail}</Text>
                </>
              );
            }}
          />
          </FocusContext.Provider>
        }
        preview={preview}
        footer={
          flash ??
          (inItems
            ? [
                { text: "↑↓ item", priority: 4 },
                { text: "↵ send", priority: 4 },
                { text: "␣ done+next", priority: 4 },
                { text: "o open", priority: 1 },
                { text: "a add", priority: 2 },
                { text: "m edit", priority: 2 },
                { text: "d delete", priority: 2 },
                { text: "⇧J/K move", priority: 1 },
                { text: "Esc lists", priority: 3 },
              ]
            : [
                { text: "↑↓ list", priority: 4 },
                { text: "↵ items", priority: 4 },
                orderFooter(order, "oldest-first"),
                ...markFooter(favorites.isMarked(list?.id), markedCount),
                ...filter.footer,
                { text: "m rename", priority: 2 },
                { text: "d delete", priority: 2 },
                { text: "1-7/tab view", priority: 1 },
              ])
        }
      />
      {filter.dialog}
      {dialog?.kind === "edit" && (
        <PromptDialog
          layout={layout}
          title={dialog.title}
          lines={[list ? truncate(list.name, 60) : ""]}
          draftKey="todo"
          initialText={dialog.text}
          onCancel={() => setDialog(undefined)}
          onSend={(text) => {
            setDialog(undefined);
            dialog.apply(text);
          }}
        />
      )}
      {dialog?.kind === "confirm" && <ConfirmDialog layout={layout} confirmation={dialog.confirmation} onClose={() => setDialog(undefined)} />}
    </>
  );
}
