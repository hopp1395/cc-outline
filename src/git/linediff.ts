import type { DiffLine, Hunk, ParsedDiff } from "./diff.js";

/** Lines of context kept around changes, as in git's default. */
const CONTEXT = 3;

/**
 * Line diff of two texts (longest common subsequence), grouped into hunks
 * like `git diff -U3`. Meant for documents such as plans, not large files.
 */
export function diffLines(oldText: string, newText: string): ParsedDiff {
  const a = oldText.replace(/\r/g, "").split("\n");
  const b = newText.replace(/\r/g, "").split("\n");
  if (a.at(-1) === "") a.pop();
  if (b.at(-1) === "") b.pop();

  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: "ctx", text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // Removed lines before added ones, as git shows a replaced line.
      lines.push({ kind: "del", text: a[i], oldNo: i + 1 });
      i++;
    } else {
      lines.push({ kind: "add", text: b[j], newNo: j + 1 });
      j++;
    }
  }
  return { binary: false, hunks: toHunks(lines) };
}

/** Keeps changed lines with CONTEXT lines around them; nearby changes share a hunk. */
function toHunks(lines: DiffLine[]): Hunk[] {
  const changed = lines.map((l, i) => (l.kind === "ctx" ? -1 : i)).filter((i) => i >= 0);
  const hunks: Hunk[] = [];
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k] - CONTEXT);
    let end = Math.min(lines.length, changed[k] + CONTEXT + 1);
    while (k + 1 < changed.length && changed[k + 1] - CONTEXT <= end) {
      k++;
      end = Math.min(lines.length, changed[k] + CONTEXT + 1);
    }
    k++;
    const slice = lines.slice(start, end);
    hunks.push({ header: hunkHeader(slice, lines, start), lines: slice });
  }
  return hunks;
}

function hunkHeader(slice: DiffLine[], all: DiffLine[], start: number): string {
  // Line numbers where the hunk starts on each side (for an empty side: the line before).
  const before = all.slice(0, start);
  const oldStart = (slice.find((l) => l.oldNo)?.oldNo ?? before.filter((l) => l.oldNo).length) || 0;
  const newStart = (slice.find((l) => l.newNo)?.newNo ?? before.filter((l) => l.newNo).length) || 0;
  const oldCount = slice.filter((l) => l.kind !== "add").length;
  const newCount = slice.filter((l) => l.kind !== "del").length;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}
