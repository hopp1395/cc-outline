# ccmd – Markdown-Vorschau für Claude Code

`ccmd` zeigt die Antworten einer Claude-Code-Session gerendert in einem zweiten Terminal-Pane an: Überschriften, Listen, Tabellen, Codeblöcke mit Syntax-Highlighting. Der Viewer folgt der Session live.

```
ccmd  session 3d061497 · 3 turns · all · FOLLOW
09:56 ich arbeite sehr viel mit… │ ❯ los
10:07 lege ein neues git-repo f… │ ─────────────────────────────────────
10:08 los                        │ Die Abhängigkeiten sind installiert …
```

## Installation

```sh
npm install
npm run build
npm link            # stellt `ccmd` global bereit
```

Plugin in Claude Code laden (Hooks + `/preview`-Command):

```sh
claude --plugin-dir ./plugin
```

## Nutzung

- **`/preview`** in Claude Code öffnet den Viewer als Split-Pane (Windows Terminal oder tmux).
- **`ccmd`** bzw. `ccmd watch` im Projektverzeichnis startet den Viewer manuell in einem beliebigen Terminal.
  - `--cwd <dir>`: Projekt, dessen Session angezeigt wird
  - `--session <id>`: bestimmte Session statt der aktiven

| Taste | Aktion |
|---|---|
| `↑` `↓` / `j` `k` | Turn wählen (Liste) bzw. zeilenweise scrollen (Vorschau) |
| `Tab` | Fokus Liste ↔ Vorschau |
| `Space` / `b`, `PgDn` / `PgUp` | seitenweise scrollen |
| `Ctrl+d` / `Ctrl+u` | halbe Seite scrollen |
| `Home` / `End` | Anfang / Ende der Antwort |
| `n` / `p` | nächster / vorheriger Turn |
| `g` / `G` | erster / letzter Turn (`G` aktiviert Follow) |
| `f` | Follow-Mode umschalten (springt automatisch zum neuesten Turn) |
| `t` / `h` | Tool-Calls / Thinking einblenden |
| `c` | Markdown des Turns in die Zwischenablage kopieren |
| `q` / `Esc` | beenden |

## Funktionsweise

- Claude Code speichert jede Session als JSONL unter `~/.claude/projects/<projekt-slug>/<session-id>.jsonl`. `ccmd` liest diese Datei inkrementell und gruppiert sie in Turns (Prompt + Antworten).
- Die Plugin-Hooks (`SessionStart`, `UserPromptSubmit`) rufen `ccmd hook` auf. Das schreibt die aktive Session nach `~/.claude/ccmd/<projekt-slug>.json`. So wechselt der Viewer automatisch, z.B. nach `/clear` oder `/resume`.
- Ohne Hooks nimmt der Viewer das zuletzt geänderte Transkript des Projekts.

## Entwicklung

```sh
npm run dev         # tsup --watch
npm test            # vitest
npm run typecheck
```
