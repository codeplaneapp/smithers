import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../app/rootRoute";
import { GalleryCanvas } from "./GalleryCanvas";

/** The agentic-UI component gallery surface (`/gallery`). Not run-scoped. */
function GalleryPage() {
  return <GalleryCanvas />;
}

export const galleryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gallery",
  component: GalleryPage,
});
