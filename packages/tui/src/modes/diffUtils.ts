/**
 * Shape a gateway `getNodeDiff` payload into something the Diff tab can render.
 *
 * The gateway returns either a full `DiffBundle` (`{ seq, baseRef, patches:
 * [{ path, operation, diff }] }`, where each `diff` is unified-diff text) or a
 * stat-only payload (`{ seq, baseRef, summary: { filesChanged, added, removed,
 * files } }`) when the full bundle is too large. This normalizes both — plus the
 * "nothing changed / unavailable" cases — into a small view model so the
 * presentational component stays dumb and is trivially testable.
 */

export type NodeDiffView =
  | { kind: "patch"; unified: string; summary: string }
  | { kind: "stat"; summary: string; files: string }
  | { kind: "empty"; message: string };

type FilePatch = { path?: unknown; operation?: unknown; diff?: unknown };
type DiffSummaryFile = { path?: unknown; added?: unknown; removed?: unknown };

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * @param payload  The raw `getNodeDiff` RPC payload (or undefined while loading).
 */
export function toNodeDiffView(payload: unknown): NodeDiffView {
  if (!payload || typeof payload !== "object") {
    return { kind: "empty", message: "No diff available for this node." };
  }
  const rec = payload as Record<string, unknown>;

  // Full DiffBundle: render the concatenated unified patches.
  if (Array.isArray(rec["patches"])) {
    const patches = rec["patches"] as FilePatch[];
    const withText = patches.filter((p) => typeof p.diff === "string" && (p.diff as string).length > 0);
    if (withText.length === 0) {
      return { kind: "empty", message: "No file changes for this node iteration." };
    }
    const unified = withText
      .map((p) => {
        const path = typeof p.path === "string" ? p.path : "(unknown)";
        const op = typeof p.operation === "string" ? p.operation : "modify";
        return `# ${op} ${path}\n${(p.diff as string).replace(/\n$/, "")}`;
      })
      .join("\n");
    const noun = withText.length === 1 ? "file" : "files";
    return { kind: "patch", unified, summary: `${withText.length} ${noun} changed` };
  }

  // Stat-only payload (bundle too large): render the summary + per-file counts.
  const summaryRaw = rec["summary"];
  if (summaryRaw && typeof summaryRaw === "object") {
    const s = summaryRaw as Record<string, unknown>;
    const filesChanged = asNumber(s["filesChanged"]);
    const added = asNumber(s["added"]);
    const removed = asNumber(s["removed"]);
    const files = Array.isArray(s["files"]) ? (s["files"] as DiffSummaryFile[]) : [];
    const filesText = files
      .map((f) => {
        const path = typeof f.path === "string" ? f.path : "(unknown)";
        return `  ${path}  +${asNumber(f.added)} -${asNumber(f.removed)}`;
      })
      .join("\n");
    const noun = filesChanged === 1 ? "file" : "files";
    return {
      kind: "stat",
      summary: `${filesChanged} ${noun} changed  +${added} -${removed}  (diff too large to inline)`,
      files: filesText || "  (no per-file stats)",
    };
  }

  return { kind: "empty", message: "No diff available for this node." };
}
