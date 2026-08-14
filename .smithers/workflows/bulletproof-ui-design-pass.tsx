// smithers-display-name: Bulletproof UI Design Pass
/** @jsxImportSource smthrs */
import { OpenCodeAgent as SmithersOpenCodeAgent, Parallel, Sequence, Task, UI, createSmithers } from "smthrs";
import { z } from "zod/v4";
import { providers } from "../agents";

// Final design-consistency sweep, run AFTER the bulletproof-ui campaign
// lands: kimi 3 (via the OpenCode CLI) reviews every UI surface in parallel
// with a designer's eye; fable synthesizes the findings into one report.
// Deliberately NO fallback model on the review lanes: the point is kimi's
// independent pass, so a dead credential should fail loudly, not silently
// substitute another model.
const kimiDesigner = new SmithersOpenCodeAgent({ model: "kimi-for-coding/k3" });
const synthesisAgents = [providers.claude, providers.claudeOpus];

const surfaceIds = [
  "ui-core",
  "ui-chat",
  "ui-agentic",
  "ui-tokens",
  "ui-adapters",
  "gateway-ui",
  "monitor-ui",
  "pack-uis",
  "generated-html",
] as const;
const surfaceIdSchema = z.enum(surfaceIds);

const findingsSchema = z.object({
  surfaceId: surfaceIdSchema,
  score: z.number().int().min(1).max(10),
  summary: z.string().min(40),
  findings: z
    .array(
      z.object({
        severity: z.enum(["blocker", "major", "minor", "polish"]),
        title: z.string().min(3),
        description: z.string().min(10),
        files: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  consistencyNotes: z.array(z.string()).default([]),
  praise: z.array(z.string()).default([]),
});

const reportSchema = z.object({
  overallVerdict: z.string().min(50),
  crossSurfaceInconsistencies: z.array(z.string()).default([]),
  prioritizedFixes: z.array(z.string()).default([]),
  reportPath: z.string().min(5),
});

const inputSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(9).default(5),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  bpuiDpFindings: findingsSchema,
  bpuiDpReport: reportSchema,
});

type Surface = { id: (typeof surfaceIds)[number]; title: string; scope: string };

const SURFACES: Surface[] = [
  {
    id: "ui-core",
    title: "packages/ui base components",
    scope:
      "packages/ui/src/*.tsx (button, card, dialog, select, tabs, table, tooltip, badge, alert, input, progress, skeleton, spinner, separator) and the house compositions (status-pill, empty-state, section-header, kpi-stat, file-tree, stage-strip, collapsible-panel, row-button), plus their CSS blocks in uiCss.ts.",
  },
  {
    id: "ui-chat",
    title: "packages/ui chat surface",
    scope:
      "packages/ui/src/chat/ — ChatTranscript, ChatMessage, ChatComposer plus the newly landed MessageScroller, Bubble, Attachment, Marker, shimmer, scroll-fade.",
  },
  {
    id: "ui-agentic",
    title: "packages/ui agentic components",
    scope:
      "packages/ui/src/agentic/ — Reasoning, ChainOfThought, ToolCall, Response, CodeBlock, Plan, TaskItem, Sources, InlineCitation (the components this campaign added).",
  },
  {
    id: "ui-tokens",
    title: "theme tokens and standalone bundle",
    scope:
      "packages/ui-styleguide/src/ — the light/dark token ramps, semantic colors, elevation shadows, and the standaloneThemeCss() bundle. Judge contrast (WCAG AA for text on bg/surface/muted), ramp coherence, and dark/light parity.",
  },
  {
    id: "ui-adapters",
    title: "heavy-widget adapters + markdown primitive",
    scope:
      "packages/ui/src/adapters/ (markdown-editor, pierre-diff-view, terminal) and packages/ui/src/primitives/markdown.tsx — do the third-party surfaces visually cohere with the house components (spacing, borders, typography, both themes)?",
  },
  {
    id: "gateway-ui",
    title: "gateway-ui run surfaces",
    scope:
      "packages/gateway-ui/src/ — NodeOutputView, NodeOutputCard, RunEventLog, RunTree, ApprovalPanel, SimpleWorkflowDashboard, WorkflowGraph. Special attention to the new agent-output rendering (Reasoning/ToolCall/Response integration).",
  },
  {
    id: "monitor-ui",
    title: "monitor web UI",
    scope:
      "apps/cli/src/monitor-ui/ (monitor.tsx, monitorShell.tsx) — the reference composed surface. Information hierarchy, density, scanability of run lists and event streams.",
  },
  {
    id: "pack-uis",
    title: "workflow pack UIs",
    scope:
      ".smithers/ui/review.tsx and .smithers/ui/issue-blitz.tsx (freshly rewritten to compose the libraries) plus 3-4 of the thin SimpleWorkflowDashboard stubs — is the composed result coherent, and do the rewritten UIs keep useful information hierarchy?",
  },
  {
    id: "generated-html",
    title: "generated/served HTML contract",
    scope:
      "The report-slideshow prompt (.smithers/prompts/report-slideshow-render.mdx), apps/review/src/walkthrough/ (walkthroughCss.ts + renderWalkthroughHtml.ts), and the standaloneThemeCss() integration — will agent-generated pages actually look on-brand in both themes?",
  },
];

function reviewPrompt(surface: Surface): string {
  return [
    `You are doing a design review of one UI surface of the Smithers design system, as a senior product designer with strong opinions about consistency. Return surfaceId=${surface.id} exactly.`,
    `Surface: ${surface.title}\nScope: ${surface.scope}`,
    "READ-ONLY: do not edit, create, or delete any file. Review the code and CSS; you may run existing tests or render scripts but change nothing.",
    "First read packages/ui/src/README.md and packages/ui-styleguide/src/index.ts to internalize the house system (tokens, sui-* namespace, light/dark contract). Then review this surface for:",
    "1. CONSISTENCY: same spacing scale, radius, elevation, typography, and status-color usage as the rest of the system; no off-token colors; no one-off paddings/font-sizes where a shared pattern exists; naming/anatomy consistent with sibling components (data-slot, variant names).",
    "2. UI/UX BEST PRACTICES: clear visual hierarchy; complete interactive states (hover, focus-visible, active, disabled); honest empty/loading/error states; touch-target and density sanity; motion that respects prefers-reduced-motion.",
    "3. ACCESSIBILITY: text contrast on every token pairing used; visible focus rings; keyboard operability of interactive/collapsible elements; aria on custom widgets.",
    "4. DARK/LIGHT PARITY: every rule reads correctly under both themes (token fallbacks are light values; check nothing relies on a light-only assumption).",
    "Score 1-10 (10 = ship-it consistency). Blockers are things that would embarrass the system in a screenshot; polish items are worth doing but not urgent. Include concrete file references in every finding. Also record consistencyNotes (patterns this surface does differently from siblings) and praise (patterns worth propagating).",
  ].join("\n\n");
}

function synthesisPrompt(ctx: any): string {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs("bpuiDpFindings") : ctx.outputs?.bpuiDpFindings;
  const findings = Array.isArray(rows) ? rows : [];
  return [
    "Synthesize the per-surface design-review findings below into ONE design-consistency report.",
    "Deliverables:",
    "1. Write the full report to .smithers/specs/bulletproof-ui-design-pass.md (kebab-case, markdown, no em-dashes): overall verdict, a cross-surface consistency section (patterns that diverge BETWEEN surfaces — the per-surface reviewers cannot see these, you can), then findings grouped by severity with file references, then the propagate-this-praise list. Return the path you wrote as reportPath.",
    "2. Return prioritizedFixes: the ordered short list you would actually fix first (blockers, then the cross-surface inconsistencies with the widest blast radius).",
    "Dedupe aggressively: the same root cause reported by three surfaces is ONE fix. Where reviewers disagree (one surface's praise is another's finding), resolve with your own read of the code.",
    `Per-surface findings:\n${JSON.stringify(findings, null, 2)}`,
  ].join("\n\n");
}

export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxConcurrency: ctx.input.maxConcurrency ?? 5,
  });
  return (
    <Workflow name="bulletproof-ui-design-pass">
      <UI entry="../ui/bulletproof-ui-design-pass.tsx" title="Bulletproof UI Design Pass" />
      <Sequence>
        <Parallel maxConcurrency={input.maxConcurrency}>
          {SURFACES.map((surface) => (
            <Task
              key={surface.id}
              id={`design-${surface.id}`}
              output={outputs.bpuiDpFindings}
              agent={kimiDesigner}
              retries={2}
              timeoutMs={40 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {reviewPrompt(surface)}
            </Task>
          ))}
        </Parallel>
        <Task
          id="design-synthesis"
          output={outputs.bpuiDpReport}
          agent={synthesisAgents}
          retries={2}
          timeoutMs={45 * 60_000}
          heartbeatTimeoutMs={10 * 60_000}
        >
          {synthesisPrompt(ctx)}
        </Task>
      </Sequence>
    </Workflow>
  );
});
