import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { listNarratorCandidates } from "./narrator-agents.js";

// A human watching a run wants a friendly recap, not a scroll of engine logs.
// A cheap/fast model reads the run transcript and narrates it: a short terminal
// summary plus a self-contained HTML page we open in the browser. Everything
// here is best-effort — any failure falls back to a deterministic report so the
// run command itself never breaks.

const TERMINAL_SENTINEL = "===SMITHERS_TERMINAL===";
const HTML_SENTINEL = "===SMITHERS_HTML===";
const MAX_TRANSCRIPT_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 90_000;

const SYSTEM_PROMPT = [
  "You are the narrator for a Smithers workflow run: you sit between raw engine logs and a human, and explain what just happened in plain, friendly language.",
  "You are given a factual summary of one run (its steps, outputs, status, timing). You do not have tools and must not ask for more; work only from what you are given.",
  "Produce exactly two sections, each introduced by its sentinel line on its own line, in this order:",
  `${TERMINAL_SENTINEL}`,
  "  A concise terminal recap (plain text, no markdown symbols like # or *, no ANSI codes). 4-10 short lines: one headline sentence on the outcome, then the key results/highlights as simple dashed bullets, then any warning or failure stated plainly. Warm but not fluffy.",
  `${HTML_SENTINEL}`,
  "  A COMPLETE, self-contained HTML document (starts with <!doctype html>). Inline all CSS in a <style> tag; no external fonts, scripts, images, or network requests. It must render standalone from a file:// URL and look clean in both light and dark color schemes (use prefers-color-scheme). Present the run: title, status badge, timing, each step and its outcome, the final output, and any errors. Tasteful, modern, readable — not a wall of text.",
  "Output nothing before the first sentinel and nothing after the HTML document.",
].join("\n");

/**
 * @param {number | null | undefined} start
 * @param {number | null | undefined} end
 * @returns {string}
 */
function formatDuration(start, end) {
  if (!start || !end || end < start) return "unknown";
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/**
 * Assemble a compact, bounded transcript of the run for the narrator. Pulls the
 * run row, the final output, and per-node output text from the event log,
 * truncated so the summarization stays cheap.
 *
 * @param {{ getRun: (runId: string) => any; listEvents: (runId: string, afterSeq: number, limit: number) => any }} adapter
 * @param {string} runId
 * @param {{ status: string; output?: unknown }} result
 * @param {string} workflowName
 * @returns {Promise<{ context: string; facts: { workflowName: string; status: string; duration: string; nodeCount: number } }>}
 */
async function buildReportContext(adapter, runId, result, workflowName) {
  let run;
  try {
    run = await adapter.getRun(runId);
  } catch {
    run = null;
  }
  const duration = formatDuration(run?.startedAtMs ?? run?.createdAtMs, run?.finishedAtMs ?? Date.now());
  /** @type {Map<string, string>} */
  const nodeText = new Map();
  try {
    const events = await adapter.listEvents(runId, 0, 2000);
    for (const event of events) {
      if (event.type !== "NodeOutput") continue;
      let payload;
      try {
        payload = JSON.parse(event.payloadJson ?? event.payload_json ?? "{}");
      } catch {
        continue;
      }
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text.trim()) continue;
      const nodeId = String(payload.nodeId ?? "");
      nodeText.set(nodeId, `${nodeText.get(nodeId) ?? ""}${text}`);
    }
  } catch {
    /* events are best-effort */
  }
  const lines = [];
  lines.push(`Workflow: ${workflowName}`);
  lines.push(`Status: ${result.status}`);
  lines.push(`Duration: ${duration}`);
  lines.push("");
  if (nodeText.size > 0) {
    lines.push("Steps and their output:");
    for (const [nodeId, text] of nodeText) {
      const trimmed = text.trim().replace(/\s+/g, " ").slice(0, 800);
      lines.push(`- ${nodeId || "(step)"}: ${trimmed}`);
    }
    lines.push("");
  }
  if (result.output !== undefined && result.output !== null) {
    let rendered;
    try {
      rendered = typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2);
    } catch {
      rendered = String(result.output);
    }
    lines.push("Final output:");
    lines.push(rendered.slice(0, 2000));
  }
  let context = lines.join("\n");
  if (context.length > MAX_TRANSCRIPT_CHARS) {
    context = `${context.slice(0, MAX_TRANSCRIPT_CHARS)}\n…(truncated)`;
  }
  return { context, facts: { workflowName, status: result.status, duration, nodeCount: nodeText.size } };
}

/**
 * Split the narrator's response into its terminal and HTML sections. Tolerant:
 * missing sentinels or a stray preamble degrade to whatever we can recover.
 *
 * @param {string} text
 * @returns {{ terminal: string; html: string | null }}
 */
