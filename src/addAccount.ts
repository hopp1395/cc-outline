import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { L } from "./i18n/index.js";
import { delimiter, join, relative, isAbsolute } from "node:path";
import { readAccount } from "./account.js";
import { proc } from "./proc.js";

/**
 * Adding an account: a config folder of its own (`~/.claude-<name>`, which `findAccounts` finds), and start scripts
 * next to `claude` that run it under that folder. The command's name is checked first against what a shell would
 * run instead of the script: PowerShell aliases (they win over files: `cp` runs Copy-Item, not cp.cmd), the
 * built-in commands of cmd and Bash, and programs of the same name on the PATH.
 */

/** The home folder new accounts go into; an object, so tests can put them somewhere else (os.homedir ignores a changed USERPROFILE). */
export const accountsHome = { get: (): string => homedir() };

/** The aliases Windows PowerShell 5.1 defines by default; used when PowerShell cannot be asked. */
export const POWERSHELL_ALIASES = [
  "%", "?", "ac", "asnp", "cat", "cd", "chdir", "clc", "clear", "clhy", "cli", "clp", "cls", "clv", "cnsn", "compare", "copy", "cp", "cpi",
  "cpp", "curl", "cvpa", "dbp", "del", "diff", "dir", "dnsn", "ebp", "echo", "epal", "epcsv", "epsn", "erase", "etsn", "exsn", "fc", "fhx",
  "fl", "foreach", "ft", "fw", "gal", "gbp", "gc", "gcb", "gci", "gcm", "gcs", "gdr", "ghy", "gi", "gin", "gjb", "gl", "gm", "gmo", "gp",
  "gps", "gpv", "group", "gsn", "gsnp", "gsv", "gtz", "gu", "gv", "gwmi", "h", "history", "icm", "iex", "ihy", "ii", "ipal", "ipcsv", "ipmo",
  "ipsn", "irm", "ise", "iwmi", "iwr", "kill", "lp", "ls", "man", "md", "measure", "mi", "mount", "move", "mp", "mv", "nal", "ndr", "ni",
  "nmo", "npssc", "nsn", "nv", "ogv", "oh", "popd", "ps", "pushd", "pwd", "r", "rbp", "rcjb", "rcsn", "rd", "rdr", "ren", "ri", "rjb", "rm",
  "rmdir", "rmo", "rni", "rnp", "rp", "rsn", "rsnp", "rujb", "rv", "rvpa", "rwmi", "sajb", "sal", "saps", "sasv", "sbp", "sc", "scb",
  "select", "set", "shcm", "si", "sl", "sleep", "sls", "sort", "sp", "spjb", "spps", "spsv", "start", "stz", "sujb", "sv", "swmi", "tee",
  "trcm", "type", "wget", "where", "wjb", "write",
];

/** The commands cmd runs itself, before looking for a file. */
export const CMD_BUILTINS = [
  "assoc", "break", "call", "cd", "chdir", "cls", "color", "copy", "date", "del", "dir", "dpath", "echo", "endlocal", "erase", "exit", "for",
  "ftype", "goto", "if", "keys", "md", "mkdir", "mklink", "move", "path", "pause", "popd", "prompt", "pushd", "rd", "rem", "ren", "rename",
  "rmdir", "set", "setlocal", "shift", "start", "time", "title", "type", "ver", "verify", "vol",
];

/** Bash's builtins and keywords, which win over a script of the same name. */
export const BASH_BUILTINS = [
  "alias", "bg", "bind", "break", "builtin", "caller", "case", "cd", "command", "compgen", "complete", "compopt", "continue", "declare", "dirs",
  "disown", "do", "done", "echo", "elif", "else", "enable", "esac", "eval", "exec", "exit", "export", "false", "fc", "fg", "fi", "for",
  "function", "getopts", "hash", "help", "history", "if", "in", "jobs", "kill", "let", "local", "logout", "mapfile", "popd", "printf", "pushd",
  "pwd", "read", "readarray", "readonly", "return", "select", "set", "shift", "shopt", "source", "suspend", "test", "then", "time", "times",
  "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "until", "wait", "while",
];

/** A command name a start script can have: letters, digits, `-` and `_`, starting with a letter. */
export const COMMAND_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** A config folder `findAccounts` finds: `.claude-<name>` in the home folder. */
export const FOLDER_PATTERN = /^\.claude-[A-Za-z0-9._-]+$/;

/** The folder to put start scripts in: the one `claude` is found in on the PATH, else `~/.local/bin`. */
export function claudeBinDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = accountsHome.get()): { dir: string; onPath: boolean } {
  const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const dir of pathDirs(env)) if (names.some((n) => isFile(join(dir, n)))) return { dir, onPath: true };
  const fallback = join(home, ".local", "bin");
  return { dir: fallback, onPath: pathDirs(env).some((d) => same(d, fallback, platform)) };
}

const pathDirs = (env: NodeJS.ProcessEnv) => (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
const same = (a: string, b: string, platform: NodeJS.Platform) => (platform === "win32" ? a.toLowerCase().replace(/[\\/]+$/, "") === b.toLowerCase().replace(/[\\/]+$/, "") : a === b);

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A program `name` on the PATH (with the endings Windows tries), outside `except` (the scripts' own folder). */
export function commandOnPath(name: string, except?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const endings = platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())] : [""];
  for (const dir of pathDirs(env)) {
    if (except && same(dir, except, platform)) continue;
    for (const ending of endings) if (isFile(join(dir, name + ending))) return join(dir, name + ending);
  }
  return undefined;
}

