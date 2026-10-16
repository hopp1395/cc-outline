import { Box, useApp, useInput, useStdout, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { isListFold, readSettings, updateSettings, type ColumnWidth } from "../settings.js";
import { TIMING } from "../timing.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { onCtrlC } from "./ctrlC.js";
import { FocusContext, useTerminalFocus } from "./focus.js";
import { InfoDialog, type InfoPage } from "./InfoDialog.js";
import { KeeperView } from "./KeeperView.js";
import { readKeeperRequest, type KeeperSelect } from "../keeper/registry.js";
import { AccountAvatarContext, AccountBadgeContext, KEEPER_TABS, keeperLayout, layoutOf, ScreenNoticeContext, tabAt, TabSetContext, type Mode } from "./layout.js";
import { stepFold, toggleFold, UNFOLDED, type FoldState } from "./listFold.js";
import { MouseContext, parseMouse, useMouseReporting } from "./mouse.js";
import { COPIED_MS, CopySelectionContext } from "./Preview.js";
import { ProgressHostProvider, useProgressHost } from "./ProgressDialog.js";
import { ReloadContext, useReloadKey } from "./reload.js";
import { SettingsView } from "./SettingsView.js";
import { AccountContext, useAccounts, type AccountState } from "./useAccount.js";
import { useSetting, useSettings } from "./useSetting.js";

/** A control-only write: the frame buffer draws the next frame in full, clearing the screen. */
const REDRAW = "\u001b[?25l";

/** The keeper's views: its three columns (in the chat's place) and its own settings. */
const KEEPER_VIEW_KEYS: Record<string, Mode> = { "1": "chat", "2": "settings" };

/**
 * The keeper (`cco keeper`): a window of its own that watches the sessions of every project and account (and claude.ai),
 * with its own settings (`settings.keeper.json`). It belongs to no Claude Code and follows no project.
 */
export function KeeperApp({ unfocused = false, accounts, select }: { unfocused?: boolean; accounts?: AccountState; select?: KeeperSelect }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { columns, rows } = useWindowSize();
  const settings = useSettings();
  // No compact view: the keeper needs the width for its columns.
  const dialogLayout = layoutOf(columns, rows);
  const keeper = keeperLayout(columns, rows, settings.keeperSessionsWidth, settings.keeperTurnsWidth);
  const focused = useTerminalFocus(!unfocused);
  // Tests hand in the accounts: the ones found are those of the real home folder.
  const found = useAccounts();
  const account = accounts ?? found;
  const [accountColor] = useSetting("accountColor");
  const [mode, setMode] = useState<Mode>("chat");
  // The session to select: the one it was started for, then each one asked for in its control file (Sessions, /cco:keeper).
  const [startedAt] = useState(Date.now);
  const [request, setRequest] = useState<(KeeperSelect & { at: number }) | undefined>(() => select && { ...select, at: startedAt });
  useEffect(() => {
    let seen = startedAt;
    const timer = setInterval(() => {
      const next = readKeeperRequest();
      if (!next || next.at <= seen) return;
      seen = next.at;
      setRequest(next);
      setMode("chat");
    }, TIMING.activityPoll);
    return () => clearInterval(timer);
  }, []);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoPage, setInfoPage] = useState<InfoPage>("keys");
  const [modal, setModal] = useState(false);
  const [typing, setTyping] = useState(false);
  // The keeper's chat column takes Tab and i for its prompt line.
  const [claimed, setClaimed] = useState(false);
  const [quitAsked, setQuitAsked] = useState(false);
  const [confirmQuit] = useSetting("confirmQuit");
  const progress = useProgressHost(dialogLayout);
  const [mouse] = useSetting("mouse");
  useMouseReporting(mouse);
  const blocked = infoOpen || quitAsked || progress.host.open;
  const mouseFor = (m: Mode) => mouse && mode === m && !blocked && !modal;
  const quit = () => (confirmQuit ? setQuitAsked(true) : exit());

  // A short message in the bottom row: the width after < or >, "Ctrl+C does not quit".
  const [notice, setNotice] = useState<{ text: string }>();
  const notify = useCallback((text: string) => setNotice({ text }), []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), COPIED_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  const copySelection = useRef<{ current?: () => boolean }>({}).current;
  useEffect(() => onCtrlC(() => {
    if (!copySelection.current?.()) setNotice({ text: "Ctrl+C does not quit: q does" });
  }), []);

  // F5 reloads the shown view: the keeper reads every session again, Settings its file.
  const [reloads, setReloads] = useState({ chat: 0, settings: 0 });
  const [reloading, setReloading] = useState<{ mode: Mode; done: boolean }>();
  const finishReload = useCallback((m: Mode) => setReloading((r) => (r?.mode === m && !r.done ? { mode: m, done: true } : r)), []);
  useEffect(() => {
    if (!reloading?.done) return;
    const timer = setTimeout(() => setReloading(undefined), TIMING.reloaded);
    return () => clearTimeout(timer);
  }, [reloading]);
  const reload = () => {
    if (reloading && !reloading.done) return;
    stdout.write(REDRAW);
    const m = mode === "settings" ? "settings" : "chat";
    setReloads((r) => ({ ...r, [m]: r[m] + 1 }));
    setReloading({ mode: m, done: false });
  };
  useReloadKey(reload, !(modal || typing || blocked));
  const reloadOf = (m: "chat" | "settings") => ({
    count: reloads[m],
    status: reloading?.mode === m ? (reloading.done ? ("done" as const) : ("loading" as const)) : undefined,
    done: () => finishReload(m),
  });

  // Settings' list width: < > | as in the viewer.
  const settingsFold = useRef<FoldState>(UNFOLDED);
  const settingsBefore = useRef<ColumnWidth>(undefined);
  if (!isListFold(settings.settingsListWidth)) settingsBefore.current = settings.settingsListWidth;
  const changeSettingsWidth = (input: string) => {
    const width = readSettings().settingsListWidth;
    const next = input === "|" ? toggleFold(width, settingsFold.current, settingsBefore.current) : stepFold(width, settingsFold.current, input === "<" ? -1 : 1);
    settingsFold.current = next.state;
    if (next.width !== width) updateSettings({ settingsListWidth: next.width });
    setNotice({ text: `width: ${next.width}` });
  };

  useInput((input, key) => {
    if (modal || typing || quitAsked || progress.host.open) return;
    if (infoOpen) {
      if (input === "i" || key.escape) setInfoOpen(false);
      else if (input === "q") quit();
      else if (key.leftArrow || key.rightArrow || key.tab) setInfoPage((p) => (p === "keys" ? "legend" : "keys"));
      return;
    }
    if (input.startsWith("[<")) {
      if (!mouse) return;
      const click = parseMouse(input).find((e) => e.kind === "click" && e.y === 0);
      const view = click && tabAt(click.x, readSettings(), mode, account.avatar, KEEPER_TABS);
      if (view && view !== mode) setMode(view);
      return;
    }
    if (mode === "chat" && claimed && (key.tab || input === "i")) return;
    if (input === "q") quit();
    else if (input === "i") {
      setInfoPage("keys");
      setInfoOpen(true);
    } else if (key.tab) setMode((m) => (m === "chat" ? "settings" : "chat"));
    else if (KEEPER_VIEW_KEYS[input]) setMode(KEEPER_VIEW_KEYS[input]);
    // The keeper's columns take ← → < > | themselves; Settings has one list.
    else if (mode === "settings" && (input === "<" || input === ">" || input === "|")) changeSettingsWidth(input);
  });

  return (
    <FocusContext.Provider value={focused}>
    <ProgressHostProvider host={progress.host}>
    <AccountContext.Provider value={account}>
    <AccountBadgeContext.Provider value={accountColor !== "off" ? account.color : undefined}>
    <AccountAvatarContext.Provider value={account.avatar}>
    <ScreenNoticeContext.Provider value={notice?.text}>
    <CopySelectionContext.Provider value={copySelection}>
    <TabSetContext.Provider value={KEEPER_TABS}>
      <Box flexDirection="column" width={columns} height={rows}>
        <Box display={mode === "chat" ? "flex" : "none"}>
          <ReloadContext.Provider value={reloadOf("chat")}>
          <MouseContext.Provider value={mouseFor("chat")}>
            <KeeperView
              layout={keeper.layout}
              aside={keeper.aside}
              visible={mode === "chat"}
              active={mode === "chat" && !blocked}
              onTyping={setTyping}
              onModal={setModal}
              notify={notify}
              request={request}
              onClaimKeys={setClaimed}
            />
          </MouseContext.Provider>
          </ReloadContext.Provider>
        </Box>
        <Box display={mode === "settings" ? "flex" : "none"}>
          <ReloadContext.Provider value={reloadOf("settings")}>
          <MouseContext.Provider value={mouseFor("settings")}>
            <SettingsView cwd={process.cwd()} layout={layoutOf(columns, rows, settings.settingsListWidth)} active={mode === "settings" && !blocked} onModal={setModal} onTyping={setTyping} oneSession />
          </MouseContext.Provider>
          </ReloadContext.Provider>
        </Box>
        {infoOpen && <InfoDialog layout={dialogLayout} mode={mode} cwd={process.cwd()} oneSession keeper page={infoPage} />}
        {quitAsked && (
          <ConfirmDialog
            layout={dialogLayout}
            confirmation={{ title: "Quit the keeper?", lines: ["The window closes; /cco:keeper opens it again."], onConfirm: exit }}
            onClose={() => setQuitAsked(false)}
          />
        )}
        {progress.dialog}
      </Box>
    </TabSetContext.Provider>
    </CopySelectionContext.Provider>
    </ScreenNoticeContext.Provider>
    </AccountAvatarContext.Provider>
    </AccountBadgeContext.Provider>
    </AccountContext.Provider>
    </ProgressHostProvider>
    </FocusContext.Provider>
  );
}
