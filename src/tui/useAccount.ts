import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { accountInfo, avatarOfAccount, colorOfAccount, type AccountColorName, type AccountInfo } from "../account.js";
import { useSetting } from "./useSetting.js";

/** How often the account folders are read again (a login in another terminal shows up). */
const REFRESH_MS = 30_000;

/** What the viewer knows of the accounts, for the top bar, the title and the Settings view. */
export interface AccountState extends AccountInfo {
  /** The shown account's colour; undefined without an account. */
  color?: AccountColorName;
  /** The shown account's avatar; undefined keeps "cco". */
  avatar?: string;
  /** Reads the folders again at once (an account moved to the trash or back). */
  refresh?: () => void;
}

const EMPTY: AccountState = { accounts: [], multiple: false, own: "" };

export const AccountContext = createContext<AccountState>(EMPTY);

export const useAccountState = () => useContext(AccountContext);

/** The accounts found and the shown one (that of Claude Code process `pid`, else of this viewer's folder). */
export function useAccounts(pid?: number): AccountState {
  const [tick, setTick] = useState(0);
  const [chosen] = useSetting("accountColor");
  const [avatar] = useSetting("accountAvatar");
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const info = useMemo(() => accountInfo(pid), [pid, tick]);
  return {
    ...info,
    color: info.current && colorOfAccount(info.current, info, chosen),
    avatar: info.current && avatarOfAccount(info.current, info, avatar),
    refresh: () => setTick((t) => t + 1),
  };
}
