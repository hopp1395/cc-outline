import { randomUUID } from "node:crypto";
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

/** One block found in an answer (`src/todoBlocks.ts`). */
export interface Block {
  text: string;
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
