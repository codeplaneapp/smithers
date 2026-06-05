import type { Overlay, OverlayPresentation } from "../overlay/Overlay";
import type { PrSummary } from "../overlay/PrSummary";
import type { ShellMode } from "../../useStudioStore";
import type { ParsedSlash } from "./parseSlash";

/**
 * What a slash command does once submitted. `open-overlay` shows a default UI;
 * `shell-mode` swaps the whole shell; `prompt` is handed to the agent as a
 * normal message; `unknown` is an unrecognized command. Pure — unit-tested.
 */
export type SlashAction =
  | { kind: "open-overlay"; overlay: Overlay; presentation: OverlayPresentation; note: string }
  | { kind: "shell-mode"; mode: ShellMode; note: string }
  | { kind: "prompt"; text: string }
  | { kind: "unknown"; input: string };

export function resolveSlashAction(parsed: ParsedSlash): SlashAction {
  const { name, args } = parsed;
  switch (name) {
    case "workflow":
      return overlay({ kind: "dashboard", title: "Workflows", dashboard: "workflows" }, `Running workflow ${args || "(pick one)"}.`);
    case "runs":
    case "ps":
      return overlay({ kind: "dashboard", title: "Runs", dashboard: "runs" }, "Showing the run board.");
    case "issue":
      return overlay({ kind: "dashboard", title: "Issues", dashboard: "issues" }, `Opening issues ${args ? `for "${args}"` : ""}.`.trim());
    case "memory":
      return overlay({ kind: "dashboard", title: "Memory", dashboard: "memory" }, "Browsing cross-run memory.");
    case "pr":
      return overlay({ kind: "pr", title: `PR ${prRef(args)}`, pr: mockPr(args) }, `Opening pull request ${prRef(args)}.`);
    case "terminal":
      return overlay({ kind: "terminal", title: "Terminal" }, "Opened a live terminal.");
    case "sandbox":
      return overlay({ kind: "sandbox", title: "Sandbox", url: SANDBOX_URL }, "Spinning up a sandbox.");
    case "web":
      return overlay({ kind: "iframe", title: args || "Web", url: normalizeUrl(args) }, `Opened ${args || "a site"} for the agent.`);
    case "prompt":
    case "ask":
      return { kind: "prompt", text: args };
    case "studio":
      return { kind: "shell-mode", mode: "studio" as ShellMode, note: "Switched to the classic tabbed shell." };
    case "chat":
      return { kind: "shell-mode", mode: "chat" as ShellMode, note: "Switched to the chat shell." };
    default:
      return { kind: "unknown", input: `/${name}${args ? ` ${args}` : ""}` };
  }
}

function overlay(overlay: Overlay, note: string): SlashAction {
  return { kind: "open-overlay", overlay, presentation: "split", note };
}

const SANDBOX_URL = "https://sandbox.smithers.sh/blue";

function prRef(args: string): string {
  const n = args.replace(/[^0-9]/g, "");
  return n ? `#${n}` : "#42";
}

/** SEAM: build a default PR shape from a number until the VCS integration lands. */
function mockPr(args: string): PrSummary {
  const number = Number(args.replace(/[^0-9]/g, "")) || 42;
  return {
    number,
    title: `Pull request #${number}`,
    author: "smithers-agent",
    branch: `feature/pr-${number}`,
    state: "open",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    checks: [],
  };
}

function normalizeUrl(value: string): string {
  const v = value.trim();
  if (!v) return "https://smithers.sh";
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}
