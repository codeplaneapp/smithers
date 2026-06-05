import type { PointerEvent as ReactPointerEvent } from "react";
import { useOverlayStore } from "./overlayStore";
import { splitFractionFromPointer } from "./splitFractionFromPointer";

/**
 * The draggable divider between the chat and the split overlay (Design spec §5).
 * Dragging updates `splitFraction` in the overlay store (persisted to the URL);
 * ChatShell turns that fraction into the grid template. No `useEffect`: the
 * pointer is captured on the handle itself, so move/up fire on this element
 * while the gesture is active.
 */
export function SplitDivider() {
  const setSplitFraction = useOverlayStore((s) => s.setSplitFraction);

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Only track while we hold the capture (set on pointerdown).
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const main = event.currentTarget.closest(".chat-main");
    if (!main) return;
    const rect = main.getBoundingClientRect();
    setSplitFraction(splitFractionFromPointer(event.clientX, rect.left, rect.width));
  };

  return (
    <div
      aria-label="Resize split"
      className="split-divider"
      data-testid="split-divider"
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      role="separator"
    >
      <span className="split-divider-grip" />
    </div>
  );
}
