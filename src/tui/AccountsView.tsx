import { Text, useInput } from "ink";
import { basename } from "node:path";
import { useEffect, useMemo, useState } from "react";
import { accountUsedAt, colorOfAccount, hasChosenColor, type Account } from "../account.js";
import { ACCOUNTS_ORDER_VALUES, type AccountsOrder } from "../settings.js";
import { accountPlugin, accountRunning, accountSessions } from "../accountsInfo.js";
import { listAccountTrash, sizeText, type AccountTrashEntry } from "../accountTrash.js";
import { haystack } from "../filter.js";
import { TIMING } from "../timing.js";
import { useFocused } from "./focus.js";
import { bold, dim, EntryText, handleNavigation, List, markFooter, markKeys, previewHeader, Screen, Star, type Layout } from "./layout.js";
import { doubleClicks } from "./openKey.js";
import { bodyHeightBelow, fitHeader, Preview } from "./Preview.js";
import { useOnReload } from "./reload.js";
import { accountLines, colorBadge, tilde } from "./SettingsView.js";
import { useAccountState, type AccountState } from "./useAccount.js";
import { useFavorites } from "./useFavorites.js";
import { useListFilter } from "./useListFilter.js";
import { usePositions } from "./usePositions.js";
import { useSetting, useSettings } from "./useSetting.js";
import { ownSession, useAccountFlow } from "./useAccountFlow.js";
import type { PairTarget } from "../viewer.js";

interface Props {
  cwd: string;
  layout: Layout;
  /** The view is shown; what runs under each account is only read while it is. */
  visible: boolean;
  /** The view takes keys. */
  active: boolean;
  onTyping?: (typing: boolean) => void;
  /** Reports whether a dialog of the account menu is open; the app then leaves all keys to it. */
  onModal?: (open: boolean) => void;
  /** The transcript of the viewer's session, which can continue in another account; undefined with `noSession` saying why. */
  sessionPath?: string;
  noSession?: string;
  /** The Claude Code process the viewer belongs to. */
  claudePid?: number;
  /** A Claude Code the viewer started runs now `where`: the viewer moves next to it. */
  onPairStarted?: (target: PairTarget, where: string) => void;
  /** While true, the viewer stays open when its Claude Code ends (closed on purpose). */
  onHoldOpen?: (hold: boolean) => void;
  /** Reports whether the trash is shown, so Esc leaves it instead of quitting. */
  onTrashOpen?: (open: boolean) => void;
}

/** An entry of the list: an account, a note that there is none, or how they are looked for. */
type Entry = { kind: "account"; account: Account } | { kind: "none" } | { kind: "details" } | { kind: "add" } | { kind: "trashed"; entry: AccountTrashEntry };

const keyOf = (e: Entry) => (e.kind === "account" ? e.account.dir : e.kind === "trashed" ? `trash:${e.entry.id}` : e.kind);

/** How often the running Claude Codes are read while the view is shown; the rest goes with the account list (30 s) and F5. */
const RUNNING_MS = 3000;

const green = (s: string) => `\u001b[32m${s}\u001b[39m`;
const yellow = (s: string) => `\u001b[33m${s}\u001b[39m`;
const red = (s: string) => `\u001b[31m${s}\u001b[39m`;
const magenta = (s: string) => `\u001b[35m${s}\u001b[39m`;
const heading = (s: string) => `\u001b[1;36m${s}\u001b[22;39m`;

/** How the other accounts are sorted, for each value of the `accountsOrder` setting. */
const ORDERS: Record<AccountsOrder, (a: Account, b: Account) => number> = {
  email: (a, b) => a.email.localeCompare(b.email),
  folder: (a, b) => basename(a.dir).localeCompare(basename(b.dir)) || a.email.localeCompare(b.email),
  recent: (a, b) => accountUsedAt(b) - accountUsedAt(a) || a.email.localeCompare(b.email),
};

/** The preview of an account in the trash: what it was, what moved and how to get it back. */
function trashedLines(t: AccountTrashEntry): string[] {
  const field = (name: string, value: string | undefined) => (value ? [`  ${dim(`${name}:`)} ${value}`] : []);
  const a = t.account;
  return [
    heading("Account"),
    ...field("name", a.name),
    ...field("organization", [a.organization, a.organizationType && `(${a.organizationType})`].filter(Boolean).join(" ")),
    ...field("billing", a.billing),
    ...field("seat", a.seat),
    "",
    heading("In the trash"),
    ...field("deleted", when(t.deletedAt)),
    ...field("folder", tilde(t.folder.from)),
    ...field("size", `${sizeText(t.size)} · ${plural(t.sessions, "session")}`),
    ...(t.scripts.length ? t.scripts.map((s) => `  ${dim("script:")} ${tilde(s.from)}`) : [dim("  no start script moved with it")]),
    ...field("kept in", tilde(t.folder.to)),
    "",
    dim("u: restore it (refused while its folder or a script exists again). x: delete it for good. X: empty the trash."),
  ];
}

