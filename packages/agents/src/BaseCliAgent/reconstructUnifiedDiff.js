/**
 * Minimal unified-diff builder used to reconstruct `AgentFileChange.unifiedDiff`
 * locally from before/after text a harness already handed us (Claude Code /
 * Kimi tool_use input carries both `old_string`/`new_string` or full `content`
 * — no filesystem read needed). Line-level LCS diff, git-style headers.
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ lines: string[]; oldCount: number; newCount: number } | null} null when identical
 */
function diffLines(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  // LCS table.
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "ctx", text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "del", text: a[i], oldLine: i + 1 });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j], newLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: a[i], oldLine: i + 1 });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "add", text: b[j], newLine: j + 1 });
    j++;
  }
  return ops;
}
const CONTEXT = 3;
/**
 * @param {string} path
 * @param {string} oldText
 * @param {string} newText
 * @returns {string | undefined} unified diff, or undefined when texts are identical
 */
export function reconstructUnifiedDiff(path, oldText, newText) {
  if (oldText === newText) return undefined;
  const ops = diffLines(oldText, newText);
  const changedIndexes = ops.reduce((acc, op, idx) => {
    if (op.kind !== "ctx") acc.push(idx);
    return acc;
  }, /** @type {number[]} */ ([]));
  if (changedIndexes.length === 0) return undefined;
  // Group changed ops into hunks, expanding each by CONTEXT lines and
  // merging hunks whose context windows overlap.
  const ranges = [];
  for (const idx of changedIndexes) {
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(ops.length - 1, idx + CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }
  const hunks = ranges.map(({ start, end }) => {
    const slice = ops.slice(start, end + 1);
    let oldStart;
    let newStart;
    let oldCount = 0;
    let newCount = 0;
    const body = slice.map((op) => {
      if (op.kind === "ctx") {
        oldStart ??= op.oldLine;
        newStart ??= op.newLine;
        oldCount++;
        newCount++;
        return ` ${op.text}`;
      }
      if (op.kind === "del") {
        oldStart ??= op.oldLine;
        oldCount++;
        return `-${op.text}`;
      }
      newStart ??= op.newLine;
      newCount++;
      return `+${op.text}`;
    });
    oldStart ??= 1;
    newStart ??= 1;
    return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body.join("\n")}`;
  });
  return [`--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n");
}
