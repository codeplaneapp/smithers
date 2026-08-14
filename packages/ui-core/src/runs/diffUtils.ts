/**
 * Shape a gateway `getNodeDiff` payload into something a Diff tab can render.
 * Moved verbatim from `packages/tui/src/modes/diffUtils.ts` (no opentui/DOM
 * dependency; a pure view-model transform).
 *
 * The gateway returns a full `DiffBundle` (`{ seq, baseRef, patches:
 * [{ path, operation, diff, binaryContent? }] }`, where each `diff` is the raw
 * `git diff --binary` chunk). A stat-only payload (`{ seq, baseRef, summary:
 * { filesChanged, added, removed, files } }`) is also normalized for callers
 * that request `--stat` shapes (the in-process CLI does; the gateway RPC does
 * NOT fall back to it automatically — an oversized bundle surfaces as a
 * DiffTooLarge RPC error instead, which callers must pass in as `error`).
 * This normalizes those — plus the RPC-error and "nothing changed /
 * unavailable" cases — into a small view model so the presentational component
 * stays dumb and is trivially testable.
 */

export type NodeDiffView =
  | { kind: "patch"; unified: string; summary: string; live?: boolean }
  | { kind: "stat"; summary: string; files: string; live?: boolean }
  | { kind: "error"; message: string }
  | { kind: "empty"; message: string };

type FilePatch = { path?: unknown; operation?: unknown; diff?: unknown; binaryContent?: unknown };
type DiffSummaryFile = { path?: unknown; added?: unknown; removed?: unknown };

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Matches the two shapes `git diff --binary` emits for binary files (the same
 * detection the engine's diff-bundle uses). Such chunks carry base85-encoded
 * literal data — potentially megabytes of it — which must never be rendered as
 * if it were a unified diff.
 */
const BINARY_PATCH_RE = /(^GIT binary patch$)|(^Binary files )/m;

function isBinaryPatch(patch: FilePatch, diffText: string): boolean {
  if (typeof patch.binaryContent === "string" && patch.binaryContent.length > 0) return true;
  return BINARY_PATCH_RE.test(diffText);
}

/**
 * @param payload  The raw `getNodeDiff` RPC payload (or undefined while loading).
 * @param error    The RPC error, if the request failed. Surfaced as a distinct
 *                 `error` view — a failed request (DiffTooLarge, dirty working
 *                 tree, gateway down, …) must NOT masquerade as the factually
 *                 different "No diff available".
 */
export function toNodeDiffView(payload: unknown, error?: Error | null): NodeDiffView {
  if (error) {
    const message = error.message.trim().length > 0 ? error.message : "diff request failed";
    return { kind: "error", message };
  }
  if (!payload || typeof payload !== "object") {
    return { kind: "empty", message: "No diff available for this node." };
  }
  const rec = payload as Record<string, unknown>;
  // A bundle computed from a live working copy (in-progress attempt) is
  // flagged by the gateway; surface it so watchers can tell a refreshing
  // preview apart from the final snapshot.
  const live = rec["live"] === true;

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
        const diffText = p.diff as string;
        // Binary patches are base85 payloads, not human-readable diffs —
        // collapse them to a one-line marker (still counted in the summary).
        if (isBinaryPatch(p, diffText)) {
          return `# ${op} ${path}\n(binary file changed)`;
        }
        return `# ${op} ${path}\n${diffText.replace(/\r?\n$/, "")}`;
      })
      .join("\n");
    const noun = withText.length === 1 ? "file" : "files";
    return {
      kind: "patch",
      unified,
      summary: `${withText.length} ${noun} changed${live ? " (live)" : ""}`,
      ...(live ? { live: true } : {}),
    };
  }

  // Stat-only payload: render the summary + per-file counts.
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
      summary: `${filesChanged} ${noun} changed  +${added} -${removed}  (diff too large to inline)${live ? " (live)" : ""}`,
      files: filesText || "  (no per-file stats)",
      ...(live ? { live: true } : {}),
    };
  }

  return { kind: "empty", message: "No diff available for this node." };
}
