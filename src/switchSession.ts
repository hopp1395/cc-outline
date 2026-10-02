import { execFile, spawn } from "node:child_process";
import { detectTerminal } from "./open.js";
import type { Placement } from "./settings.js";
import type { RunningSession } from "./transcript/trash.js";

/**
 * Brings the terminal tab of a session running in another Claude Code to the
 * front. Returns what happened, for the help line.
 *
 * - tmux: the pane whose process is the Claude Code or one of its ancestors
 *   (`tmux list-panes -a`), selected with its window and session.
 * - Windows: Windows Terminal cannot name the tab a process runs in, so its
 *   tabs are looked up by title through UI Automation (`TAB_SCRIPT`). Claude
 *   Code shows the session's name there, behind a status mark; a cco viewer
 *   focused in that tab shows the same. Only a single match is selected.
 * - A session the Claude Code daemon runs has no tab unless a client is
 *   attached; then the help line names `claude attach`.
 */
export async function switchToSession(session: RunningSession, titles: string[]): Promise<string> {
  const names = [...new Set([session.name, ...titles].filter((t): t is string => !!t))];
  const attach = session.kind === "bg" && session.jobId ? ` · runs in the background: claude attach ${session.jobId}` : "";
  if (detectTerminal() === "tmux") {
    const pane = await tmuxPaneOf(session.pid);
    if (!pane) return `its tmux pane was not found${attach}`;
    await run("tmux", ["switch-client", "-t", pane, ";", "select-window", "-t", pane, ";", "select-pane", "-t", pane]);
    return "switched to its tmux pane";
  }
  if (process.platform === "win32") {
    if (!names.length) return `the session has no name to find its tab by${attach}`;
    const found = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(TAB_SCRIPT)], {
      CCO_TAB_TITLES: names.join("\n"),
    });
    const count = Number(found?.trim());
    if (count === 1) return "switched to its Windows Terminal tab";
    if (count > 1) return `${count} tabs are named “${names[0]}”: switch by hand`;
    return found === undefined ? "its tab could not be looked up" : `no tab named “${names[0]}” found${attach}`;
  }
  return `the session runs in another Claude Code${attach}`;
}

/** The command that makes a running Claude Code continue `sessionId`; /resume takes an id or a search term. */
export const resumeSlashCommand = (sessionId: string) => `/resume ${sessionId}`;

/**
 * How "continue it here" reaches the viewer's Claude Code: under tmux its pane, on Windows its console
 * (`CONSOLE_INPUT_SCRIPT`) gets the command typed in; elsewhere it is copied for the user to paste.
 */
export function resumeHereMethod(terminal = detectTerminal(), platform: NodeJS.Platform = process.platform): "keys" | "clipboard" {
  return terminal === "tmux" || platform === "win32" ? "keys" : "clipboard";
}

/**
 * Types `/resume <id>` into the Claude Code process `claudePid` and submits it: into its tmux pane, or on
 * Windows into its console's input. Ctrl+L (Claude Code's chat:clearInput) first drops whatever was typed
 * there, and Enter comes on its own a moment later: typed together, Claude Code may take it all for a paste.
 * `typed` is false if it could not; the caller then copies the command instead.
 */
export async function resumeInClaude(claudePid: number, sessionId: string, typer?: ConsoleTyper): Promise<{ typed: boolean; message: string }> {
  const command = resumeSlashCommand(sessionId);
  if (detectTerminal() !== "tmux") {
    const console = typer ?? prepareConsoleInput(claudePid);
    if (!console) return { typed: false, message: "no tmux to type it in" };
    return (await console.type(command)) ? { typed: true, message: "continuing it in this Claude Code" } : { typed: false, message: "it could not be typed into Claude Code" };
  }
  const pane = await tmuxPaneOf(claudePid);
  if (!pane) return { typed: false, message: "its tmux pane was not found" };
  const typed =
    (await run("tmux", ["send-keys", "-t", pane, "C-l"])) !== undefined &&
    (await run("tmux", ["send-keys", "-t", pane, "-l", command])) !== undefined;
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (!typed || (await run("tmux", ["send-keys", "-t", pane, "Enter"])) === undefined) return { typed: false, message: "the command could not be typed into its pane" };
  await run("tmux", ["select-pane", "-t", pane]);
  return { typed: true, message: "continuing it in this Claude Code" };
}

