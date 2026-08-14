/** @jsxImportSource @opentui/react */
import { createContext, useContext } from "react";

/**
 * True while a full-screen overlay (the help overlay) is rendered ON TOP of the
 * active mode. `useKeyboard` handlers are plain multi-listener subscriptions —
 * App's early `return` cannot stop a mode's handler from also firing — so the
 * mode must stay MOUNTED under the overlay (preserving tree selection, scrub
 * position, log filter, …) while its key handler gates itself on this flag.
 * Every mode key handler starts with `if (useOverlayOpen()) return;`-style
 * checks so j/k/1-4/space/a/d don't leak through an open overlay.
 *
 * Defaults to false so presentational views mounted WITHOUT a provider (render
 * tests, storybook-style usage) behave exactly as in a closed-overlay app.
 */
export const OverlayOpenContext = createContext(false);

/** Whether an overlay is currently open (see {@link OverlayOpenContext}). */
export function useOverlayOpen(): boolean {
  return useContext(OverlayOpenContext);
}