/**
 * The aliases PowerShell defines here, by name (lower case) with what they stand for: asked from Windows PowerShell
 * and PowerShell 7, with the user's profile, so its own aliases count too. Undefined where neither answers.
 */
export async function powershellAliases(timeout = 15_000): Promise<Map<string, string> | undefined> {
  const script = "Get-Alias | ForEach-Object { $_.Name + '=' + $_.Definition }";
  const ask = (exe: string) =>
    new Promise<string | undefined>((resolve) => {
      try {
        proc.execFile(exe, ["-NoLogo", "-NonInteractive", "-Command", script], { timeout, windowsHide: true }, (err, stdout) => resolve(err ? undefined : String(stdout)));
      } catch {
        resolve(undefined);
      }
    });
  const answers = await Promise.all([ask("powershell.exe"), ask("pwsh")]);
  if (answers.every((a) => a === undefined)) return undefined;
  const aliases = new Map<string, string>();
  for (const line of answers.join("\n").split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) aliases.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return aliases;
}

/** The start scripts of the account: their file, their text and whether they must be executable. */
export interface StartScript {
  file: string;
  text: string;
  executable: boolean;
}

/** The scripts that start Claude Code under `folder`: `<command>.cmd` and a Bash script on Windows, the Bash script elsewhere. */
export function startScripts(command: string, folder: string, binDir: string, platform: NodeJS.Platform = process.platform, home = accountsHome.get()): StartScript[] {
  const rel = relative(home, folder);
  const inHome = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  const shown = inHome ? `~/${rel.replace(/\\/g, "/")}` : folder;
  const about = `Starts Claude Code with the account in ${shown} (its own login, sessions and settings).`;
  const first = "Written by cco. First start: sign in with /login.";
  const bash = (dir: string) =>
    ["#!/usr/bin/env bash", `# ${about}`, `# ${first}`, `export CLAUDE_CONFIG_DIR="${dir}"`, 'exec claude "$@"', ""].join("\n");
  if (platform !== "win32") return [{ file: join(binDir, command), text: bash(inHome ? `$HOME/${rel}` : folder), executable: true }];
  const cmdDir = inHome ? `%USERPROFILE%\\${rel}` : folder;
  const cmd = ["@echo off", `rem ${about}`, `rem ${first}`, "setlocal", `set "CLAUDE_CONFIG_DIR=${cmdDir}"`, "call claude %*", "exit /b %errorlevel%", ""].join("\r\n");
  // Git Bash hands the variable to claude.exe as it is: a Windows path, not /c/Users/….
  return [
    { file: join(binDir, `${command}.cmd`), text: cmd, executable: false },
    { file: join(binDir, command), text: bash(inHome ? `$USERPROFILE\\${rel}` : folder), executable: true },
  ];
}

/** What the check of a new account says: a reason to refuse it, an existing folder to use again, or nothing against it. */
export type AccountCheck = { problem: string } | { reuse: string } | { ok: true };

/**
 * Checks the command and the folder of a new account. `aliases`: PowerShell's, if it could be asked (else the
 * default ones are taken on Windows).
 */
export function checkNewAccount(
  command: string,
  folderName: string,
  { binDir, aliases, env = process.env, platform = process.platform, home = accountsHome.get() }: { binDir: string; aliases?: Map<string, string>; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string },
): AccountCheck {
  if (!COMMAND_PATTERN.test(command)) return { problem: L().addAccountCheck.pattern };
  if (!FOLDER_PATTERN.test(folderName)) return { problem: L().addAccountCheck.folder };
  const name = command.toLowerCase();
  if (platform === "win32") {
    const alias = aliases?.get(name) ?? (aliases ? undefined : POWERSHELL_ALIASES.includes(name) ? L().addAccountCheck.builtin : undefined);
    if (alias) return { problem: L().addAccountCheck.alias(command, alias) };
    if (CMD_BUILTINS.includes(name)) return { problem: L().addAccountCheck.cmd(command) };
  }
  if (BASH_BUILTINS.includes(name)) return { problem: L().addAccountCheck.bash(command) };
  const other = commandOnPath(command, binDir, env, platform);
  if (other) return { problem: L().addAccountCheck.onPath(command, other) };
  const script = startScripts(command, join(home, folderName), binDir, platform, home).find((s) => existsSync(s.file));
  if (script) return { problem: L().addAccountCheck.exists(script.file) };
  const folder = join(home, folderName);
  if (existsSync(folder)) {
    const account = readAccount(folder, home);
    if (account) return { problem: L().addAccountCheck.taken(folderName, account.email) };
    return { reuse: folder };
  }
  return { ok: true };
}

/** Creates the config folder (if new) and writes the start scripts; returns the scripts written. */
export function writeAccountFiles(command: string, folder: string, binDir: string, platform: NodeJS.Platform = process.platform, home = accountsHome.get()): StartScript[] {
  mkdirSync(folder, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const scripts = startScripts(command, folder, binDir, platform, home);
  for (const s of scripts) {
    // wx: never over a file that turned up since the check.
    writeFileSync(s.file, s.text, { flag: "wx" });
    if (s.executable && platform !== "win32") chmodSync(s.file, 0o755);
  }
  return scripts;
}
