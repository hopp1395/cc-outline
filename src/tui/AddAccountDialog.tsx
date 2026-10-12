import { Text, useInput, usePaste } from "ink";
import { useState } from "react";
import type { AccountCheck } from "../addAccount.js";
import { editLine, insertable, lineOf } from "../filter.js";
import { LineField } from "./FilterDialog.js";
import { Dialog, truncate, type Layout } from "./layout.js";

const MAX_WIDTH = 64;

/**
 * Asks for the command and the config folder of a new account. `↑` `↓` / `Tab` switch the field, Enter checks them
 * (`check`, which may ask PowerShell and take a moment) and hands them on, Esc cancels. The folder follows the
 * command (`.claude-<command>`) until it is edited. An existing folder without an account needs a second Enter.
 */
export function AddAccountDialog({
  layout,
  binDir,
  onPath,
  check,
  onAdd,
  onCancel,
}: {
  layout: Layout;
  /** Where the start scripts go. */
  binDir: string;
  /** That folder is on the PATH. */
  onPath: boolean;
  check: (command: string, folder: string) => Promise<AccountCheck>;
  onAdd: (command: string, folder: string) => void;
  onCancel: () => void;
}) {
  const [command, setCommand] = useState(() => lineOf("cw"));
  const [folder, setFolder] = useState(() => lineOf(".claude-cw"));
  const [folderEdited, setFolderEdited] = useState(false);
  const [field, setField] = useState<0 | 1>(0);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<{ text: string; color: "red" | "yellow" }>();
  // The folder offered for reuse, until another Enter takes it or an edit drops it.
  const [reuse, setReuse] = useState<string>();

  const edit = (input: string, key: Parameters<typeof editLine>[2]) => {
    setMessage(undefined);
    setReuse(undefined);
    if (field === 0) {
      const next = editLine(command, input, key);
      setCommand(next);
      if (!folderEdited) setFolder(lineOf(`.claude-${next.text}`));
    } else {
      setFolder(editLine(folder, input, key));
      setFolderEdited(true);
    }
  };

  const submit = async () => {
    const [cmd, dir] = [command.text.trim(), folder.text.trim()];
    if (reuse) return onAdd(cmd, dir);
    setChecking(true);
    const result = await check(cmd, dir);
    setChecking(false);
    if ("problem" in result) return setMessage({ text: result.problem, color: "red" });
    if ("reuse" in result) {
      setReuse(result.reuse);
      return setMessage({ text: `${dir} exists without an account: Enter uses it`, color: "yellow" });
    }
    onAdd(cmd, dir);
  };

  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (key.return) return void submit();
      if (key.tab || key.upArrow || key.downArrow) return setField((f) => (f === 0 ? 1 : 0));
      edit(input, key);
    },
    { isActive: !checking },
  );
  usePaste((text) => edit(insertable(text), {}));

  const width = Math.min(MAX_WIDTH, layout.columns - 4);
  const label = (n: 0 | 1, text: string) => (
    <Text wrap="truncate" bold={field === n} color={field === n ? "cyan" : undefined}>
      {text}
    </Text>
  );
  // Title, blank, two lines, blank, two fields of two rows, blank, message, blank, keys, plus the border.
  return (
    <Dialog layout={layout} width={width} height={15}>
      <Text bold color="cyan" wrap="truncate">
        Add an account
      </Text>
      <Text> </Text>
      <Text dimColor wrap="truncate">
        {truncate(`Start scripts go to ${binDir}`, width - 4)}
      </Text>
      <Text color={onPath ? undefined : "yellow"} dimColor={onPath} wrap="truncate">
        {onPath ? "next to claude, on the PATH" : "not on the PATH yet: add it there"}
      </Text>
      <Text> </Text>
      {label(0, "Command (starts Claude Code with the account)")}
      {field === 0 ? <LineField line={command} width={width} /> : <Text wrap="truncate">{`  ${command.text}`}</Text>}
      {label(1, "Config folder in your home folder")}
      {field === 1 ? <LineField line={folder} width={width} /> : <Text wrap="truncate">{`  ${folder.text}`}</Text>}
      <Text> </Text>
      <Text color={checking ? "cyan" : message?.color} wrap="truncate">
        {checking ? "checking the name (PowerShell aliases, PATH)…" : (message?.text ?? " ")}
      </Text>
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="yellow">Enter</Text> add{"  "}
        <Text color="yellow">Tab</Text> field{"  "}
        <Text color="yellow">Esc</Text> cancel{"  "}
        <Text color="yellow">^U</Text> clear
      </Text>
    </Dialog>
  );
}
