# Keeper, phase 2: stepping in

Handoff for the next session. Phase 1 (commit `1d8dc69`, branch `feature/session-keeper`) built the keeper (`cco keeper`)
as a watcher: three columns (sessions | turns | chat), grouped by state, read-only, and four ways to open it (the
keeper's row in Sessions, `k`, *Watch it in the keeper* in the Enter dialog, `/cco:keeper`). Phase 2 lets the user
act on the session selected in the keeper. Read the *Keeper* paragraph in `CLAUDE.md` first; it names every piece
phase 1 added.

## What the user decided (grilling, 2026-10-16)

- Purpose: overview of many sessions (also remote) like a control centre, and **quick intervention on questions and idle**.
- Full control in the keeper: prompt line, interrupt, answering questions and permissions, for local and remote sessions,
  as the session viewer does.
- **Local** sessions: a pending permission or question is in no file cco can read (only `status: waiting` in
  `~/.claude/sessions/<pid>.json`), so the keeper does **not** answer them; it jumps to the session's tab or pane
  (`switchToSession`). No new hook for this.
- **Remote** sessions: answered in the keeper (permission panel, question dialog), as in the session viewer.
- `Enter` on a session in the keeper's list opens an **action dialog** (`ChoiceDialog`, like Sessions): jump to it,
  send a prompt, interrupt, answer (remote), open a session viewer, copy the resume command. For a waiting session,
  jump (local) or answer (remote) is selected.
- The selection never moves by itself when a session starts waiting; `n` goes to the next waiting one (exists).
- No bell, no OS notification, no top-bar badge (dropped by the user).

## Todo

1. **Enter dialog in the keeper's sessions column** (`KeeperView.tsx`, today `Enter` only moves to the turns)
   - Build the options with `sessionOptions`-like helpers of `src/tui/resumeChoice.ts`; for a remote session reuse
     `remoteOptions(workerStatus)` from `useRemoteControl.tsx` and `viewerOptions`.
   - Local: *Bring its terminal to the front* (`switchToSession(running, [title])`, `src/switchSession.ts`; daemon
     sessions `kind: "bg"` have no tab: show `claude attach <jobId>`), *Send a prompt* / *Interrupt* (step 2),
     *Open it in a session viewer* (`openSessionViewer`, `viewerWindow()`), *Copy the resume command* (`resumeCommand`).
   - Ended sessions: *Continue it in a new window* (`resumeInNewWindow`), session viewer, copy.
   - Selected first: waiting local → jump; waiting remote → answer; busy → interrupt? (ask the user: interrupt as default is risky; propose jump).
   - The dialog is modal: report through `onModal` like ChatView does, so `KeeperApp` ignores its keys.
2. **Prompt line below the chat** (`SessionComposer`, `src/tui/SessionComposer.tsx`)
   - `App.tsx` lines ~266–285 and ~656–668 show the wiring for one fixed session: `composing` state, `composerRows`
     via `onHeight`, `shorter(layout, rows)` for the chat, `typingInComposer` blocking App's keys and `scrollOnly` on ChatView.
   - In the keeper the channel must follow the selected session: `useLocalPrompt(running, focused)` takes the
     `RunningSession` from `useRunning`'s map (`entry.running`); on Windows it pre-starts a PowerShell typer per pid
     (~1 s), so only for the selected session and only while the line has the keys. Remote: the `PromptChannel` memo
     of `App.tsx` (`sendPrompt`/`sendInterrupt`/`sendResponse`, `blocked` without `remoteControl`).
   - Keys: decide with the user whether `Tab`/`i` give the line the keys from any column or only from the chat column
     (`Tab` switches Keeper/Settings in `KeeperApp` today; `i` is the info dialog). The session viewer's rule: from the chat, `Tab`/`i`.
   - Drafts per session id: `PromptDialog` keeps them in memory already; check `SessionComposer` does too when the
     session changes under it (it must not send a draft to another session).
   - `localBlocked` texts already say why a local session cannot take a prompt (waiting, background, no tmux).
3. **Remote requests in the keeper**
   - The pending request comes from `useRemoteTranscript(...).pending[0]`, else the list's `session.remote.pending`
     (`SessionSummary.remote.pending`). Pass it to `SessionComposer` (`pending`), which shows the permission panel or
     `QuestionDialog` inline, as in the remote viewer.
   - `stillPending` / "already answered in another app" logic lives in `useRemoteControl`; reuse it.
4. **Settings and docs**
   - `remoteControl` is read from the main settings (not a `KEEPER_KEYS` key): fine, keep it that way.
   - Info dialog (`KEEPER_INFO_KEYS` in `InfoDialog.tsx`), legend, help line (`sessionsFooter` in `KeeperView.tsx`).
   - README *Keeper* section, CLAUDE.md *Keeper* paragraph (drop "Not yet: …").
5. **Tests** (`test/keeper.test.tsx`)
   - Enter dialog options per state (pure helper, like `test/resume-choice.test.tsx`).
   - Prompt line sends to the selected session: fake `proc.spawn` for local typing (see `test/local-prompt.test.tsx`),
     swap `remote.fetch` for remote (see `test/remote-control.test.tsx`).
   - Switching the session while the line has the keys does not send to the old one.
   - Keep the test rules: no fixed waits over 150 ms, no `vi.mock`; render `KeeperApp` with `accounts` so the real
     home folder is not scanned (it took over 5 s).

## Open questions to put to the user

- Default action of `Enter` on a busy session (interrupt or jump).
- Which keys hand the prompt line the keys in the keeper, and whether the line shows in every column or only with the chat.
- Should sending a prompt to an idle local session also bring its terminal to the front, or stay in the keeper (session viewer: stays)?

## Gotchas found in phase 1

- Tests that render `SessionsView` and click row 2 hit the keeper's row now (it opens a real `wt` window when
  `WT_SESSION` is set and `proc.spawn` is not faked); the first session row is row 3.
- The Bash tool mangles backslashes and control characters in heredocs on this machine; write edit scripts with the
  Write tool.
- 4–10 git tests (`git.test.ts`, `git-view`, `repos`, `git-info`) and `sessionViews.test.ts` time out on this machine
  on `main` too; not related.