/** The active account first, the others in `order` (by email by default), then how they are found; a note first while there is none. */
export function accountEntries(state: Pick<AccountState, "accounts" | "current">, order: AccountsOrder = "email"): Entry[] {
  const current = state.current && state.accounts.find((a) => a.dir === state.current!.dir);
  const others = state.accounts.filter((a) => a !== current).sort(ORDERS[order]);
  const accounts = [...(current ? [current] : []), ...others].map((account): Entry => ({ kind: "account", account }));
  return [...(accounts.length ? accounts : [{ kind: "none" } as Entry]), { kind: "details" }, { kind: "add" }];
}

const pad = (n: number) => String(n).padStart(2, "0");
const when = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function AccountsView({ cwd, layout, visible, active, onTyping, onModal, sessionPath, noSession, claudePid, onPairStarted, onHoldOpen, onTrashOpen }: Props) {
  const { listWidth, previewWidth, bodyHeight } = layout;
  const focused = useFocused();
  const [isDoubleClick] = useState(() => doubleClicks());
  const state = useAccountState();
  const settings = useSettings();
  const favorites = useFavorites(cwd, "accounts");
  const positions = usePositions(cwd, "accounts");
  const [order, setOrder] = useSetting("accountsOrder");
  const [flash, setFlash] = useState<string>();
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(undefined), 3000);
    return () => clearTimeout(timer);
  }, [flash]);
  // The account menu: continue the session there, start a new one, open its folder, move it to the trash.
  const flow = useAccountFlow({ layout, claudePid, onPairStarted, onHoldOpen, notify: setFlash });
  useEffect(() => onModal?.(flow.open), [flow.open]);
  // Plugin and sessions are read with the account list (every 30 s) and on F5; the running Claude Codes every few seconds.
  const [reads, setReads] = useState(0);
  useOnReload(() => setReads((n) => n + 1));
  // The accounts trash (T): read when it opens, after each change and on F5.
  const [trashOpen, setTrashOpen] = useState(false);
  const trash = useMemo(() => (trashOpen ? listAccountTrash() : []), [trashOpen, flow.trashChanged, reads]);
  useEffect(() => onTrashOpen?.(trashOpen), [trashOpen]);
  const accountList = useMemo(() => accountEntries(state, order), [state.accounts, state.current?.dir, order]);
  const entries = useMemo((): Entry[] => (trashOpen ? trash.map((entry) => ({ kind: "trashed", entry })) : accountList), [trashOpen, trash, accountList]);
  const [listKey, setListKey] = useState<string | undefined>(positions.selected);
  const [trashKey, setTrashKey] = useState<string>();
  const selectedKey = trashOpen ? trashKey : listKey;
  const setSelectedKey = trashOpen ? setTrashKey : setListKey;
  const found = entries.findIndex((e) => keyOf(e) === selectedKey);
  const index = found >= 0 ? found : 0;
  const select = (i: number) => {
    const target = entries[Math.max(0, Math.min(entries.length - 1, i))];
    if (target) setSelectedKey(keyOf(target));
  };
  const filter = useListFilter({
    items: entries,
    text: (e) =>
      e.kind === "account"
        ? { list: haystack([e.account.email, basename(e.account.dir)]), details: haystack([e.account.dir, e.account.name, e.account.organization, e.account.seat, e.account.billing]) }
        : { list: "", details: "" },
    selected: index,
    select,
    layout,
    onTyping,
    enabled: !trashOpen,
    keep: (e) => e.kind !== "account",
    marked: (e) => e.kind === "account" && favorites.isMarked(e.account.dir),
    restoreCopy: positions.pinned ? (e) => keyOf(e) === positions.selected : undefined,
  });
  const entry = filter.none ? undefined : entries[index];
  const account = entry?.kind === "account" ? entry.account : undefined;
  const trashed = entry?.kind === "trashed" ? entry.entry : undefined;
  useEffect(() => {
    if (entry && !trashOpen) positions.select(keyOf(entry), undefined, filter.copySelected);
  }, [entry && keyOf(entry), filter.copySelected]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setTick((n) => n + 1), Math.max(RUNNING_MS, TIMING.activityPoll));
    return () => clearInterval(timer);
  }, [visible]);
  const details = useMemo(
    () => (account && visible ? { plugin: accountPlugin(account.dir), sessions: accountSessions(account.dir, cwd) } : undefined),
    [account?.dir, cwd, visible, state.accounts, reads],
  );
  const running = useMemo(() => (account && visible ? accountRunning(account.dir) : []), [account?.dir, visible, tick, reads]);

  const isCurrent = (a: Account) => a.dir === state.current?.dir;
  const header = useMemo(() => {
    if (trashed)
      return fitHeader(
        previewHeader(trashed.account.email, previewWidth, {
          marker: "○ ",
          style: bold,
          details: [red(`in the trash since ${when(trashed.deletedAt)} · u restores it`), tilde(trashed.folder.from)],
        }),
        bodyHeight,
      );
    if (!account) return [];
    const marker = isCurrent(account) ? "● " : "○ ";
    return fitHeader(
      previewHeader(account.email, previewWidth, {
        marker,
        style: bold,
        details: [isCurrent(account) ? green("active: the account of the Claude Code this viewer follows") : dim("another account"), tilde(account.dir)],
      }),
      bodyHeight,
    );
  }, [account, trashed, state.current?.dir, previewWidth, bodyHeight]);

  const lines = useMemo(() => {
    if (!entry) return [dim(trashOpen ? "The trash is empty." : "No account matches the filter")];
    if (entry.kind === "trashed") return trashedLines(entry.entry);
    if (entry.kind !== "account") return accountLines({ account: entry.kind }, state, settings, previewWidth);
    const a = entry.account;
    const field = (name: string, value: string | undefined) => (value ? [`  ${dim(`${name}:`)} ${value}`] : []);
    const out: string[] = [heading("Account")];
    out.push(
      ...field("name", a.name),
      ...field("organization", [a.organization, a.organizationType && `(${a.organizationType})`].filter(Boolean).join(" ")),
      ...field("billing", a.billing),
      ...field("seat", a.seat),
      ...field("rate limit tier", a.rateLimitTier),
      ...field("read from", tilde(a.file)),
      `  ${dim("colour:")} ${colorBadge(colorOfAccount(a, state, settings.accountColor))}${hasChosenColor(a, state, settings.accountColor) ? " chosen" : dim(" from the email")}`,
    );
    out.push("", heading("cco plugin"));
    if (details) {
      const p = details.plugin;
      out.push(
        p.installed ? (p.enabled ? `  ${green("✓")} installed and enabled` : `  ${yellow("!")} installed, but disabled`) : `  ${red("✗")} not installed: no hooks there, it gets installed when a session continues there`,
        ...field("marketplace", p.source ?? (p.marketplace ? "known" : "not added")),
      );
    }
    out.push("", heading(`Running now (${running.length})`));
    if (running.length === 0) out.push(dim("  no Claude Code runs with this account"));
    for (const r of running) {
      const what = r.activity === "busy" ? yellow("working") : r.activity === "waiting" ? yellow("waiting for input") : dim("idle");
      const project = r.cwd ? basename(r.cwd) : "?";
      out.push(`  ${green("▶")} ${project} · ${what} · ${dim(`${r.name ?? r.sessionId.slice(0, 8)} · pid ${r.pid}${r.kind === "bg" ? " · background" : ""}`)}`);
    }
    if (details) {
      const s = details.sessions;
      out.push("", heading(`Sessions of ${basename(cwd)} (${s.count})`));
      if (s.newest) out.push(...field("last written", when(s.newest.at)), ...field("newest", s.newest.title));
      if (s.continuedIn) out.push(`  ${magenta("⇢")} ${plural(s.continuedIn, "session")} continued in another account`);
      if (s.continuedFrom) out.push(`  ${magenta("⇠")} ${plural(s.continuedFrom, "session")} continued from another account`);
      if (!s.count) out.push(dim("  none in this project folder"));
    }
    out.push("");
    if (isCurrent(a)) out.push(dim("This is the account of the Claude Code the viewer follows."));
    out.push(dim("Enter: continue this session there, start a new session there (with or without the viewer), or open its config folder. d: move it to the trash (T shows the trash)."));
    return out;
  }, [entry, trashOpen, state, settings.accountColor, details, running, previewWidth, cwd]);

  const viewport = bodyHeightBelow(header, bodyHeight);
  const scroll = positions.scroll(entry && keyOf(entry), lines.length, viewport);
  const enter = () => {
    if (entry?.kind === "add") return flow.askAddAccount(cwd);
    if (!account) return;
    flow.accountMenu(account, cwd, sessionPath ? ownSession(sessionPath, cwd) : undefined, noSession);
  };
  const markedCount = state.accounts.filter((a) => favorites.isMarked(a.dir)).length;

  useInput(
    (input, key) => {
      if (filter.handleKey(input, key)) return;
      if (input === "T") return setTrashOpen(!trashOpen);
      if (trashOpen) {
        if (key.escape) return setTrashOpen(false);
        if (input === "u" && trashed) return flow.restore(trashed.id);
        if (input === "x" && trashed) return flow.askPurge(trashed, cwd);
        if (input === "X") return flow.askEmpty(trash, cwd);
        return handleNavigation(input, key, { ...filter.nav, scroll, page: viewport - 2 });
      }
      if (key.return) return enter();
      if (input === "d" && account) return flow.askTrash(account);
      if (input === "u" && flow.undoTrash()) return;
      if (input === "s") return setOrder(ACCOUNTS_ORDER_VALUES[(ACCOUNTS_ORDER_VALUES.indexOf(order) + 1) % ACCOUNTS_ORDER_VALUES.length]);
      const mark = markKeys(input, key);
      if (mark === "toggle") {
        if (!account) return;
        if (favorites.isMarked(account.dir)) filter.unmarking(index);
        return favorites.toggle(account.dir);
      }
      if (mark) {
        const target = filter.nextMark(mark);
        return target !== undefined && select(target);
      }
      handleNavigation(input, key, { ...filter.nav, scroll, page: viewport - 2 });
    },
    { isActive: active && !filter.open && !flow.open },
  );


  return (
    <>
      <Screen
        layout={layout}
        mode="accounts"
        status={
          <Text dimColor={!focused}>
            {trashOpen ? (
              <Text color="red">TRASH · {plural(trash.length, "account")}</Text>
            ) : (
              `${filter.count(state.accounts.length)} ${state.accounts.length === 1 ? "account" : "accounts"}`
            )}
            {entry && ` · ${scroll.position}`}
            {!trashOpen && markedCount > 0 && <Text color="yellow"> · ★ {markedCount}</Text>}
          </Text>
        }
        list={
          <List
            onPick={select}
            onClick={(i) => isDoubleClick(i) && i === index && !trashOpen && enter()}
            items={entries}
            shown={filter.shown}
            pinned={filter.pinned}
            filter={filter.banner}
            selected={index}
            centre={true}
            height={bodyHeight}
            empty={trashOpen ? "The trash is empty" : (filter.empty ?? "No accounts")}
            itemKey={keyOf}
            render={(e, isSelected) => {
              if (e.kind === "none") return <Text color="yellow">no account found: /login in Claude Code</Text>;
              if (e.kind === "details") return <Text dimColor={!isSelected}>how accounts are found</Text>;
              if (e.kind === "add") return <Text dimColor={!isSelected}>how to add an account</Text>;
              if (e.kind === "trashed") {
                const t = e.entry;
                const folder = basename(t.folder.from);
                return (
                  <>
                    <Text color="red">○ </Text>
                    <EntryText text={t.account.email} width={Math.max(4, listWidth - 3 - Math.min(folder.length, 16) - 1)} selected={isSelected} active={active} />
                    <Text dimColor> {folder.length > 16 ? `${folder.slice(0, 15)}…` : folder}</Text>
                  </>
                );
              }
              const a = e.account;
              const marked = favorites.isMarked(a.dir);
              const color = colorOfAccount(a, state, settings.accountColor);
              const folder = basename(a.dir);
              return (
                <>
                  {marked && <Star />}
                  <Text color={color}>{isCurrent(a) ? "● " : "○ "}</Text>
                  <EntryText text={a.email} width={Math.max(4, listWidth - 3 - (marked ? 2 : 0) - Math.min(folder.length, 16) - 1)} selected={isSelected} active={active} />
                  <Text dimColor> {folder.length > 16 ? `${folder.slice(0, 15)}…` : folder}</Text>
                </>
              );
            }}
          />
        }
        preview={<Preview header={header} lines={lines} scroll={scroll.scroll} width={previewWidth} height={bodyHeight} onWheel={(d) => scroll.by(d)} />}
        footer={
          flash ??
          (trashOpen
            ? [
                { text: "↑↓ account", priority: 4 },
                ...(trashed
                  ? [
                      { text: "u restore", priority: 4 },
                      { text: "x delete for good", priority: 3 },
                    ]
                  : []),
                ...(trash.length ? [{ text: "X empty", priority: 2 }] : []),
                { text: "T trash", on: true, priority: 3 },
                { text: "Esc back", priority: 2 },
              ]
            : [
            { text: "↑↓ account", priority: 4 },
            { text: "PgUp/Dn scroll", priority: 1 },
            ...markFooter(favorites.isMarked(account?.dir), markedCount),
            ...filter.footer,
            ...(account ? [{ text: "↵ actions…", priority: 3 }] : entry?.kind === "add" ? [{ text: "↵ add an account…", priority: 3 }] : []),
            ...(account ? [{ text: "d delete", priority: 2 }] : []),
            { text: `s order: ${order}`, on: order !== "email", priority: 2 },
            { text: "T trash", priority: 2 },
            { text: "0-6/tab view", priority: 1 },
          ])
        }
      />
      {flow.element}
      {filter.dialog}
    </>
  );
}
