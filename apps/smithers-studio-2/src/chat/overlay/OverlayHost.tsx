import { useOverlayStore } from "./overlayStore";
import { renderOverlay } from "./renderOverlay";

/**
 * Renders the active overlay with a header (title, split/full toggle, close).
 * Returns null when nothing is open. The split-vs-full layout itself is owned by
 * ChatShell (CSS grid); this component is the overlay panel chrome + body.
 */
export function OverlayHost() {
  const overlay = useOverlayStore((s) => s.overlay);
  const presentation = useOverlayStore((s) => s.presentation);
  const setPresentation = useOverlayStore((s) => s.setPresentation);
  const open = useOverlayStore((s) => s.open);
  const close = useOverlayStore((s) => s.close);

  if (!overlay) return null;

  return (
    <section className="overlay-host" data-testid="overlay-host">
      <header className="overlay-host-head">
        <span className="overlay-host-title">{overlay.title}</span>
        <div className="overlay-host-actions">
          {overlay.kind === "workflow-ui" && (
            <>
              <button
                className="overlay-host-btn overlay-host-btn--labeled"
                data-testid="overlay-open"
                onClick={() => setPresentation("full")}
                title="Open over the chat"
                type="button"
              >
                Open
              </button>
              <button
                className="overlay-host-btn overlay-host-btn--labeled"
                data-testid="overlay-split"
                onClick={() => setPresentation("split")}
                title="Split beside the chat"
                type="button"
              >
                Split
              </button>
              <button
                className="overlay-host-btn overlay-host-btn--labeled"
                data-testid="overlay-debug"
                onClick={() => open({ kind: "surface", title: "DevTools", surface: "devtools" }, presentation)}
                title="Debug in DevTools"
                type="button"
              >
                Debug
              </button>
            </>
          )}
          <button
            className="overlay-host-btn"
            data-testid="overlay-toggle-presentation"
            onClick={() => setPresentation(presentation === "split" ? "full" : "split")}
            title={presentation === "split" ? "Expand to full" : "Split with chat"}
            type="button"
          >
            {presentation === "split" ? "⛶" : "◧"}
          </button>
          <button className="overlay-host-btn" data-testid="overlay-close" onClick={close} title="Close" type="button">
            ✕
          </button>
        </div>
      </header>
      <div className="overlay-host-body">{renderOverlay(overlay)}</div>
    </section>
  );
}
