import type { Target } from "./LocalApp"

/*
 * The targets-panel turn (apps/ui/docs/LOCAL-APP.md "Auto-load flow"): the
 * SPA builds one system instruction carrying the marker, the repository, the
 * target JSON and the iframe bridge contract, and asks the model for exactly
 * `{ "message": string, "html": string }`. The deterministic chat stub parses
 * the same instruction back, so the builder and both parsers live together
 * here, runtime-free like the rest of this package.
 */

export const TARGETS_PANEL_MARKER = "smithers-targets-panel"

const REPO_LINE = "Repository:"
const TARGETS_LINE = "Targets JSON:"

/** What the panel may do from inside its sandboxed frame. */
export const BRIDGE_CONTRACT: ReadonlyArray<string> = [
  "The panel renders inside <iframe sandbox=\"allow-scripts\"> with no same-origin access, no network, and no external resources: inline CSS and inline scripts only.",
  "To run a target: window.parent.postMessage({ smithers: \"run\", label: \"<label>\" }, \"*\").",
  "To point at a target's row in the app's targets list: window.parent.postMessage({ smithers: \"open\", label: \"<label>\" }, \"*\").",
  "Labels must be copied exactly from the target JSON."
]

export interface TargetsPromptInput {
  readonly repoName: string
  readonly repoPath: string
  readonly targets: ReadonlyArray<Target>
}

/** The system instruction for the panel turn. */
export const buildTargetsInstructions = (input: TargetsPromptInput): string =>
  [
    TARGETS_PANEL_MARKER,
    `${REPO_LINE} ${input.repoName} (${input.repoPath})`,
    TARGETS_LINE,
    JSON.stringify(
      input.targets.map((target) => ({
        label: target.label,
        target: target.target,
        kinds: target.kinds,
        package: target.package,
        name: target.name
      }))
    ),
    "",
    "You are Smithers. The repository above declares the Smithers targets listed in the JSON, loaded through the smthrs CLI.",
    "Write an interactive HTML panel for them: group the targets by package, show each target's label and target type, and give every target a Run button that posts the run bridge message below.",
    "Bridge contract:",
    ...BRIDGE_CONTRACT.map((line) => `- ${line}`),
    "",
    "Answer with exactly one JSON object and nothing else: {\"message\": string, \"html\": string}.",
    "\"message\" is one or two sentences for the chat. \"html\" is the complete panel markup as a single <div> (no <html>, <head> or <body>).",
    "Do not call tools. Do not wrap the JSON in code fences."
  ].join("\n")

export interface ParsedTargetsInstructions {
  readonly repoName: string
  readonly targets: ReadonlyArray<Target>
}

const isTarget = (value: unknown): value is Target =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { label?: unknown }).label === "string" &&
  typeof (value as { name?: unknown }).name === "string"

/** The repository and targets the instruction carries, or undefined when it carries none. */
export const parseTargetsInstructions = (instructions: string): ParsedTargetsInstructions | undefined => {
  if (!instructions.includes(TARGETS_PANEL_MARKER)) return undefined
  const lines = instructions.split("\n")
  const repoLine = lines.find((line) => line.startsWith(REPO_LINE))
  const repoName = repoLine === undefined ? "" : repoLine.slice(REPO_LINE.length).trim().replace(/\s*\(.*\)$/, "")
  const index = lines.indexOf(TARGETS_LINE)
  const jsonLine = index >= 0 ? lines[index + 1] : undefined
  let targets: Array<Target> = []
  if (jsonLine !== undefined) {
    try {
      const parsed: unknown = JSON.parse(jsonLine)
      if (Array.isArray(parsed)) {
        targets = parsed.filter(isTarget).map((target) => ({
          label: target.label,
          target: typeof target.target === "string" ? target.target : "",
          kinds: Array.isArray(target.kinds) ? target.kinds.filter((kind): kind is string => typeof kind === "string") : [],
          package: typeof target.package === "string" ? target.package : "",
          name: target.name
        }))
      }
    } catch {
      targets = []
    }
  }
  return { repoName, targets }
}

