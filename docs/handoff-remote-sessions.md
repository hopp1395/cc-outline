# Übergabe: Remote-Sessions in cco (Etappe 1)

Branch `feature/remote-sessions`, Commit `8ff4f4d`. Diese Notiz hält fest, wo es weitergeht. Sie ersetzt nicht den Code: Einstieg ist der Abschnitt *Remote sessions* in `CLAUDE.md`.

## Ziel

Remote-Control-Sessions (claude.ai, Claude-App) in cco sehen, später auch bedienen, von einem anderen Rechner aus. Es gibt keine offizielle API dafür; genutzt wird die undokumentierte `GET /v1/code/sessions` (Referenz: <https://github.com/ThatCrispyToast/claude-rc-api>).

## Entschieden

- Experimentell: Setting `remoteApi`, standardmäßig aus; `sessionsRemote` (`show`/`only`/`hide`) als vierter Teil des Filters.
- Login von Claude Code mitbenutzen: `.credentials.json` bei jeder Anfrage lesen, nie schreiben oder erneuern; Organisation aus `.claude.json` (`organizationUuid`).
- Nur über die API, kein SSH-Zugriff; Polling alle 3 s, SSE später.
- Events werden in Transcript-Zeilen übersetzt (`src/remote/toTranscript.ts`) und vom bestehenden Parser gelesen.
- Anzeige: Sessions-View mit `◈` (nur remote) und `⇄` (lokale Session, die verbunden ist); Enter bietet nur die Adresse zum Kopieren an. Chat-View bleibt bei der lokalen Session.
- Etappen: 1 Liste und Lesen (fertig), 2 Prompts senden, 3 Freigaben und Rückfragen.

## Stand

Etappe 1 ist umgesetzt und mit gefälschten API-Antworten getestet (`test/remote.test.ts`, `test/remote-sessions.test.tsx`). Gegen die echte API ist nur bekannt: `GET /v1/code/sessions` antwortet mit 200 und `{ data: [], resume_token }`, solange keine Remote-Control-Session läuft. Auf einer Firmen-Maschine mit TLS-Interception braucht Node die System-Zertifikate (`NODE_OPTIONS=--use-system-ca`).

## Ungeprüft (braucht eine laufende Remote-Control-Session)

1. Feldnamen der Liste und der Events (`status`, `worker_status`, `connection_status`, `environment_kind`, `sequence_num`, `payload`).
2. Ob vom Handy getippte Prompts als `user`-Events ankommen und wie sie sich von lokalen unterscheiden.
3. Wie sich eine lokale Session ihrer Remote-Session zuordnen lässt (`RemoteInfo.refs` sucht nur UUIDs in den Daten).
4. Ob `/events` einen Cursor kennt (`EVENT_LIMIT` = 1000, ältere werden nur als `truncated` vermerkt).
5. Ob `tls.setDefaultCACertificates` das Zertifikatsproblem auf Node 24 löst (auf Node 22 gibt es sie nicht).

## Nächste Schritte

1. Eine Session mit `/remote-control` (oder `claude remote-control`) verbinden, `remoteApi` an, im Sessions-View prüfen, was erscheint. Bei Abweichungen `src/remote/api.ts` (`parseSession`, `listEvents`) und `toTranscript.ts` anpassen; unbekannte Event-Arten zeigt der Header (`not shown: …`).
2. Etappe 2: Prompts senden (POST auf die Events), Eingabefeld und Taste im Sessions-View, danach SSE (`/events/stream?from_sequence_num=N`, `Last-Event-ID`).
3. Etappe 3: `control_request` (Berechtigungen, `AskUserQuestion`, Plan-Freigabe) beantworten.

## Hinweise

- Die Git-Tests (`git`, `git-info`, `git-view`, `repos`) laufen auf der Windows-Maschine, auf der das entstand, in Timeouts, auch auf `main`; `sessionViews` ist unter Last flaky.
- Windows-Bash zerstört Backslashes in Heredocs: Dateien mit Write/Edit schreiben.
