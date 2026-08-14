// smithers-source: user
// smithers-display-name: Docs Home Design System
// smithers-description: Restyle the docs landing page onto the smithers product design system; Kimi K3 implements, Fable reviews until LGTM.
/** @jsxImportSource smthrs */
import { UI } from "smthrs";
import { ClaudeCodeAgent, OpenCodeAgent, createSmithers, Sequence } from "smthrs";
import { z } from "zod/v4";

const implementSchema = z.looseObject({
  summary: z.string().describe("what changed this round"),
});

const reviewSchema = z.looseObject({
  lgtm: z
    .boolean()
    .describe("true only when the landing page fully adopts the product design system with nothing left to fix"),
  feedback: z.string().default("").describe("concrete, actionable issues when lgtm is false"),
});

const inputSchema = z.object({
  prompt: z.string().default(""),
});

const { Workflow, Task, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  implement: implementSchema,
  review: reviewSchema,
});

const implementer = new OpenCodeAgent({ model: "kimi-for-coding/k3" });
const reviewer = new ClaudeCodeAgent({ model: "claude-fable-5" });

const IMPLEMENT_BRIEF = `You are restyling the Smithers docs landing page so it uses the same design system the Smithers product itself uses.

Design-system sources of truth (read them first):
- /Users/williamcory/multi/src/styles.css — the product app's root tokens (colors, surfaces, borders, brand accent, typography scale).
- .smithers/ui/shared-theme.ts — the shared dark theme used by every Smithers custom workflow UI (--bg, --surface, --border, --brand, etc.).
- packages/gateway-ui and packages/ui — the shipped component libraries whose look the docs should echo (spacing, radii, muted text, status pills).

What to change:
- docs/index.mdx (mode: custom landing page) and the landing-* rules in docs/style.css.
- docs/docs.json "colors" and "background" so the docs chrome matches the product palette instead of the current brass/newsreader look, IF that improves cohesion — keep readability in light mode.
- Keep all existing content, links, copy, structure, and the interactive copy-to-clipboard behaviors intact. This is a reskin, not a rewrite.
- Keep it a valid Mintlify page (frontmatter intact, no external resources).

Verification before you report done:
- Run: pnpm docs:llms (regenerates bundles; CI gates on check-docs/check-llms).
- Ensure docs/style.css stays syntactically valid and index.mdx still parses (no stray JSX errors).

Report a concise summary of the changes.`;

const REVIEW_BRIEF = `You are the design reviewer. Review ONLY (do not edit files).

Inspect the working-copy changes with: jj diff
Focus: docs/index.mdx, docs/style.css, docs/docs.json.

Approve (lgtm: true) only when the docs landing page genuinely adopts the Smithers product design system — the token palette and feel of /Users/williamcory/multi/src/styles.css and .smithers/ui/shared-theme.ts (surfaces, borders, brand accent, typography, spacing) — while remaining a clean, readable, valid Mintlify landing page with all original content and interactions preserved.

If anything falls short (leftover old palette, broken layout, invalid CSS/JSX, lost content, poor light-mode contrast), return lgtm: false with specific, file-and-line-level feedback the implementer can act on.`;

export default smithers((ctx) => {
  const review = ctx.latest("review", "dhds:review") as { lgtm?: boolean; feedback?: string } | undefined;
  const done = review?.lgtm === true;
  const feedback = review && !done && review.feedback ? review.feedback : null;

  return (
    <Workflow name="docs-home-design-system">
      <UI entry="../ui/docs-home-design-system.tsx" title={"Docs Home Design System"} />
      <Loop until={done} maxIterations={8}>
        <Sequence>
          <Task id="dhds:implement" output={outputs.implement} agent={implementer}>
            {[
              IMPLEMENT_BRIEF,
              ctx.input.prompt ? `Additional instructions:\n${ctx.input.prompt}` : "",
              feedback ? `The previous round was rejected by review. Fix ALL of this feedback:\n${feedback}` : "",
            ]
              .filter(Boolean)
              .join("\n\n")}
          </Task>
          <Task id="dhds:review" output={outputs.review} agent={reviewer}>
            {REVIEW_BRIEF}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});
