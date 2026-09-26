# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`cc-outline` (command `cco`) is a terminal viewer that runs in a split pane next to Claude Code. It has four views: **Chat** (the session's turns rendered as Markdown, following live), **Changes** (git status plus diffs against `HEAD` with syntax highlighting, C# only so far) **Plan** (the plans Claude presented in plan mode, with status and a diff between versions) and **Sessions** (an overview of the project's sessions: time span, plans, changed files, prompts and the resume command). It ships as an npm CLI (`cco`) plus a Claude Code plugin in `plugin/` (hooks and the `/cco:chat`, `/cco:git`, `/cco:plan` and `/cco:session` commands). User-facing docs and key bindings are in `README.md`.

## Commands

```sh
npm run build        # tsup → dist/cli.js (single ESM bundle with shebang)
npm run dev          # tsup --watch
npm run typecheck    # tsc --noEmit (TypeScript 7)
npm test             # vitest run
npx vitest run test/git.test.ts            # one file
npx vitest run -t "breaks after slashes"   # one test by name
npm link             # expose `cco` globally; it runs dist/, so rebuild after changes
npm run demo         # re-record the README images in docs/ (headless run on demo/fixture.mjs; the GIF needs Chrome)
claude --plugin-dir ./plugin               # load the plugin (hooks + commands) for one session
claude plugin marketplace update cc-outline && claude plugin update cco@cc-outline   # refresh the installed plugin
```

The plugin is installed from this repo, which is its own marketplace (`.claude-plugin/marketplace.json`). Claude Code runs a cached copy, so changes under `plugin/` need the update command above. The plugin calls `cco` by name, so `npm link` is required for the hooks and commands to work. A running viewer pane keeps the code it was started with: after a rebuild, close it with `q` and reopen it. Plugin changes (hooks, commands) only load when Claude Code restarts.

## Architecture

**Data flow.** Claude Code writes every session as JSONL to `~/.claude/projects/<slug>/<session-id>.jsonl`. The slug is the cwd with every non-alphanumeric character replaced by `-`, see `projectSlug` in `src/transcript/locate.ts`. The viewer never talks to Claude Code directly. It tails that file (`FileTail` in `src/transcript/tail.ts`, reading from a byte offset) and feeds chunks to `TranscriptParser` (`src/transcript/parse.ts`). The parser groups entries into turns (a real user prompt plus all assistant blocks until the next prompt) and buffers incomplete trailing lines.

**Transcript format quirks** (handled in `parse.ts`):
- One assistant message is split across several lines that share `message.id`, one line per content block.
- `user` entries also carry tool results, `isMeta` reminders, interrupt markers and `<local-command…>` output. Only real prompts start a turn; slash commands are shown as `/name args`.
- Sidechain entries (subagents) are skipped.
- Prompts typed while Claude is working are not stored as `user` entries. When Claude takes them in mid-turn, they appear as `type: "attachment"` with `attachment.type: "queued_command"` and `attachment.prompt`; `queue-operation` lines only record the queueing. They start their own turn with `queued: true`, shown as `↳` in the list.
- Plans are `ExitPlanMode` tool calls (`input.plan`). The user's decision is the matching `tool_result` in a later `user` entry: `is_error: false` means approved, `is_error: true` rejected, with optional feedback after "the user said:". `TranscriptParser.plans` collects them; Claude Code also writes plans to `~/.claude/plans/`, but with random names and no project, so the transcript is the source.

**Hooks and state files.** `cco hook` (`src/hook.ts`) handles `SessionStart`, `UserPromptSubmit` and `SessionEnd` and writes per-project state files to `~/.claude/cco/<slug>*.json`. All of them are written atomically via rename (`writeJson` in `locate.ts`):
- `<slug>.claude-<pid>.json`: the session of one Claude Code process (`CLAUDE_PID`, which Claude Code passes to hooks and commands; `claudePidFromEnv`). Same shape as `<slug>.json`, and `ended: true` on `SessionEnd` (not `clear`) of that process's session. A viewer started with `--claude-pid` (which `cco open` passes) follows only this file and also exits when the pid is gone. Stale files of dead pids are removed on `SessionStart`.
- `<slug>.json`: the project's latest active session, for viewers without a pid (`cco watch` by hand). `ended: true` is set on `SessionEnd`, except when the reason is `clear`, and only if that session is still the active one.
- `<slug>.viewer-<claudePid>.json` (`<slug>.viewer.json` without a pid): pid and current view of the running viewer. `cco open` checks the one of its own Claude Code process and reuses a live viewer instead of opening a second pane. `restore.json` is only rewritten by a session with its own viewer or when no viewer runs in the project, and `SessionStart` reopens only when none runs.
- `<slug>.restore.json`: whether a viewer was running at `SessionEnd`, and with which view. On `SessionStart` with source `startup` or `resume`, the hook reopens it with `keepFocus`, which sends a `move-focus left` to wt or passes `-d` to tmux. The hook must not print to stdout, because SessionStart output is added to Claude's context.
- `<slug>.control-<claudePid>.json` (`<slug>.control.json`): view-switch requests from `cco open` to the running viewer.
- `<slug>.favorites.json`: marks of all four lists (`src/favorites.ts`): `turns` (prompt uuids), `files` (paths), `plans` (tool call ids) and `sessions` (session ids). Kept per project, not per session: `--continue`/`/resume` start a new session id but copy the turns with their uuids. The first format (one list per session id) is merged into `turns` on read. Views use it through `useFavorites()`; `markKeys()`/`markFooter()`/`Star` in `layout.tsx` keep Space and Shift+←/→ the same everywhere.

