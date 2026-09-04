export type CopyFailureCode = "clipboard-unavailable" | "clipboard-write-failed";

export type CopyResult =
  | { ok: true; }
  | { ok: false; code: CopyFailureCode; cause: unknown; };

/** Await the host copy path and normalize every failure without exposing host text. */
export async function copyToClipboard(
  text: string,
  onCopy?: (text: string) => void | Promise<void>,
): Promise<CopyResult> {
  try {
    if (onCopy) {
      await onCopy(text);
      return { ok: true };
    }
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
      return { ok: false, code: "clipboard-unavailable", cause: undefined };
    }
    await navigator.clipboard.writeText(text);
    return { ok: true };
  } catch (cause) {
    return { ok: false, code: "clipboard-write-failed", cause };
  }
}
