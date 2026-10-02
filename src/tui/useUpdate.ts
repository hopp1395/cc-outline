import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  compareVersions,
  fetchReleases,
  installedVersion,
  installKind,
  mergeReleases,
  packageRoot,
  readCachedReleases,
  releasesBetween,
  runUpdate,
  saveReleases,
  takeSeenVersion,
  updateState,
  type InstallKind,
  type Release,
  type StepResult,
  type UpdateState,
} from "../update.js";
import type { UpdateMode } from "../settings.js";
import { VERSION } from "../version.js";
import { TIMING } from "../timing.js";

/** An update run from the Settings view: its steps as they go, then whether it worked. */
export interface UpdateRun {
  target: string;
  status: "running" | "done" | "failed";
  steps: StepResult[];
  /** Done, but the viewer could not reopen itself (no supported terminal): it has to be closed and opened by hand. */
  reopenFailed?: boolean;
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
  /** The setting update at the start: whether the viewer asks (on, auto) and offers the update at once (auto). */
  mode: UpdateMode;
  /** With auto: the check at the start found an update, so the viewer offers it (once). */
  offer: boolean;
  install: InstallKind;
  root: string;
  state: UpdateState;
  run?: UpdateRun;
  /** The version this viewer was just updated to (it reopened afterwards): the top bar says so once. */
  notice?: string;
  /** The notes of every version since the one a viewer ran before (skipped ones too), newest first; empty once closed. */
  whatsNew: Release[];
  /** The version the notes start after. */
  whatsNewFrom?: string;
  closeWhatsNew: () => void;
  /** Checks now (F5 in Settings), also with the setting off. */
  recheck: () => Promise<void>;
  /** Runs the update steps; the viewer reopens when they all succeed. */
  start: () => void;
  /** Reopens the viewer with the version installed now; false if it could not. */
  restart: () => boolean;
  /** Shows the update in Settings (a click on the top bar's version). */
  open: () => void;
}

const NO_UPDATE: Update = {
  releases: [],
  stale: false,
  checking: false,
  mode: "off",
  offer: false,
  whatsNew: [],
  closeWhatsNew: () => {},
  install: "dev",
  root: "",
  state: { kind: "none" },
  recheck: async () => {},
  start: () => {},
  restart: () => false,
  open: () => {},
};

/** The update state for the top bar and Settings; views rendered without App see none. */
export const UpdateContext = createContext<Update>(NO_UPDATE);
export const useUpdateInfo = () => useContext(UpdateContext);

/** How long the top bar says the viewer was updated. */
const NOTICE_MS = 15_000;

/**
 * Reads the cached releases at once and, unless `mode` (the update setting
 * at the start) is off, asks npm and GitHub once; with auto, `offer` turns
 * true when that check found an update. `onRestart` reopens the
 * viewer with the given version (App: `moveViewer`, then exit).
 */
export function useUpdate(opts: { mode: UpdateMode; updatedTo?: string; onOpen: () => void; onRestart: (version: string) => boolean }): Update {
  const root = useMemo(packageRoot, []);
  const install = useMemo(() => installKind(root), [root]);
  const [cache, setCache] = useState(readCachedReleases);
  const [installed, setInstalled] = useState(() => installedVersion(root));
  const [stale, setStale] = useState(false);
  const [checking, setChecking] = useState(false);
  const [run, setRun] = useState<UpdateRun>();
  const [notice, setNotice] = useState(opts.updatedTo);
  const [startChecked, setStartChecked] = useState(false);
  // The version seen before this one. A viewer updated from a version that kept none says only
  // where it went (updatedTo): its notes then start after the release before this one.
  const [since, setSince] = useState(() => {
    const before = takeSeenVersion(VERSION);
    if (install !== "npm") return undefined;
    return before ? { from: before } : opts.updatedTo ? { from: undefined } : undefined;
  });
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
    if (opts.mode !== "off") void recheck().then(() => setStartChecked(true));
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const releases = cache?.releases ?? [];
  const from = since && (since.from ?? releases.find((r) => compareVersions(r.version, VERSION) < 0)?.version);
  const whatsNew = from ? releasesBetween(releases, from, VERSION) : [];

  const state = updateState(cache?.latest, VERSION, install, installed);

  const restart = useCallback(() => {
    const version = installedVersion(root);
    return version !== undefined && handlers.current.onRestart(version);
  }, [root]);

  const start = () => {
    if (state.kind !== "update" || run?.status === "running") return;
    const target = state.target;
    setRun({ target, status: "running", steps: [] });
    void runUpdate((steps) => setRun((r) => (r ? { ...r, steps } : r))).then((ok) => {
      setRun((r) => (r ? { ...r, status: ok ? "done" : "failed" } : r));
      setInstalled(installedVersion(root));
      if (ok) setTimeout(() => restart() || setRun((r) => r && { ...r, reopenFailed: true }), TIMING.restartDelay);
    });
  };

  return {
    releases,
    latest: cache?.latest,
    checkedAt: cache?.checkedAt,
    stale,
    checking,
    mode: opts.mode,
    offer: opts.mode === "auto" && startChecked && state.kind === "update" && !run,
    install,
    root,
    state,
    run,
    notice,
    whatsNew,
    whatsNewFrom: from,
    closeWhatsNew: () => setSince(undefined),
    recheck,
    start,
    restart,
    open: () => handlers.current.onOpen(),
  };
}
