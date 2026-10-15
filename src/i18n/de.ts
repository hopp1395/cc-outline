import { settings } from "./de/settings.js";
import type { Messages } from "./en.js";

/** Die deutschen Texte, mit denselben Schlüsseln und Parametern wie `en.ts`. */
export const de: Messages = {
  settings,
  tabs: {
    accounts: "Accounts",
    chat: "Chat",
    git: "Änderungen",
    plan: "Plan",
    sessions: "Sessions",
    monitor: "Monitor",
    settings: "Einstellungen",
  },
  progress: {
    reopenByHand: "Der Viewer kann sich hier nicht selbst neu öffnen: schließe ihn mit q und öffne ihn wieder.",
    copyCommands: "Befehle kopieren",
    close: "schließen",
    cancel: "abbrechen",
    wait: "Bitte warten, das lässt sich nicht abbrechen.",
  },
  placement: {
    title: "cco verschieben",
    reopens: "Der Viewer öffnet sich dort neu; diese Session merkt sich den Ort.",
    remembered: "Kein Windows Terminal oder tmux: für den nächsten Start gemerkt.",
    choose: "wählen",
    cancel: "abbrechen",
  },
  app: {
    noSessionFixed: "ein Viewer einer einzelnen Session (--session) setzt keine fort",
    noSessionUnpaired: "dieser Viewer folgt keinem Claude Code: hänge ihn in Sessions an eins an",
    noSessionYet: "es gibt noch keine Session",
    restartTitle: "Viewer neu starten",
    restarting: "Starte neu",
    notReopened: "Der Viewer hat sich nicht neu geöffnet",
    ctrlC: "Ctrl+C beendet nicht: q beendet",
    width: (width) => `Breite: ${width}`,
    quitTitle: "cco beenden?",
    quitWindow: "Das Fenster schließt sich; Sessions öffnet ein neues (Enter).",
    quitPane: "Das Pane schließt sich; ein /cco:…-Befehl öffnet es wieder.",
  },
  days: {
    weekdays: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
    months: ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"],
    label: (weekday, day, month, year) => `${weekday} ${day}. ${month}${year === undefined ? "" : ` ${year}`}`,
  },
  languageDialog: {
    title: "Sprache",
    question: "Dein Betriebssystem ist auf Deutsch eingestellt. Soll cco Deutsch verwenden?",
    yes: "Ja, Deutsch",
    yesDetail: "cco folgt der Sprache des Betriebssystems",
    no: "Nein, English",
    noDetail: "cco stays in English",
    hint: "Jederzeit änderbar: Einstellungen, Sprache.",
  },
};
