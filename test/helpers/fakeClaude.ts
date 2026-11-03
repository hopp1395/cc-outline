import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export interface FakeRun {
  command: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean };
  stdin: string;
  killed: boolean;
  /** Prints `output` and ends the process. */
  finish: (output: string) => void;
}

/** What a `claude -p --output-format json` run prints for these blocks. */
export const claudeOutput = (blocks: { title: string; section?: string; text?: string }[]) =>
  JSON.stringify({ is_error: false, structured_output: { blocks: blocks.map((b) => ({ section: "", text: "", ...b })) } });

/** A `proc.spawn` that records the runs and lets the test end them. */
export function fakeSpawn() {
  const runs: FakeRun[] = [];
  const spawn = (command: string, argsOrOptions: unknown, maybeOptions?: unknown) => {
    const args = Array.isArray(argsOrOptions) ? (argsOrOptions as string[]) : [];
    const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) as FakeRun["options"];
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined as number | undefined, kill: () => {} });
    const run: FakeRun = {
      command,
      args,
      options,
      stdin: "",
      killed: false,
      finish: (output) => {
        child.stdout.end(output);
        child.stderr.end();
        child.stdout.once("end", () => child.emit("close", 0));
        child.stdout.resume();
      },
    };
    child.stdin.setEncoding("utf8").on("data", (chunk: string) => (run.stdin += chunk));
    child.kill = () => {
      run.killed = true;
      run.finish("");
    };
    runs.push(run);
    return child;
  };
  return { runs, spawn };
}