Display preferences (`t`, `h`, and `w` separately for chat, changes and plan) are global rather than per project: `~/.claude/cco/settings.json` (`src/settings.ts`). Views use them through `useSetting()`, which writes on every change.

Focus indication (`src/tui/focus.ts`): the viewer enables terminal focus reporting (DECSET 1004). Ink passes the reports to `useInput` as `"[I"` and `"[O"`, with the ESC stripped and no key flags set, so no view binding reacts to them. `FocusContext` feeds `Screen` (top bar, footer) and `List` (selection style). A pane opened with `keepFocus` starts with `--unfocused`, because the terminal sends no initial report.

The viewer (`src/tui/useViewerControl.ts`) only reacts to changes that happen after it started. It exits when the session ends, after a 1.5 s grace period. Without hooks it falls back to the newest transcript that contains messages; Claude Code also creates tiny bookkeeping `.jsonl` files that must be ignored.

**TUI** (Ink 7 + React 19, `src/tui/`):
- `App.tsx` reads the transcript once (`useTranscript`) for the chat and plan views and keeps all views mounted (hidden with `display="none"`) so the chat keeps following while the git view is shown. Views use `useInput(..., { isActive })`.
- `SessionsView.tsx` reads all transcripts of the project through `SessionIndex` (`src/transcript/sessions.ts`) only while it is visible, every 3 s. One `SessionReader` per file keeps a byte offset and a `TranscriptParser`, so a rescan only parses what was appended. It adds what the parser ignores: the `/rename` title (`custom-title` entries), `gitBranch`, the time span and the files of `Edit`/`Write`/`MultiEdit`/`NotebookEdit` calls. Sessions with only slash commands and no changes are left out.
- `Enter` starts a session with `resumeInNewTab` (`src/open.ts`): `wt -w 0 new-tab -d <cwd> cmd /k claude --resume <id>` (cmd finds both claude.exe and an npm .cmd shim and keeps the tab open), or `tmux new-window` with `exec $SHELL` afterwards. Active and running sessions are refused.
- Deleting (`src/transcript/trash.ts`) moves a session's parts (`projects/<slug>/<id>.jsonl`, `projects/<slug>/<id>/`, `file-history/<id>/`, `session-env/<id>/`) to `~/.claude/cco/trash/<slug>/<id>/` under their path relative to `~/.claude`, with a `manifest.json` (items, deletion time, the `SessionSummary` for display). Restore moves them back and refuses if a path exists again; purge removes the trash folder and the mark. The active session and sessions with a live pid in `~/.claude/sessions/<pid>.json` are refused. `ConfirmDialog` (on the shared `Dialog` frame in `layout.tsx`) asks first, Enter confirms, Esc cancels; while it is open, `App` ignores its own keys (`onModal`).
- `layout.tsx` holds the shared pieces: the `Screen` frame, the `List`, `useScroll`, `handleNavigation`, `previewHeader`, `Marquee` and `wrapPath`. All views share the same navigation: `←→` switch item, `↑↓` scroll.
- `Preview.tsx` renders a sticky `header` (prompt or file path, capped by `fitHeader`) above the scrolled lines. Like the list, it turns the first/last row into a `▲`/`▼ N more lines` indicator when lines are hidden (`previewWindow`); the row covers the line at `scroll`, so jumps to a line (hunks) scroll to one line before it.
- All content is pre-rendered into ANSI strings that are already wrapped to the preview width, then sliced by scroll offset. Ink does no wrapping of its own here (`wrap="truncate"`).

**Rendering.**
- `src/render/markdown.ts` uses `marked` with `marked-terminal`, plus two fixes:
  - A `text` renderer override, because marked ≥13 hands list items nested inline tokens that marked-terminal prints raw.
  - A wrapper that indents the continuation lines of list items.
- `src/render/diff.ts` highlights each hunk side as one text, so multi-line comments are colored correctly, and then maps the lines back. Its truecolor theme applies styles per line (`style()`), because highlighted output is split into lines afterwards. Add languages via the `LANGUAGES` map.

**Git** (`src/git/git.ts`): uses porcelain v1 `-z` plus `numstat`. It diffs against `HEAD`, or against git's empty tree in repos without commits. Untracked files get a synthetic all-added hunk and are counted manually.

**Opening panes** (`src/open.ts`): calls `wt -w 0 split-pane` on Windows Terminal or `tmux split-window` (`detectTerminal`: `TMUX`, else `WT_SESSION` or `WT_PROFILE_ID`; `WT_SESSION` alone is not reliable, Claude Code can lose it when it restarts itself). It launches `process.execPath dist/cli.js` directly, because Windows Terminal cannot run npm's `.cmd` shims by bare name.

## Gotchas

- `CLAUDE_CONFIG_DIR` may be set to an empty string. Use `||`, not `??`, when falling back to `~/.claude`.
- chokidar does not notice files created later if their directory does not exist yet; `watchFile` creates the directory first. On Windows it uses polling. `FileTail` also stats the file every second so it catches a transcript that does not exist yet.
- On this Windows machine, the Bash tool mangles backslashes in heredocs and inline scripts (`\\`, `\u001b`, `\n`). Write files containing escape sequences with the Write/Edit tools.
- TUI changes can be checked headlessly: render `App` from a tsup build into a `PassThrough` stdout with `isTTY = true` and `debug: true`, write key sequences to a fake stdin (e.g. `\u001b[C` for →), and inspect the output with ANSI codes stripped.
