import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchReleases,
  installedVersion,
  installKind,
  mergeReleases,
  packageRoot,
  readCachedReleases,
  runUpdate,
  saveReleases,
  updateState,
  type InstallKind,
  type Release,
  type StepResult,
  type UpdateState,
} from "../update.js";
import { VERSION } from "../version.js";

/** An update run from the Settings view: its steps as they go, then whether it worked. */
export interface UpdateRun {
  target: string;
  status: "running" | "done" | "failed";
  steps: StepResult[];
}

export interface Update {
  /** Newest first; from the cache until the check at the start answered. */
  releases: Release[];
  latest?: string;
  /** Epoch ms of the last check that reached npm or GitHub. */
  checkedAt?: number;
  /** The last check reached neither or only one of them: what shows is older. */
  stale: boolean;
  checking: boolean;
  /** The setting updateCheck: whether the viewer asks at its start. */
  enabled: boolean;
  install: InstallKind;
  root: string;
  state: UpdateState;
  run?: UpdateRun;
  /** The version this viewer was just updated to (it reopened afterwards): the top bar says so once. */
  notice?: string;
  /** Checks now (F5 in Settings), also with the setting off. */
  recheck: () => Promise<void>;
  /** Runs the update steps; the viewer reopens when they all succeed. */
  start: () => void;
  /** Reopens the viewer with the version installed now. */
  restart: () => void;
  /** Shows the update in Settings (a click on the top bar's version). */
  open: () => void;
}

const NO_UPDATE: Update = {
  releases: [],
  stale: false,
  checking: false,
  enabled: false,
  install: "dev",
  root: "",
  state: { kind: "none" },
  recheck: async () => {},
  start: () => {},
  restart: () => {},
  open: () => {},
};

/** The update state for the top bar and Settings; views rendered without App see none. */
export const UpdateContext = createContext<Update>(NO_UPDATE);
export const useUpdateInfo = () => useContext(UpdateContext);

/** How long the top bar says the viewer was updated. */
const NOTICE_MS = 15_000;

/**
 * Reads the cached releases at once and, with `enabled` (the updateCheck
 * setting at the start), asks npm and GitHub once. `onRestart` reopens the
 * viewer with the given version (App: `moveViewer`, then exit).
 */
export function useUpdate(opts: { enabled: boolean; updatedTo?: string; onOpen: () => void; onRestart: (version: string) => boolean }): Update {
  const root = useMemo(packageRoot, []);
  const install = useMemo(() => installKind(root), [root]);
  const [cache, setCache] = useState(readCachedReleases);
  const [installed, setInstalled] = useState(() => installedVersion(root));
  const [stale, setStale] = useState(false);
  const [checking, setChecking] = useState(false);
  const [run, setRun] = useState<UpdateRun>();
  const [notice, setNotice] = useState(opts.updatedTo);
  const handlers = useRef(opts);
  handlers.current = opts;

  const recheck = useCallback(async () => {
    setChecking(true);
    const fetched = await fetchReleases();
    const cached = readCachedReleases();
    const merged = mergeReleases(cached, fetched);
    if (merged && merged !== cached) saveReleases(merged);
    setCache(merged);
    setStale(fetched.latest === undefined || fetched.releases === undefined);
    setInstalled(installedVersion(root));
    setChecking(false);
  }, [root]);

  // Only at the start: switching the setting on later waits for the next start or F5.
  useEffect(() => {
    if (opts.enabled) void recheck();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const state = updateState(cache?.latest, VERSION, install, installed);

  const restart = useCallback(() => {
    const version = installedVersion(root);
    if (version) handlers.current.onRestart(version);
  }, [root]);

  const start = () => {
    if (state.kind !== "update" || run?.status === "running") return;
    const target = state.target;
    setRun({ target, status: "running", steps: [] });
    void runUpdate((steps) => setRun((r) => (r ? { ...r, steps } : r))).then((ok) => {
      setRun((r) => (r ? { ...r, status: ok ? "done" : "failed" } : r));
      setInstalled(installedVersion(root));
      if (ok) restart();
    });
  };

  return {
    releases: cache?.releases ?? [],
    latest: cache?.latest,
    checkedAt: cache?.checkedAt,
    stale,
    checking,
    enabled: opts.enabled,
    install,
    root,
    state,
    run,
    notice,
    recheck,
    start,
    restart,
    open: () => handlers.current.onOpen(),
  };
}
