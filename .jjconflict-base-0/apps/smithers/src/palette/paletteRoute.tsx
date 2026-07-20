import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { PaletteCanvas } from "./PaletteCanvas";

/** The command palette / quick-open surface (`/palette`). A top-level surface. */
function PalettePage() {
  return <PaletteCanvas />;
}

export const paletteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/palette",
  component: PalettePage,
});
