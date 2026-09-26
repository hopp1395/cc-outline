# cc-outline

`cc-outline` (command `cco`) adds a second pane next to Claude Code in your terminal. It has two views:

- **Chat** renders the answers of the current session as proper Markdown: headings, lists, tables and code blocks with syntax highlighting. It follows the session live.
- **Changes** lists the files changed in the git repository and shows their diffs with syntax highlighting.

```
cco  1 Chat  2 Changes  session 3d061497 · 12 turns · 87% · FOLLOW
09:56 brainstorm a markdown … │ ❯ add a git changes view
10:07 create a new git repo   │ ──────────────────────────────────────────
10:08 go                      │ The view lists every changed file on the
10:31 add a git changes view  │ left and shows its diff on the right:
                              │
                              │   • ←→ switch files, ↑↓ scroll
alt+←  ←→ turn  ↵ prompt   f follow   w wrap   c copy  i more  q quit
```

## Installation

Requirements:
- Node.js 20 or later
- Claude Code
- Windows Terminal or tmux, to open the viewer in a split pane

**1. Install the CLI:**

```sh
npm install -g cc-outline
cco --version
```

**2. Install the Claude Code plugin.** It provides the hooks and the `/cco:chat` and `/cco:git` commands. The npm package is its own plugin marketplace:

```sh
claude plugin marketplace add "$(npm root -g)/cc-outline"
claude plugin install cco@cc-outline
```

**3. Restart Claude Code**, then run `/cco:chat` or `/cco:git`.

To uninstall, run `claude plugin uninstall cco@cc-outline`, `claude plugin marketplace remove cc-outline` and `npm rm -g cc-outline`, then delete `~/.claude/cco/`.

### From source

```sh
npm install
npm run build
npm link            # makes `cco` available globally
claude plugin marketplace add <path-to-this-repo>
claude plugin install cco@cc-outline
```

To load the plugin for a single session without installing it, run `claude --plugin-dir ./plugin` instead.

## Usage

- **`/cco:chat`** or **`/cco:git`** in Claude Code opens the viewer in a split pane (Windows Terminal or tmux), starting in the Chat or Changes view. If a viewer is already running for the project, the command switches it to that view instead of opening a second pane.
- **`cco`** (or `cco watch`) in a project directory starts the viewer by hand, in any terminal:
  - `--cwd <dir>`: the project whose session is shown
  - `--session <id>`: show this session instead of the active one
  - `--view chat|git`: view to start with (default: `chat`)

Both views share one layout:
- **Top bar:** the view tabs and a status summary.
- **Body:** a list on the left and a preview on the right.
- **Help line:** the keys of the current view at the bottom.

Press `1` and `2` to switch between the views. Both keep running in the background, so the chat keeps following the session while you look at the changes.

## Chat view

The Chat view shows the session turn by turn. A turn is one prompt plus everything Claude answered to it.

```
cco  1 Chat  2 Changes  session 3d061497 · 12 turns · 64% · tools
09:56 brainstorm a markdown … │ ❯ add a git changes view with syntax
10:07 create a new git repo   │   highlighting, C# first
10:08 go                      │ ── ↵ full prompt ─────────────────────────
10:12 ↳ commit everything     │ ## Changes view
10:31 add a git changes view  │
                              │ | Key | Action          |
                              │ |-----|-----------------|
                              │           ↓ Jump to bottom (ctrl+End)
alt+←  ←→ turn  ↵ prompt   f follow    t tools   w wrap   i more  q quit
```

**List (left).** One entry per prompt, with its time.
- Slash commands appear as `/name args`.
- Prompts you sent while Claude was still working are marked with `↳`. Claude Code stores these separately; cc-outline shows them as turns of their own.

**Marks.** `Space` marks the selected turn as a favourite (`★` in the list) or removes the mark.
- `]` and `[` jump to the next and previous marked turn.
- Marks are saved per session in `~/.claude/cco/<project-slug>.favorites.json`, so they survive restarts and `/resume`.

