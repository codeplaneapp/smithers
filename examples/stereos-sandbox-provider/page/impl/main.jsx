import { createRoot } from "react-dom/client";
import { Sources } from "./Sources.jsx";

/** Mount point: the Implementation tab loads this bundle on first view. */
const host = document.getElementById("impl-root");
if (host) {
  host.replaceChildren();
  createRoot(host).render(<Sources />);
}