export function parseNarratorResponse(text) {
  const htmlIdx = text.indexOf(HTML_SENTINEL);
  const termIdx = text.indexOf(TERMINAL_SENTINEL);
  let terminal = "";
  let html = null;
  if (htmlIdx !== -1) {
    const before = text.slice(0, htmlIdx);
    terminal = (termIdx !== -1 ? before.slice(termIdx + TERMINAL_SENTINEL.length) : before).trim();
    html = text.slice(htmlIdx + HTML_SENTINEL.length).trim();
  } else if (termIdx !== -1) {
    terminal = text.slice(termIdx + TERMINAL_SENTINEL.length).trim();
  } else {
    terminal = text.trim();
  }
  // Salvage the HTML document even if the model wrapped it in a code fence.
  if (html) {
    const docStart = html.search(/<!doctype html>/i);
    if (docStart > 0) html = html.slice(docStart);
    html = html
      .replace(/```html?\s*$/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    if (!/<html[\s>]/i.test(html) && !/<!doctype html>/i.test(html)) html = null;
  }
  return { terminal, html };
}

/**
 * Escape text for safe interpolation into the fallback HTML template.
 * @param {string} value
 */
function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Deterministic report used when no agent is available or the narrator fails.
 * Plain but complete, so the "we opened a summary" promise always holds.
 *
 * @param {{ facts: { workflowName: string; status: string; duration: string }; context: string }} params
 */
function fallbackReport({ facts, context }) {
  const ok = facts.status === "finished";
  const badge = ok ? "#1a7f37" : facts.status === "failed" ? "#cf222e" : "#9a6700";
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smithers run — ${escapeHtml(facts.workflowName)}</title>
<style>
:root { color-scheme: light dark; }
body { font: 15px/1.6 system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1.25rem; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
.badge { display: inline-block; padding: .15rem .6rem; border-radius: 999px; color: #fff; font-size: .8rem; background: ${badge}; }
.meta { color: #6e7781; margin: .5rem 0 1.5rem; }
pre { background: color-mix(in srgb, currentColor 6%, transparent); padding: 1rem; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
</style></head>
<body>
<h1>${escapeHtml(facts.workflowName)} <span class="badge">${escapeHtml(facts.status)}</span></h1>
<p class="meta">Ran in ${escapeHtml(facts.duration)}</p>
<pre>${escapeHtml(context)}</pre>
</body></html>`;
  const terminal = `Workflow "${facts.workflowName}" ${ok ? "finished" : facts.status} in ${facts.duration}.`;
  return { terminal, html };
}

/**
 * Narrate a finished run: build a terminal recap + a self-contained HTML report
 * (via a cheap agent when one is available, else a deterministic fallback),
 * write the HTML under `.smithers/reports/`, and open it in the browser.
 *
 * Never throws — returns `{ reportPath, terminal, opened, agentId }` or, on a
 * hard failure, `null`. The caller keeps its normal next-steps regardless.
 *
 * @param {{
 *   adapter: { getRun: Function; listEvents: Function };
 *   runId: string;
 *   workflowName: string;
 *   result: { status: string; output?: unknown };
 *   cwd: string;
 *   packDir: string;
 *   open?: (target: string) => boolean;
 *   env?: NodeJS.ProcessEnv;
 *   timeoutMs?: number;
 *   now?: number;
 * }} params
 * @returns {Promise<{ reportPath: string; terminal: string; opened: boolean; agentId: string | null } | null>}
 */
export async function generateRunReport(params) {
  const { adapter, runId, workflowName, result, cwd, packDir } = params;
  const env = params.env ?? process.env;
  const openFn = params.open;
  try {
    const { context, facts } = await buildReportContext(adapter, runId, result, workflowName);
    let narration = null;
    let agentId = null;

    const candidates = listNarratorCandidates(env, cwd);
    for (const candidate of candidates) {
      try {
        const agent = candidate.build(SYSTEM_PROMPT);
        const prompt = `Here is the run to narrate:\n\n${context}`;
        const generated = await agent.generate({
          prompt,
          timeout: { totalMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS },
        });
        const responseText = typeof generated === "string" ? generated : (generated?.text ?? "");
        const parsed = parseNarratorResponse(responseText);
        if (parsed.html) {
          narration = parsed;
          agentId = candidate.id;
          break;
        }
      } catch {
        /* Try the next Codex account, then non-Codex fallbacks. */
      }
    }
    if (!narration) {
      narration = fallbackReport({ facts, context });
    }

    const reportsDir = resolve(packDir, "reports");
    mkdirSync(reportsDir, { recursive: true });
    const safeRunId = runId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const reportPath = resolve(reportsDir, `${safeRunId}.html`);
    writeFileSync(reportPath, narration.html, "utf8");

    let opened = false;
    if (openFn) opened = openFn(reportPath);

    return { reportPath, terminal: narration.terminal, opened, agentId };
  } catch {
    return null;
  }
}
