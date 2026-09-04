/*
 * Tab out of a region that eats Tab.
 *
 * The world editor is a ProseMirror body, and ProseMirror binds Tab to
 * "insert indentation": five presses in a row left focus on the editor and a
 * keyboard user could not get past it (§21.2). The editor is library code, so
 * the escape hatch lives at the mount site — the host restores the document's
 * own Tab order around the region rather than reaching into the editor.
 */

/** What the browser would put in the tab ring, in document order. */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])"
].join(",")

const isVisible = (element: HTMLElement): boolean =>
  element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true"

/**
 * The tab stop before or after `region`, skipping everything inside it.
 *
 * `scope` bounds the search to the app shell so the answer is a control the
 * user can see, never the browser chrome.
 */
export const focusableOutside = (
  region: HTMLElement,
  backwards: boolean,
  scope: ParentNode = document
): HTMLElement | undefined => {
  const stops = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !region.contains(element) && isVisible(element)
  )
  if (stops.length === 0) return undefined
  if (backwards) {
    // Document order: the last stop that precedes the region, else wrap.
    let previous: HTMLElement | undefined
    for (const stop of stops) {
      if (region.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_PRECEDING) previous = stop
    }
    return previous ?? stops[stops.length - 1]
  }
  /*
   * The region can be the last thing in the document — the world editor is —
   * so a forward Tab with nothing after it wraps to the first stop rather
   * than answering "nowhere to go" and leaving the user inside the trap.
   */
  return (
    stops.find((stop) => (region.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) ??
      stops[0]
  )
}

/**
 * Handles a Tab press inside `region` by moving focus out of it.
 *
 * Answers true when it took the press, so the caller can leave every other
 * key — including a modified Tab — to the region itself.
 */
export const tabOutOf = (
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"> & {
    preventDefault: () => void
  },
  region: HTMLElement,
  scope?: ParentNode
): boolean => {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return false
  const next = focusableOutside(region, event.shiftKey, scope)
  if (next === undefined) return false
  event.preventDefault()
  next.focus()
  return true
}
