# To-do lists

A to-do list is a work plan cut out of one of Claude's answers (blocks of an implementation plan, say), worked off item by item: each item is sent to Claude Code on its own and ticked off by hand. Code: `src/todos.ts` (model, cutting, storage), `src/tui/TodoView.tsx` (view `todo`, key `7`), `src/tui/TodoCreateDialog.tsx` (`T` in Chat).

## Storage

`~/.claude/cco/<slug>.todos.json` (`todosFile` in `locate.ts`), `{ lists: TodoList[] }`, one file per project, written atomically by `writeTodos`. Every list of the project shows in the view, whichever session made it; a list remembers `sessionId` and `turnId` of its origin (shown in the header; jumping back to the turn is not built yet). `readTodos` checks every shape and drops what does not fit (an unknown status becomes `open`). `updateTodos(cwd, fn)` reads, changes and writes; `subscribeTodos` tells the views of this process, which is how Chat's new list reaches the Todo view. Other processes are not watched: `F5` reads again.

An item is `{ id, text, status }`; `text` is the block's Markdown with its sub-points, the title in the list is its first line without emphasis (`itemTitle`). Status is `open`, `doing` (sent to Claude) or `done`; only the user ticks `done`, nothing derives it from the transcript.

## Cutting an answer into blocks

`findBlocks(markdown)` runs marked's lexer over the answer (the text blocks of the selected turn joined) and returns the cuts that exist, each needing at least two blocks: `numbered` (the first top-level ordered list), `headings` (the deepest level used at least twice; a block runs to the next heading of that level, deeper headings stay inside it), `labels` (paragraphs that are only bold text, "**Block 1: Resources**", each with what follows up to the next one: how Claude often writes work blocks, with bullet points below), `bullets` (the first unordered list). `firstSource` prefers them in that order, so the bullets inside labelled blocks are not taken for the blocks; the dialog's `s` steps through the others, Space leaves a block out. Items are flat: sub-points belong to their block's text.

## The view

Screen with the lists left (name, `done/total`) and the items right (`Preview` with the list as header). `Enter` on a list moves the keys to its items (`inItems`), `Esc` back; `←`/`→`/`Tab` still switch views. In the items: `Enter` sends, `Space`/`x` ticks, `o` reopens, `a` adds, `m` edits, `d` deletes (asks), `J`/`K` move; in the lists `m` renames and `d` deletes (asks). The selected item shows its whole text below its title (`itemLines`). Text is entered in `PromptDialog` (its `initialText` overrides the draft).

## Sending

`Enter` on an item calls `send(text)` of the view; `App` implements it with `keysInClaude(claudePid, promptSteps(text))`, the prompt line's way of typing and submitting (`docs/dev/features.md`, prompt editor), then `focusClaude`. The text is the item's block as it is, no wrapper. `doing` is set before sending. While Claude works (`working` of the transcript) a `ConfirmDialog` asks first; Claude Code queues the prompt. Where nothing can be typed into (`!types`: a session viewer, no Claude Code beside the viewer) `blocked` says why and nothing is sent. The Todo view and `T` exist only in the project's viewer: `isViewShown` is false in session viewers and the Remote Control Viewer.

## Settings and numbers

`viewTodo` (tab) and `todoListWidth`. The tab is `7 Todo`, after Settings, so the other numbers stay; `TAB_ORDER` has it last as well. `cco open --view todo` and `/cco:todo` open it.
