# cce – Claude Code Extensions

`cce` ergänzt Claude Code im Terminal um einen zweiten Pane:

- **Chat**: die Antworten der Session gerendert – Überschriften, Listen, Tabellen, Codeblöcke mit Syntax-Highlighting. Folgt der Session live.
- **Changes**: geänderte Dateien im Git-Repo mit Diff und Syntax-Highlighting.

```
cce  session 3d061497 · 3 turns · all · FOLLOW
09:56 ich arbeite sehr viel mit… │ ❯ los
10:07 lege ein neues git-repo f… │ ─────────────────────────────────────
10:08 los                        │ Die Abhängigkeiten sind installiert …
```

## Installation

```sh
npm install
npm run build
npm link            # stellt `cce` global bereit
```

Plugin in Claude Code laden (Hooks + Commands `/cce:chat` und `/cce:git`):

```sh
claude --plugin-dir ./plugin
```

## Nutzung

- **`/cce:chat`** bzw. **`/cce:git`** in Claude Code öffnet den Viewer als Split-Pane (Windows Terminal oder tmux), direkt in der Chat- bzw. Changes-Ansicht.
- **`cce`** bzw. `cce watch` im Projektverzeichnis startet den Viewer manuell in einem beliebigen Terminal.
  - `--cwd <dir>`: Projekt, dessen Session angezeigt wird
  - `--session <id>`: bestimmte Session statt der aktiven
  - `--view chat|git`: Ansicht beim Start (Standard: `chat`)

Der Viewer hat zwei Ansichten, umschaltbar mit `1` und `2`:

- **Chat**: die Turns der Session mit gerenderter Antwort
- **Changes**: geänderte Dateien des Git-Repos (inkl. untracked) und ihr Diff gegen `HEAD` mit Zeilennummern und Syntax-Highlighting. Wird alle 2 s aktualisiert, solange die Ansicht offen ist. Highlighting gibt es bisher für C# (`.cs`, `.csx`); weitere Sprachen kommen über die Tabelle `LANGUAGES` in `src/render/diff.ts` dazu.

| Taste | Aktion |
|---|---|
| `1` / `2` | Ansicht Chat / Changes |
| `↑` `↓` / `j` `k` | Turn bzw. Datei wählen (Liste) oder zeilenweise scrollen (Vorschau) |
| `Tab` | Fokus Liste ↔ Vorschau |
| `Space` / `b`, `PgDn` / `PgUp` | seitenweise scrollen |
| `Ctrl+d` / `Ctrl+u` | halbe Seite scrollen |
| `Home` / `End` | Anfang / Ende der Antwort |
| `n` / `p` | nächster / vorheriger Turn bzw. Datei |
| `g` / `G` | erster / letzter Turn bzw. Datei (`G` aktiviert im Chat Follow) |
| `f` | Chat: Follow-Mode umschalten (springt automatisch zum neuesten Turn) |
| `t` / `h` | Chat: Tool-Calls / Thinking einblenden |
| `c` | Chat: Markdown des Turns in die Zwischenablage kopieren |
| `]` / `[` | Changes: nächster / vorheriger Hunk |
| `r` | Changes: sofort aktualisieren |
| `q` / `Esc` | beenden |

## Funktionsweise

- Claude Code speichert jede Session als JSONL unter `~/.claude/projects/<projekt-slug>/<session-id>.jsonl`. `cce` liest diese Datei inkrementell und gruppiert sie in Turns (Prompt + Antworten).
- Die Plugin-Hooks (`SessionStart`, `UserPromptSubmit`) rufen `cce hook` auf. Das schreibt die aktive Session nach `~/.claude/cce/<projekt-slug>.json`. So wechselt der Viewer automatisch, z.B. nach `/clear` oder `/resume`.
- Der `SessionEnd`-Hook markiert die Session als beendet; der Viewer schließt sich dann selbst (nicht bei `/clear`, dort geht es mit der neuen Session weiter).
- Läuft für das Projekt schon ein Viewer, öffnen `/cce:chat` und `/cce:git` keinen zweiten Pane, sondern schalten den bestehenden auf die gewünschte Ansicht um.
- Ohne Hooks nimmt der Viewer das zuletzt geänderte Transkript des Projekts, das Nachrichten enthält.

## Entwicklung

```sh
npm run dev         # tsup --watch
npm test            # vitest
npm run typecheck
```