export interface TargetsPanelReply {
  readonly message: string
  readonly html: string
}

/**
 * The model's answer as `{ message, html }`, tolerating code fences and prose
 * around the object; undefined when it is not valid JSON with a non-empty
 * `html`, which is when the SPA falls back to `renderTargetsPanel`.
 */
export const parseTargetsPanelReply = (text: string): TargetsPanelReply | undefined => {
  const unfenced = text.replace(/```(?:json)?/gi, "").trim()
  const start = unfenced.indexOf("{")
  const end = unfenced.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const { message, html } = parsed as { message?: unknown; html?: unknown }
  if (typeof html !== "string" || html.trim() === "") return undefined
  return { message: typeof message === "string" ? message : "", html }
}

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

/** The message the chat carries when the model gives none. */
export const defaultTargetsMessage = (count: number, repoName: string): string =>
  `Loaded ${count} ${count === 1 ? "target" : "targets"} for ${repoName}.`

/** Targets grouped by package, in first-seen package order. */
export const groupTargets = (
  targets: ReadonlyArray<Target>
): ReadonlyArray<{ readonly package: string; readonly targets: ReadonlyArray<Target> }> => {
  const groups = new Map<string, Array<Target>>()
  for (const target of targets) {
    const group = groups.get(target.package) ?? []
    group.push(target)
    groups.set(target.package, group)
  }
  return [...groups.entries()].map(([pkg, rows]) => ({ package: pkg, targets: rows }))
}

const TEMPLATE_STYLE = [
  "body{margin:0;font:13px/1.4 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#1f1b16;background:#fff}",
  ".smithers-targets-panel{padding:12px}",
  ".smithers-targets-panel h1{font-size:15px;margin:0 0 8px}",
  ".smithers-targets-panel h2{font-size:12px;margin:12px 0 4px;color:#6b6457;font-weight:600}",
  ".smithers-targets-panel ul{list-style:none;margin:0;padding:0}",
  ".smithers-targets-panel li{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #eee7da}",
  ".smithers-targets-panel .label{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;flex:1;min-width:0;word-break:break-all}",
  ".smithers-targets-panel .type{color:#6b6457;font-size:12px}",
  ".smithers-targets-panel button{font:inherit;padding:2px 10px;border:1px solid #cfc6b6;border-radius:6px;background:#f7f3ea;cursor:pointer}"
].join("")

const TEMPLATE_SCRIPT =
  "document.addEventListener(\"click\",function(event){var button=event.target&&event.target.closest?event.target.closest(\"button[data-run]\"):null;if(!button)return;window.parent.postMessage({smithers:\"run\",label:button.getAttribute(\"data-run\")},\"*\")})"

/**
 * The built-in panel (LOCAL-APP.md "Auto-load flow" step 4): the targets
 * grouped by package, one Run button per target posting the bridge message.
 */
export const renderTargetsPanel = (targets: ReadonlyArray<Target>): string => {
  const sections = groupTargets(targets).map((group) =>
    `<section data-package="${escapeHtml(group.package)}"><h2>${escapeHtml(group.package)}</h2><ul>${
      group.targets
        .map((target) =>
          `<li data-label="${escapeHtml(target.label)}"><span class="label">${escapeHtml(target.label)}</span><span class="type">${
            escapeHtml(target.target)
          }</span><button type="button" data-run="${escapeHtml(target.label)}" data-testid="template-run-${
            escapeHtml(target.name)
          }">Run</button></li>`
        )
        .join("")
    }</ul></section>`
  )
  return `<div class="smithers-targets-panel" data-testid="template-panel"><style>${TEMPLATE_STYLE}</style><h1>Targets (${targets.length})</h1>${
    sections.join("")
  }<script>${TEMPLATE_SCRIPT}</script></div>`
}
