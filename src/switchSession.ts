import { execFile } from "node:child_process";
import { detectTerminal } from "./open.js";
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
