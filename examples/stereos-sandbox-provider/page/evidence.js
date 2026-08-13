/**
 * The How it works tab.
 *
 * Renders the committed raw captures, one disclosure per host. The text is
 * inserted as text, never as markup, so a capture cannot become page content.
 */
import { captures } from "./real-run.js";

const host = document.getElementById("captures");

for (const [label, capture] of Object.entries(captures)) {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `Full capture (unedited) · ${label}`;
  const pre = document.createElement("pre");
  pre.className = "capture";
  pre.tabIndex = 0;
  pre.textContent = capture;
  details.append(summary, pre);
  host.append(details);
}
