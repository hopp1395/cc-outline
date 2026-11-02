# To-do lists

A to-do list is a work plan cut out of one of Claude's answers (blocks of an implementation plan, say), worked off item by item: each item is sent to Claude Code on its own and ticked off by hand. Code: `src/todos.ts` (model, storage), `src/todoBlocks.ts` (Claude finds the blocks), `src/tui/TodoView.tsx` (view `todo`, key `7`), `src/tui/TodoCreateDialog.tsx` (`T` in Chat).

## Storage

`~/.claude/cco/<slug>.todos.json` (`todosFile` in `locate.ts`), `{ lists: TodoList[] }`, one file per project, written atomically by `writeTodos`. Every list of the project shows in the view, whichever session made it; a list remembers `sessionId` and `turnId` of its origin (shown in the header; jumping back to the turn is not built yet). `readTodos` checks every shape and drops what does not fit (an unknown status becomes `open`). `updateTodos(cwd, fn)` reads, changes and writes; `subscribeTodos` tells the views of this process, which is how Chat's new list reaches the Todo view. Other processes are not watched: `F5` reads again.

An item is `{ id, text, status }`; `text` is the block's Markdown with its sub-points, the title in the list is its first line without emphasis (`itemTitle`). Status is `open`, `doing` (sent to Claude) or `done`; only the user ticks `done`, nothing derives it from the transcript.

## Cutting an answer into blocks

`T` has Claude find the work blocks (`askBlocks`): the only place where the viewer runs Claude and spends the account's usage (about 0.1 cents a run with Haiku, 8 to 20 s), and only when the user asks. It used to be a parser with an order of cuts (numbered list, headings, bold labels, table, bullets), which took the questions at the end of an answer for the plan and could not see a plan spread over two tables; the shapes Claude writes a plan in are too many to rank.

The run gets the answer (the text blocks of the selected turn joined, as they were when the dialog opened) on stdin. `blocksArgs` makes it leave no trace: `-p --no-session-persistence` (no transcript for Sessions and Monitor), `--settings {"disableAllHooks":true}` (`cco hook` would make it the project's active session and could open a viewer), no tools, skills or MCP servers. `--bare` cannot be used: it reads no keychain, so no subscription login. It runs in the temp folder (no project's `CLAUDE.md`), with `independentEnv` under the viewer's config folder, through the shell on Windows (a `.cmd` shim); stopping it there takes `taskkill /t`, since killing the shell would leave claude running. `TIMING.todoBlocks` limits it to 60 s. Under an API profile the model name `haiku` may not exist: the dialog then shows the error.

`--json-schema` makes it return `{ blocks: [{ title, section, text }] }`, checked by `parseBlocks`. An item's text is the title, the section (only where the blocks stand under more than one heading, a decision of `blockText`, not of the model), then the rest; items are flat. The prompt asks for titles as written (with "Block 2:", since blocks refer to each other that way), and for a table row's cells as `Column: value` lines. Nothing checks that the text is word for word: on 16 real answers no word was foreign, and the Todo view shows the whole text before it is sent. On answers that hold no plan the result varies between runs (nothing, or the steps it finds); that is why the dialog comes before the list.

The dialog stays open during the run with the seconds passed (its own, not the `ProgressDialog`: the same dialog goes on with the selection): `Esc` stops the run, afterwards `↑↓`, `Space` leaves a block out, `Enter` makes the list, `r` asks again. Found blocks are remembered per answer while the viewer runs (`rememberedBlocks`), so `T` again costs nothing; errors and empty results are not. Tests fake the run through `proc.spawn` (`test/helpers/fakeClaude.ts`) and never call Claude; after a change of the prompt, try it on real answers.

## The view

After `T` made a list, the dialog closes and `App` switches to the Todo view (`onTodoMade` of `ChatView`, `todoGoTo` state, `goTo` prop of `TodoView`): the new list is selected and the keys are already in its items with the first one active, so one `Enter` sends it. `goTo.n` tells one request from the next; the effect waits until the list is in the view's state (`subscribeTodos` delivers it).

Screen with the lists left (name, `done/total`; `◐` in yellow instead of `☰` while an item is `doing` or some are done and some open, `✓` once all are done) and the items right (`Preview` with the list as header). `Enter` on a list moves the keys to its items (`inItems`), `Esc` back; `←`/`→`/`Tab` still switch views. In the items: `Enter` sends, `Space`/`x` ticks and goes on to the next item (on a done item it opens it again), `o` reopens, `a` adds, `m` edits, `d` deletes (asks), `J`/`K` move; in the lists `m` renames and `d` deletes (asks). The selected item shows its whole text below its title (`itemLines`). Text is entered in `PromptDialog` (its `initialText` overrides the draft).

## List features

The lists column has what the other views' lists have, as in `PlanView`: marks (`Space` in the lists, `Shift+↑↓` between marked ones, favorites kind `todos`, ★, `pinnedFavorites`), the filter (`Ctrl+F`, by name; `filterIn` details also by the items' texts), the order (`s`, setting `todoOrder`), date separators (`List` `time` = `created`) and the remembered selection (`usePositions` list `todo`: the selected list's id as the selection, each list's selected item as the scroll value of `<id>#item`). These keys work while the lists have the keys; in the items `Space` ticks.

## Sending

`Enter` on an item calls `send(text)` of the view; `App` implements it with `keysInClaude(claudePid, promptSteps(text))`, the prompt line's way of typing and submitting (`docs/dev/features.md`, prompt editor), and the focus stays in the viewer (no `focusClaude`, unlike the prompt editor), so the next item is one `Enter` away. The text is the item's block as it is, no wrapper. `doing` is set before sending. While Claude works (`working` of the transcript) a `ConfirmDialog` asks first; Claude Code queues the prompt. Where nothing can be typed into (`!types`: a session viewer, no Claude Code beside the viewer) `blocked` says why and nothing is sent. The Todo view and `T` exist only in the project's viewer: `isViewShown` is false in session viewers and the Remote Control Viewer.

## Settings and numbers

`viewTodo` (tab) and `todoListWidth`. The tab is `7 Todo`, after Settings, so the other numbers stay; `TAB_ORDER` has it last as well. `cco open --view todo` and `/cco:todo` open it.