/** A PowerShell started ahead (`prepareConsoleInput`), ready to type into one Claude Code's console. */
export interface ConsoleTyper {
  /** Types `text` and Enter; true once it did. Only once. */
  type(text: string): Promise<boolean>;
  /** Ends it without typing. */
  cancel(): void;
}

/** How long a typer waits for its text before it ends by itself. */
const TYPER_IDLE_MS = 5 * 60_000;
/** How long typing may take once asked. */
const TYPER_TIMEOUT_MS = 30_000;

/**
 * Starts PowerShell with `CONSOLE_INPUT_SCRIPT` for the Claude Code process `claudePid`, on Windows only.
 * Starting PowerShell takes about a second, more under load, so the Sessions view does so when it
 * offers "continue it here"; the text then arrives on stdin and is typed at once.
 */
export function prepareConsoleInput(claudePid: number, platform: NodeJS.Platform = process.platform): ConsoleTyper | undefined {
  if (platform !== "win32") return undefined;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(CONSOLE_INPUT_SCRIPT)], {
    windowsHide: true,
    env: { ...process.env, CCO_CLAUDE_PID: String(claudePid) },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.on?.("error", () => {});
  const exited = new Promise<void>((resolve) => child.on?.("exit", () => resolve()));
  const idle = setTimeout(() => child.kill(), TYPER_IDLE_MS);
  idle.unref?.();
  let used = false;
  return {
    async type(text) {
      if (used) return false;
      used = true;
      clearTimeout(idle);
      const timeout = setTimeout(() => child.kill(), TYPER_TIMEOUT_MS);
      child.stdin?.end(`${text}\n`);
      await exited;
      clearTimeout(timeout);
      return output.trim() === "ok";
    },
    cancel() {
      used = true;
      clearTimeout(idle);
      child.stdin?.end();
      child.kill();
    },
  };
}

/**
 * Types a line read from stdin into the console of process CCO_CLAUDE_PID and presses Enter. PowerShell
 * declares the kernel32 calls first, so it can be started ahead and wait for the line; then it leaves its
 * own (hidden) console, attaches to that one and writes key events (INPUT_RECORDs of 20 bytes) into its
 * input buffer, which Windows Terminal's pseudo console hands to Claude Code like typed keys, whichever
 * tab or pane has the focus. Ctrl+L first, the text after 100 ms, Enter 150 ms later. Prints "ok", else
 * the step that failed; nothing for an empty line (cancelled). The calls are declared through
 * Reflection.Emit: Add-Type compiled the same with csc in ~10 s (likely the virus scanner on the new DLL).
 */
export const CONSOLE_INPUT_SCRIPT = String.raw`
$asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'CcoConsole'), 'Run')
$type = $asm.DefineDynamicModule('CcoConsole').DefineType('CcoConsole', 'Public,Class')
foreach ($f in @(
  @('FreeConsole', [bool], @()),
  @('AttachConsole', [bool], @([uint32])),
  @('CreateFileW', [IntPtr], @([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])),
  @('WriteConsoleInputW', [bool], @([IntPtr], [byte[]], [uint32], [uint32].MakeByRefType()))
)) {
  $m = $type.DefinePInvokeMethod($f[0], 'kernel32.dll', 'Public,Static,PinvokeImpl', 'Standard', $f[1], [Type[]]$f[2], 'Winapi', 'Unicode')
  $m.SetImplementationFlags('PreserveSig')
}
$K = $type.CreateType()

function Keys([string]$chars, [int]$vk, [int]$ctrl) {
  $out = New-Object byte[] ($chars.Length * 40)
  $i = 0
  foreach ($c in $chars.ToCharArray()) {
    foreach ($down in 1, 0) {
      [BitConverter]::GetBytes([uint16]1).CopyTo($out, $i)
      [BitConverter]::GetBytes([int32]$down).CopyTo($out, $i + 4)
      [BitConverter]::GetBytes([uint16]1).CopyTo($out, $i + 8)
      [BitConverter]::GetBytes([uint16]$vk).CopyTo($out, $i + 10)
      [BitConverter]::GetBytes([uint16][int]$c).CopyTo($out, $i + 14)
      [BitConverter]::GetBytes([uint32]$ctrl).CopyTo($out, $i + 16)
      $i += 20
    }
  }
  ,$out
}
function Send([byte[]]$records) {
  $written = [uint32]0
  $K::WriteConsoleInputW($script:conin, $records, [uint32]($records.Length / 20), [ref]$written)
}

$text = [Console]::In.ReadLine()
if (-not $text) { exit }
[void]$K::FreeConsole()
if (-not $K::AttachConsole([uint32]$env:CCO_CLAUDE_PID)) { [Console]::Out.Write('attach'); exit }
$script:conin = $K::CreateFileW('CONIN$', [uint32]3221225472, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
if ($script:conin.ToInt64() -eq -1) { [Console]::Out.Write('conin'); exit }
if (-not (Send (Keys ([string][char]12) 0x4C 8))) { [Console]::Out.Write('write'); exit }
Start-Sleep -Milliseconds 100
if (-not (Send (Keys $text 0 0))) { [Console]::Out.Write('write'); exit }
Start-Sleep -Milliseconds 150
if (Send (Keys ([string][char]13) 13 0)) { [Console]::Out.Write('ok') } else { [Console]::Out.Write('write') }
`;

