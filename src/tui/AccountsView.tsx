import { Text, useInput } from "ink";
import { basename } from "node:path";
import { L } from "../i18n/index.js";
import { useEffect, useMemo, useState } from "react";
import stringWidth from "string-width";
import { ACCOUNT_COLORS, accountUsedAt, avatarOfAccount, colorOfAccount, hasChosenColor, type Account } from "../account.js";
import { DEFAULT_AVATAR } from "../avatar.js";
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
import { accountLines, avatarBadge, colorBadge, shortValueName, tilde } from "./SettingsView.js";
import { useAccountState, type AccountState } from "./useAccount.js";
import { useFavorites } from "./useFavorites.js";
import { useListFilter } from "./useListFilter.js";
import { usePositions } from "./usePositions.js";
import { useSetting, useSettings } from "./useSetting.js";
import { ownSession, useAccountFlow } from "./useAccountFlow.js";

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
  const m = L().accounts;
  return [
    heading(m.account),
    ...field(m.name, a.name),
    ...field(m.organization, [a.organization, a.organizationType && `(${a.organizationType})`].filter(Boolean).join(" ")),
    ...field(m.billing, a.billing),
    ...field(m.seat, a.seat),
    "",
    heading(m.inTrash),
    ...field(m.deleted, when(t.deletedAt)),
    ...field(m.folder, tilde(t.folder.from)),
    ...field(m.size, `${sizeText(t.size)} · ${L().counts.sessions(t.sessions)}`),
    ...(t.scripts.length ? t.scripts.map((s) => `  ${dim(m.script)} ${tilde(s.from)}`) : [dim(m.noScript)]),
    ...field(m.keptIn, tilde(t.folder.to)),
    "",
    dim(m.trashHelp),
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

export function AccountsView({ cwd, layout, visible, active, onTyping, onModal, sessionPath, noSession, claudePid, onTrashOpen }: Props) {
  const { listWidth, previewWidth, bodyHeight, headerHeight = bodyHeight, listHeight = bodyHeight } = layout;
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
  const flow = useAccountFlow({ layout, claudePid, notify: setFlash });
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
          details: [red(L().accounts.trashSince(when(trashed.deletedAt))), tilde(trashed.folder.from)],
        }),
        headerHeight,
      );
    if (!account) return [];
    const marker = isCurrent(account) ? "● " : "○ ";
    return fitHeader(
      previewHeader(account.email, previewWidth, {
        marker,
        style: bold,
        details: [isCurrent(account) ? green(L().accounts.active) : dim(L().accounts.another), tilde(account.dir)],
      }),
      headerHeight,
    );
  }, [account, trashed, state.current?.dir, previewWidth, headerHeight]);

  const lines = useMemo(() => {
    const m = L().accounts;
    if (!entry) return [dim(trashOpen ? m.trashEmpty : m.noMatch)];
    if (entry.kind === "trashed") return trashedLines(entry.entry);
    if (entry.kind !== "account") return accountLines({ account: entry.kind }, state, settings, previewWidth);
    const a = entry.account;
    const field = (name: string, value: string | undefined) => (value ? [`  ${dim(`${name}:`)} ${value}`] : []);
    const out: string[] = [heading(m.account)];
    out.push(
      ...field(m.name, a.name),
      ...field(m.organization, [a.organization, a.organizationType && `(${a.organizationType})`].filter(Boolean).join(" ")),
      ...field(m.billing, a.billing),
      ...field(m.seat, a.seat),
      ...field(m.rateLimitTier, a.rateLimitTier),
      ...field(m.readFrom, tilde(a.file)),
      `  ${dim(m.colour)} ${colorBadge(colorOfAccount(a, state, settings.accountColor))}${hasChosenColor(a, state, settings.accountColor) ? m.chosen : dim(m.fromEmail)}`,
      `  ${dim(m.avatar)} ${avatarOfAccount(a, state, settings.accountAvatar) ? avatarBadge(avatarOfAccount(a, state, settings.accountAvatar)!, colorOfAccount(a, state, settings.accountColor)) : dim(m.noAvatar(DEFAULT_AVATAR))}`,
    );
    out.push("", heading(m.plugin));
    if (details) {
      const p = details.plugin;
      out.push(
        p.installed ? (p.enabled ? `  ${green("✓")} ${m.enabled}` : `  ${yellow("!")} ${m.disabled}`) : `  ${red("✗")} ${m.notInstalled}`,
        ...field(m.marketplace, p.source ?? (p.marketplace ? m.known : m.notAdded)),
      );
    }
    out.push("", heading(m.runningNow(running.length)));
    if (running.length === 0) out.push(dim(m.noneRunning));
    for (const r of running) {
      const what = r.activity === "busy" ? yellow(m.working) : r.activity === "waiting" ? yellow(m.waiting) : dim(m.idle);
      const project = r.cwd ? basename(r.cwd) : "?";
      out.push(`  ${green("▶")} ${project} · ${what} · ${dim(`${r.name ?? r.sessionId.slice(0, 8)} · pid ${r.pid}${r.kind === "bg" ? m.background : ""}`)}`);
    }
    if (details) {
      const s = details.sessions;
      out.push("", heading(m.sessionsOf(basename(cwd), s.count)));
      if (s.newest) out.push(...field(m.lastWritten, when(s.newest.at)), ...field(m.newest, s.newest.title));
      if (s.continuedIn) out.push(`  ${magenta("⇢")} ${m.continuedIn(L().counts.sessions(s.continuedIn))}`);
      if (s.continuedFrom) out.push(`  ${magenta("⇠")} ${m.continuedFrom(L().counts.sessions(s.continuedFrom))}`);
      if (!s.count) out.push(dim(m.noneHere));
    }
    out.push("");
    if (isCurrent(a)) out.push(dim(m.isCurrent));
    out.push(dim(m.help));
    return out;
  }, [entry, trashOpen, state, settings.accountColor, settings.accountAvatar, details, running, previewWidth, cwd]);

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
              <Text color="red">{L().accounts.trash(L().counts.accounts(trash.length))}</Text>
            ) : (
              L().counts.accounts(state.accounts.length).replace(String(state.accounts.length), filter.count(state.accounts.length))
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
            height={listHeight}
            empty={trashOpen ? L().accounts.trashIsEmpty : (filter.empty ?? L().accounts.noAccounts)}
            itemKey={keyOf}
            render={(e, isSelected) => {
              if (e.kind === "none") return <Text color="yellow">{L().accounts.noneFound}</Text>;
              if (e.kind === "details") return <Text dimColor={!isSelected}>{L().settings.account.details}</Text>;
              if (e.kind === "add") return <Text dimColor={!isSelected}>{L().settings.account.add}</Text>;
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
              const avatar = avatarOfAccount(a, state, settings.accountAvatar);
              const folder = basename(a.dir);
              // The avatar at the right end, on the account's colour as in the top bar.
              const badge = avatar ? ` ${avatar} ` : "";
              return (
                <>
                  {marked && <Star />}
                  <Text color={color}>{isCurrent(a) ? "● " : "○ "}</Text>
                  <EntryText
                    text={a.email}
                    width={Math.max(4, listWidth - 3 - (marked ? 2 : 0) - Math.min(folder.length, 16) - 1 - (badge ? stringWidth(badge) + 1 : 0))}
                    selected={isSelected}
                    active={active}
                  />
                  <Text dimColor> {folder.length > 16 ? `${folder.slice(0, 15)}…` : folder}</Text>
                  {badge && (
                    <Text>
                      {" "}
                      <Text color={ACCOUNT_COLORS[color]} backgroundColor={color}>
                        {badge}
                      </Text>
                    </Text>
                  )}
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
                { text: L().accounts.footer.account, priority: 4 },
                ...(trashed
                  ? [
                      { text: L().accounts.footer.restore, priority: 4 },
                      { text: L().accounts.footer.purge, priority: 3 },
                    ]
                  : []),
                ...(trash.length ? [{ text: L().accounts.footer.empty, priority: 2 }] : []),
                { text: L().accounts.footer.trash, on: true, priority: 3 },
                { text: L().accounts.footer.back, priority: 2 },
              ]
            : [
            { text: L().accounts.footer.account, priority: 4 },
            { text: L().chat.footer.scroll, priority: 1 },
            ...markFooter(favorites.isMarked(account?.dir), markedCount),
            ...filter.footer,
            ...(account ? [{ text: L().accounts.footer.actions, priority: 3 }] : entry?.kind === "add" ? [{ text: L().accounts.footer.add, priority: 3 }] : []),
            ...(account ? [{ text: L().accounts.footer.delete, priority: 2 }] : []),
            { text: L().accounts.footer.order(shortValueName(order)), on: order !== "email", priority: 2 },
            { text: L().accounts.footer.trash, priority: 2 },
            { text: L().accounts.footer.views, priority: 1 },
          ])
        }
      />
      {flow.element}
      {filter.dialog}
    </>
  );
}
