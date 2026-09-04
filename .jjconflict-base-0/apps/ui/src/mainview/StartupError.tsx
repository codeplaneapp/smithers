import { errorMessage } from "./state/ClientErrors"

const PANEL_STYLE = [
  "font-family: ui-monospace, SFMono-Regular, Menlo, monospace",
  "max-width: 44rem",
  "margin: 4rem auto",
  "padding: 2rem",
  "color: #1a1a1a"
].join(";")

const DETAIL_STYLE =
  "white-space: pre-wrap; word-break: break-word; background: #f4f1ea; padding: 1rem; border-radius: 8px"

const HEADING = "Smithers failed to start"
const HINT = "Reload to try again. If this persists, share the error above with the team."

/**
 * The detail text one failure gets.
 *
 * Boot survives some errors — a dying OPFS worker is recovered by the
 * localStorage fallback — so an earlier error is offered as context rather than
 * stated as the cause.
 */
export const startupErrorMessage = (reason: unknown, earlier?: unknown): string =>
  earlier === undefined
    ? errorMessage(reason)
    : [
      errorMessage(reason),
      "",
      "Earliest error while the page was blank (some are recovered, so this may not be the cause):",
      errorMessage(earlier)
    ].join("\n")

/** The panel React renders when a boot failure reaches the error boundary. */
export function StartupErrorPanel({ message }: { readonly message: string }) {
  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        maxWidth: "44rem",
        margin: "4rem auto",
        padding: "2rem",
        color: "#1a1a1a"
      }}
    >
      <h1>{HEADING}</h1>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          background: "#f4f1ea",
          padding: "1rem",
          borderRadius: "8px"
        }}
      >
				{message}
      </pre>
      <p>{HINT}</p>
    </main>
  )
}

/**
 * The same panel built as DOM, for the failure React cannot report: a boot that
 * never resolves, or a bundle that never ran at all.
 */
export const createStartupErrorElement = (documentTarget: Document, message: string): HTMLElement => {
  const panel = documentTarget.createElement("main")
  panel.setAttribute("style", PANEL_STYLE)
  const heading = documentTarget.createElement("h1")
  heading.textContent = HEADING
  const detail = documentTarget.createElement("pre")
  detail.setAttribute("style", DETAIL_STYLE)
  detail.textContent = message
  const hint = documentTarget.createElement("p")
  hint.textContent = HINT
  panel.append(heading, detail, hint)
  return panel
}