**Prompt (top right).** The selected prompt stays pinned above the answer while you scroll.
- It shows at most 1000 characters and never more than half the pane height.
- If it is cut, the separator reads `↵ full prompt`. Press `Enter` to read the whole prompt, then `Enter` or `Esc` to return to the answer.

**Answer.** The answer is rendered as Markdown and wrapped to the pane width. List items keep their indentation when they wrap.
- Tool calls (`t`) and thinking blocks (`h`) are hidden by default.
- With `w`, wrapping is switched off: paragraphs and code lines stay whole, and `Shift+←/→` scrolls sideways.
- `c` copies the turn's Markdown (without tools and thinking) to the clipboard.

**Follow mode** is on by default.
- The newest turn is selected, and the view sticks to the bottom while the answer grows, like in Claude Code.
- Scrolling up leaves follow mode. The badge `↓ Jump to bottom (ctrl+End)` then appears at the bottom of the preview. Scrolling back down to the end, `Ctrl+End` or `G` resumes following. `f` toggles follow mode directly.
- Each turn remembers where you left it scrolled. An older turn that is not scrolled to its end also shows the badge; there `Ctrl+End` jumps to the end of that answer.

**Status.** The top bar shows:
- the session id
- the number of turns
- the scroll position (`all` or a percentage)
- the active options: `FOLLOW`, `tools`, `thinking`, `nowrap`
- the number of marked turns (`★ 2`)

The viewer switches sessions automatically after `/clear` or `/resume`.

## Changes view

The Changes view shows what Claude has changed in the working tree, compared with `HEAD`.

```
cco  1 Chat  2 Changes  3 files · +48 -7 · 35%
M src/Orders/OrderService.cs  +12 -3 │ M src/Orders/OrderService.cs
A src/Orders/OrderValidator.cs  +31  │   modified · +12 -3 · diff
? docs/notes.md               +5 -0  │ ── ↵ whole file ─────────────────────
                                     │ @@ -40,7 +40,9 @@ public class Order…
                                     │ 40 40   public void Submit(Order o)
                                     │ 41 41   {
                                     │ 42    -     Save(o);
                                     │    42 +     _validator.Check(o);
                                     │    43 +     Save(o);
alt+←  ←→ file  ↵ file  [/] hunk   w wrap   r refresh  i more  q quit
```

