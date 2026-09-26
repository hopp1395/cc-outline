export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  binary: boolean;
  hunks: Hunk[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses the unified diff of a single file. File headers before the first hunk are skipped. */
export function parseDiff(text: string): ParsedDiff {
  const result: ParsedDiff = { binary: false, hunks: [] };
  let hunk: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.split("\n")) {
    // CRLF files keep their \r in git's output; a BOM would shift the first line.
    const line = raw.replace(/\r$/, "").replace(/^([ +-]?)﻿/, "$1");
    const header = HUNK.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      hunk = { header: line, lines: [] };
      result.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (/^Binary files .* differ$/.test(line)) result.binary = true;
      continue;
    }
    const sign = line[0];
    const body = line.slice(1);
    if (sign === "+") hunk.lines.push({ kind: "add", text: body, newNo: newNo++ });
    else if (sign === "-") hunk.lines.push({ kind: "del", text: body, oldNo: oldNo++ });
    else if (sign === " ") hunk.lines.push({ kind: "ctx", text: body, oldNo: oldNo++, newNo: newNo++ });
    // "\ No newline at end of file" and trailing empty lines carry no content.
  }
  return result;
}