/**
 * Moves the keyboard focus from the viewer to the Claude Code pane next to it in Windows Terminal, so the
 * copied command can be pasted right away. Only for a viewer docked in Claude Code's tab; false otherwise.
 */
export function focusClaudePane(placement: Placement | undefined): boolean {
  if (detectTerminal() !== "wt" || !process.env.WT_SESSION || (placement !== "right" && placement !== "left")) return false;
  spawn("wt", ["-w", "0", "move-focus", placement === "right" ? "left" : "right"], { stdio: "ignore", detached: true, windowsHide: true }).unref();
  return true;
}

/** The id (`%3`) of the tmux pane whose process is `pid` or one of its ancestors. */
async function tmuxPaneOf(pid: number): Promise<string | undefined> {
  const list = await run("tmux", ["list-panes", "-a", "-F", "#{pane_pid} #{pane_id}"]);
  if (!list) return undefined;
  return paneOf(pid, parsePanes(list), (p) => run("ps", ["-o", "ppid=", "-p", String(p)]).then((out) => Number(out?.trim()) || undefined));
}

/** `tmux list-panes -F "#{pane_pid} #{pane_id}"` output as pane id by process id. */
export function parsePanes(list: string): Map<number, string> {
  const panes = new Map<number, string>();
  for (const line of list.split("\n")) {
    const [pid, id] = line.trim().split(" ");
    if (pid && id) panes.set(Number(pid), id);
  }
  return panes;
}

/** The pane of `pid` or of its nearest ancestor that has one, going up through `parentOf`. */
export async function paneOf(
  pid: number,
  panes: Map<number, string>,
  parentOf: (pid: number) => Promise<number | undefined>,
): Promise<string | undefined> {
  let current: number | undefined = pid;
  for (let depth = 0; current && current > 1 && depth < 20; depth++) {
    const pane = panes.get(current);
    if (pane) return pane;
    current = await parentOf(current);
  }
  return undefined;
}

/** stdout of the command, or undefined if it failed. */
function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 10_000, env: env && { ...process.env, ...env } }, (err, stdout) =>
      resolve(err ? undefined : String(stdout)),
    );
  });
}

/** A script for PowerShell's -EncodedCommand (UTF-16LE, base64), so nothing needs quoting. */
const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");

/**
 * Selects the Windows Terminal tab whose title, without Claude Code's status
 * mark (✳, ◐, ◑), is one of the lines of CCO_TAB_TITLES, and brings its window
 * to the front; only if exactly one tab matches. Prints the number of matches.
 */
export const TAB_SCRIPT = String.raw`
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Cco -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
'@
$titles = $env:CCO_TAB_TITLES -split "\n"
$A = [System.Windows.Automation.AutomationElement]
$windows = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
$tabs = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$hits = @()
foreach ($w in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $windows)) {
  foreach ($t in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabs)) {
    $name = ($t.Current.Name -replace '^[✳◐◑]\s*', '').Trim()
    if ($titles -contains $name) { $hits += , @($w, $t) }
  }
}
if ($hits.Count -eq 1) {
  $w = $hits[0][0]
  $hits[0][1].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
  $h = [IntPtr]$w.Current.NativeWindowHandle
  if ([Cco.Win]::IsIconic($h)) { [void][Cco.Win]::ShowWindow($h, 9) }
  [void][Cco.Win]::SetForegroundWindow($h)
}
[Console]::Out.Write($hits.Count)
`;