**List (left).** One entry per changed file, with its status and line counts:
- `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied, `U` conflict
- `?` untracked, counted as all-added lines

If the path of the selected file is too long for the list, it scrolls back and forth as a marquee.

**File header (top right).** It stays in place while you scroll, like the prompt in the Chat view. It shows:
- the full path, wrapped at `/`
- the status, the line counts and the current mode (`diff` or `whole file`)
- for renames, the old path

**Diff.** Each hunk starts with its `@@` header.
- Every line shows its old and new line number, a `+`/`-` sign and a colored background for added and removed lines.
- `]` and `[` jump to the next and previous hunk.
- Repositories without any commit are diffed against the empty tree.
- Binary files are only named.

**Whole file.** `Enter` switches to the complete file as it is now, with line numbers and highlighting but without change markers. There, `]` and `[` jump between the changed blocks. `Enter` or `Esc` returns to the diff. Deleted files have no content after the change, so the view says so.

**Wrapping.** Long lines wrap by default. After `w`, lines stay whole and `Shift+←/→` scrolls sideways in steps of 8 columns. The line numbers and hunk headers stay in place.

**Refresh.** While the view is visible, it re-reads git every 2 seconds; `r` refreshes at once. The selected file stays selected as long as it is still changed.

**Syntax highlighting** exists so far for C# (`.cs`, `.csx`). Add more languages through the `LANGUAGES` map in `src/render/diff.ts`.

## Keys

The help line lists the keys of the current view. Options that are on (`f follow`, `t tools`, `w wrap`) and open detail views (`↵ prompt`, `↵ file`) are highlighted. If the pane is too narrow for all keys, the least important ones are left out, and `i more` points to the info dialog, which lists every key. `i` and `q` are always shown, and so are options that are on.

| Key | Chat | Changes |
|---|---|---|
| `1` / `2` | switch to Chat / Changes | switch to Chat / Changes |
| `←` / `→` | previous / next turn | previous / next file |
| `↑` / `↓` | scroll by line | scroll by line |
| `PgDn` / `PgUp` | scroll by page | scroll by page |
| `Space` / `b` | mark the turn ★ / scroll up a page | scroll down / up a page |
| `Home` / `End` | top / bottom of the answer | top / bottom of the diff |
| `g` / `G` | first / last turn (`G` resumes follow mode) | first / last file |
| `Enter` | full prompt ↔ answer | whole file ↔ diff |
| `Esc` | close the full prompt, otherwise quit | close the whole file, otherwise quit |
| `Ctrl+End` | jump to the bottom; on the newest turn also resume follow mode | – |
| `f` | toggle follow mode | – |
| `t` / `h` | show tool calls / thinking | – |
| `c` | copy the turn's Markdown | – |
| `]` / `[` | next / previous marked turn | next / previous hunk (changed block in whole-file mode) |
| `r` | – | refresh now |
| `w` | toggle wrapping | toggle wrapping |
| `Shift+←` / `Shift+→` | scroll sideways (wrapping off) | scroll sideways (wrapping off) |
| `i` | info dialog | info dialog |
| `q` | quit | quit |

`t`, `h` and `w` are saved globally for all projects in `~/.claude/cco/settings.json`. Chat and Changes each keep their own `w` setting.

## Info dialog

`i` opens a dialog centred over the view. It shows:
- the version, the author and the license
- the project directory, the session id and its transcript file
- the git repository root
- the terminal and the key that switches panes
- the settings file
- the keys of the current view

The dialog is modal: the view underneath takes no keys until you close it with `i` or `Esc`.

## Focus

The viewer shows whether it or Claude Code has the keyboard focus:

| | Focused | Not focused |
|---|---|---|
| Top bar | blue background | dimmed |
| Selected list entry | inverted | gray background |
| Help line | starts with `alt+←` (back to Claude Code), then the keys | only `alt+→ focus cco` |

`alt+←/→` is Windows Terminal's default for moving between panes; under tmux the help line shows `ctrl+b ←/→`. The focus comes from the terminal's focus events (`ESC[?1004h`). tmux needs `set -g focus-events on`. Terminals without focus events always show the viewer as focused.

## How it works

- **Reading sessions.** Claude Code stores every session as JSONL in `~/.claude/projects/<project-slug>/<session-id>.jsonl`. cc-outline reads this file incrementally and groups it into turns.
- **Tracking the active session.** The plugin hooks (`SessionStart`, `UserPromptSubmit`, `SessionEnd`) run `cco hook`, which records the active session in `~/.claude/cco/<project-slug>.json`. This way the viewer follows `/clear` and `/resume`.
- **Closing with the session.** When the session ends, the viewer closes itself. After `/clear` it continues with the new session instead.
- **Reopening on start.** If the viewer was open when Claude Code exited, the next start reopens it in the view it last showed; this also works with `--resume` and `--continue`. The focus stays in Claude Code. If the viewer was closed, it stays closed.
- **Without hooks**, the viewer uses the project's most recently modified transcript that contains messages.

## Development

```sh
npm run dev         # tsup --watch
npm test            # vitest
npm run typecheck
```

`cco` runs the built `dist/cli.js`. After a rebuild, close a running viewer with `q` and reopen it. Changes to the plugin (hooks, commands) take effect only after Claude Code restarts.

## License

[MIT](LICENSE) © 2026 Jan Hoppe

cc-outline is an independent community tool. It is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.
