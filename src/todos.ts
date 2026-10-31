import { randomUUID } from "node:crypto";
import { Lexer, type Token, type Tokens } from "marked";
import { readJson, todosFile, writeJson } from "./transcript/locate.js";

/** Where an item stands: not started, sent to Claude, or ticked off by the user. */
export type TodoStatus = "open" | "doing" | "done";

export interface TodoItem {
  id: string;
  /** The block's text (Markdown, as Claude wrote it, sub-points included). */
  text: string;
  status: TodoStatus;
}

export interface TodoList {
  id: string;
  name: string;
  items: TodoItem[];
  created: string;
  /** The session and the answer (turn id) the list was made from, to jump back to the chat. */
  sessionId?: string;
  turnId?: string;
}

/** How an answer was cut into blocks. */
export type BlockSource = "numbered" | "headings" | "labels" | "table" | "bullets";

export const BLOCK_SOURCES: readonly BlockSource[] = ["numbered", "headings", "labels", "table", "bullets"];

/** One block found in an answer. */
export interface Block {
  text: string;
}

const isList = (t: Token): t is Tokens.List => t.type === "list";

/** The Markdown of a list's items, one block each (the item's own text and its sub-points). */
function listBlocks(list: Tokens.List): Block[] {
  return list.items.map((item) => ({ text: item.raw.replace(/^\s*(?:\d+[.)]|[-*+])\s+(?:\[[ xX]\]\s+)?/, "").replace(/\n {2,4}/g, "\n").trim() })).filter((b) => b.text);
}

/** Blocks per source for `markdown`; a source that finds nothing is missing. */
export function findBlocks(markdown: string): Partial<Record<BlockSource, Block[]>> {
  const tokens = new Lexer().lex(markdown);
  const found: Partial<Record<BlockSource, Block[]>> = {};
  // The first top-level list of each kind that has at least two items.
  const numbered = tokens.find((t): t is Tokens.List => isList(t) && t.ordered && t.items.length >= 2);
  if (numbered) found.numbered = listBlocks(numbered);
  const bullets = tokens.find((t): t is Tokens.List => isList(t) && !t.ordered && t.items.length >= 2);
  if (bullets) found.bullets = listBlocks(bullets);
  // Headings of the deepest level used at least twice, each with what follows up to the next one of its level.
  const levels = tokens.filter((t): t is Tokens.Heading => t.type === "heading").map((t) => t.depth);
  const depth = [...new Set(levels)].sort((a, b) => b - a).find((d) => levels.filter((l) => l === d).length >= 2) ?? undefined;
  if (depth !== undefined) {
    const blocks: Block[] = [];
    let current: string[] | undefined;
    for (const t of tokens) {
      if (t.type === "heading" && (t as Tokens.Heading).depth <= depth) {
        if (current) blocks.push({ text: current.join("").trim() });
        current = (t as Tokens.Heading).depth === depth ? [t.raw] : undefined;
      } else if (current) current.push(t.raw);
    }
    if (current) blocks.push({ text: current.join("").trim() });
    found.headings = blocks.map((b) => ({ text: b.text.replace(/^#{1,6}\s+/, "") }));
  }
  // Paragraphs that are only bold text ("**Block 1: Resources**") label what follows, up to the next one.
  const label = (t: Token) => t.type === "paragraph" && /^(\*\*|__)[^\n]+\1$/.test(t.raw.trim());
  if (tokens.filter(label).length >= 2) {
    const blocks: Block[] = [];
    let current: string[] | undefined;
    for (const t of tokens) {
      if (label(t)) {
        if (current) blocks.push({ text: current.join("").trim() });
        current = [t.raw.trim().replace(/^(\*\*|__)|(\*\*|__)$/g, "") + "\n"];
      } else if (current) current.push(t.raw);
    }
    if (current) blocks.push({ text: current.join("").trim() });
    found.labels = blocks;
  }
  // A table with a row per block: the first column that is not just a number names the block, the other cells follow.
  const table = tokens.find((t): t is Tokens.Table => t.type === "table" && t.rows.length >= 2);
  if (table) {
    const numeric = (c: number) => table.rows.every((r) => /^\d+$/.test(r[c]?.text.trim() ?? ""));
    const columns = table.header.map((_, c) => c).filter((c) => !numeric(c));
    if (columns.length > 0) {
      found.table = table.rows.flatMap((r) => {
        const [title, ...rest] = columns.map((c) => (r[c]?.text ?? "").replace(/\s+/g, " ").trim());
        const text = [title, ...rest.filter(Boolean)].join("\n").trim();
        return text ? [{ text }] : [];
      });
    }
  }
  return found;
}

/** The source to start with: numbered points, else headings, else bullets. */
export function firstSource(found: Partial<Record<BlockSource, Block[]>>): BlockSource | undefined {
  return BLOCK_SOURCES.find((s) => found[s]?.length);
}

/** The first line of a block, without Markdown emphasis, for the list. */
export function itemTitle(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? text;
  return line.replace(/^#{1,6}\s+/, "").replace(/(\*\*|__|`)/g, "").trim();
}

export function newList(name: string, blocks: Block[], origin?: { sessionId?: string; turnId?: string }): TodoList {
  return {
    id: randomUUID(),
    name,
    created: new Date().toISOString(),
    items: blocks.map((b) => ({ id: randomUUID(), text: b.text, status: "open" as const })),
    ...origin,
  };
}

const STATUSES: readonly TodoStatus[] = ["open", "doing", "done"];

function sanitize(value: unknown): TodoList[] {
  const lists = (value as { lists?: unknown } | undefined)?.lists;
  if (!Array.isArray(lists)) return [];
  const out: TodoList[] = [];
  for (const l of lists as Partial<TodoList>[]) {
    if (!l || typeof l.id !== "string" || typeof l.name !== "string" || !Array.isArray(l.items)) continue;
    const items = l.items
      .filter((i): i is TodoItem => !!i && typeof i.id === "string" && typeof i.text === "string")
      .map((i) => ({ id: i.id, text: i.text, status: STATUSES.includes(i.status) ? i.status : ("open" as const) }));
    out.push({
      id: l.id,
      name: l.name,
      items,
      created: typeof l.created === "string" ? l.created : new Date(0).toISOString(),
      sessionId: typeof l.sessionId === "string" ? l.sessionId : undefined,
      turnId: typeof l.turnId === "string" ? l.turnId : undefined,
    });
  }
  return out;
}

export function readTodos(cwd: string): TodoList[] {
  return sanitize(readJson(todosFile(cwd)));
}

const listeners = new Set<() => void>();

/** Calls `fn` after the lists were changed in this process (`writeTodos`); returns the way to stop. */
export function subscribeTodos(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function writeTodos(cwd: string, lists: TodoList[]): void {
  writeJson(todosFile(cwd), { lists });
  for (const fn of listeners) fn();
}

/** Changes the project's lists on disk and returns them; `change` gets a copy. */
export function updateTodos(cwd: string, change: (lists: TodoList[]) => TodoList[]): TodoList[] {
  const next = change(readTodos(cwd));
  writeTodos(cwd, next);
  return next;
}

/** `done`/`total` of a list. */
export function progress(list: TodoList): { done: number; total: number } {
  return { done: list.items.filter((i) => i.status === "done").length, total: list.items.length };
}

/** Moves the item at `from` by `delta` places (clamped); the same array when nothing moves. */
export function moveItem<T>(items: T[], from: number, delta: number): T[] {
  const to = Math.max(0, Math.min(items.length - 1, from + delta));
  if (to === from || from < 0 || from >= items.length) return items;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
