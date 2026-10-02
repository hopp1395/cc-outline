import { execFile, spawn } from "node:child_process";

/**
 * How the viewer starts programs (terminals, PowerShell, clipboard tools). One object read at each call,
 * so tests can swap in fakes without mocking `node:child_process`, which needs a module cache per test file.
 */
export const proc = { spawn, execFile };
