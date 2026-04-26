# `<ExtractPrompt>` and `<LoopUntilScored>` Design

## Summary

Many smithers workflows accept a `prompt` input but the operator does not always know the prompt up front. This design proposes a shareable component that:

- accepts an optional `prompt`
- if absent or low quality, enters an interactive **prompt extraction** mode that elicits a high-quality prompt from the human
- caches the extracted prompt to disk (markdown by default) or SQLite, keyed by a logical `cacheKey`
- gates extraction completion on a **score** that the human can override

A second, smaller component, `<LoopUntilScored>`, falls out naturally and is independently useful: it loops a child task until its score crosses a threshold.

The work is built entirely on existing smithers primitives — `<Loop>`, `<Task>`, `<HumanTask>`, async scorers, `ctx.outputs`. **No engine changes required.**

## Goals

- Subsume "grill me" and "write a PRD" as schema presets of a single component
- Make prompt extraction itself reflect SOTA: meta-prompting, Socratic questioning, R-C-T-F scaffolding, satisfaction-checking
- Score-gated stopping criterion with **stakes classification** (high stakes → require near-perfect; low stakes → looser)
- Human always has final word; score warns but never blocks
- Cache extracted prompts so repeat runs are free

## Non-goals

- Modifying the smithers engine, scorer execution, or the `_smithers_scorers` table schema
- Replacing existing `GrillMe` / `WriteAPrd` immediately. They can become thin presets in a follow-up
- Cross-machine prompt sync (cache is local; sync is future work)
- Auto-classifying stakes from prompt text (v1 is explicit; heuristic inference is future work)

## State of the Art (2026)

The design is informed by a survey of current prompt-elicitation literature:

- **Meta-prompting (two-pass)** — the LLM first builds a structured prompt scaffold from the user's intent, then executes it (IBM, IntuitionLabs, Lakera 2026 guides).
- **Socratic questioning with named principles** — Definition, Elenchus, Hypothesis Elimination, Generalization, Analogy. Explicit principle selection beats ad-hoc follow-ups (Princeton SocraticAI; MARS, arXiv 2503.16874).
- **Teacher–Critic–Student loop** — multi-agent prompt refinement outperforms single-agent on clarity benchmarks.
- **Reflection-in-reflection** — a satisfaction-checker decides when extraction is "done." `WriteAPrd` already gestures at this with its convergence check.
- **R-C-T-F backbone** — Role + Context + Task + Format is the canonical structure to extract *into*.

References: see *Sources* at the bottom.

## API Contract

### `<ExtractPrompt>`

```ts
import type { AgentLike, OutputTarget } from "smithers-orchestrator";
import type { Scorer } from "@smithers-orchestrator/scorers";
import type { PromptCache } from "./extract-prompt/PromptCache";

type ExtractPromptProps = {
  /** Logical id used to namespace task ids. */
  idPrefix: string;

  /** If provided AND non-trivial, ExtractPrompt is a passthrough. */
  prompt?: string;

  /** Logical key for the cache (NOT a file path). The cache driver maps key → location. */
  cacheKey?: string;

  /** Output schema for the extracted prompt. Default: rctfPromptSchema. */
  output?: OutputTarget;

  /** Schema preset. Determines slots, default scorer, default extraction prompt. */
  schema?: "rctf" | "prd" | "freeform";

  /** Stakes — sets the default score threshold. Override via `threshold`. */
  stakes?: "high" | "low";

  /** Override the threshold derived from `stakes`. */
  threshold?: number;

  /** Maximum extraction turns (Socratic Q&A rounds). Default: 10. */
  maxTurns?: number;

  /** Drafter agent — produces the candidate structured prompt. */
  agent: AgentLike | AgentLike[];

  /** Cache driver. Default: MarkdownPromptCache rooted at `.smithers/cache/prompts/`. */
  cache?: PromptCache;

  /** Optional self-score scorer. Default: rctfCompletenessScorer. */
  scorer?: Scorer;
};
```

**Output**: writes a record matching the chosen `schema` to `output`, with at minimum:

```ts
{
  prompt: string;            // the rendered prompt body
  structured: { ... };       // schema-specific slots (R-C-T-F or PRD or freeform)
  source: "provided" | "cache" | "extracted";
  cacheHit: boolean;
  score: number;             // 0-1
  scoreReason: string;
  overridden: boolean;       // true if human shipped despite score < threshold
}
```

### `<LoopUntilScored>`

```ts
type LoopUntilScoredProps = {
  idPrefix: string;
  threshold: number;                // 0..1 inclusive
  maxIterations?: number;           // default: 5
  /** Where to read the score from. Reads ctx.latest(output, nodeId).score. */
  scoreFrom: { output: OutputTarget; nodeId: string; field?: string };
  /** Behavior when the score field is absent or null. */
  onPending?: "continue" | "stop";  // default: "continue"
  /** Behavior when maxIterations is reached without crossing threshold. */
  onMaxReached?: "fail" | "return-last"; // default: "return-last"
  children?: React.ReactNode;
};
```

**Behavior**: thin wrapper around `<Loop>` whose `until` is

```
const latest = ctx.outputMaybe(scoreFrom.output, { nodeId: scoreFrom.nodeId });
const field = scoreFrom.field ?? "score";
const score = latest?.[field];
typeof score === "number" && score >= threshold
```

`<LoopUntilScored>` is independently useful — any task that produces a numeric score field can be looped with it.

### `PromptCache`

A driver registry decouples logical keys from physical storage:

```ts
interface PromptCache {
  get(key: string): Promise<CachedPrompt | undefined>;
  set(key: string, value: CachedPrompt): Promise<void>;
  delete(key: string): Promise<void>;
}

type CachedPrompt = {
  key: string;
  prompt: string;
  structured: Record<string, unknown>;
  schema: "rctf" | "prd" | "freeform";
  stakes: "high" | "low";
  score: number;
  scoreReason: string;
  createdAt: string;            // ISO 8601
  source: "extracted" | "manual";
};
```

Drivers in v1:

- **`MarkdownPromptCache`** (default) — writes one file per key to `.smithers/cache/prompts/{slug}.md` with YAML frontmatter. Human-editable, diffable, greppable.
- **`SqlitePromptCache`** — opt-in, single-table store using `bun:sqlite`. Same shape.
- **`MemoryPromptCache`** — for tests.

### Scoring & Stakes

Two layers:

1. **Inline self-score (gating)**. The drafter agent's output schema includes `{ score: number, scoreReason: string }`. The agent self-rates R-C-T-F slot fill. `<LoopUntilScored>` reads this field. *No engine change.*
2. **Async scorer (observability)**. An LLM-judge scorer is also declared via the existing `scorers={ ... }` map on the `<Task>`. It writes to `_smithers_scorers` for telemetry and audit. **It is not consulted for gating** — it may complete after the loop has already exited.

Stakes → threshold:

```ts
function stakesToThreshold(stakes: "high" | "low"): number {
  return stakes === "high" ? 1.0 : 0.7;
}
```

`high` requires perfection (every R-C-T-F slot strongly filled). `low` requires "good enough." Explicit `threshold` always wins.

### Score Status (Pending / Missing / Ready)

For visibility into the *async* scorer (not the gating self-score), a small helper reads `_smithers_scorers`:

```ts
function readLatestScore(args: {
  runId: string;
  nodeId: string;
  scorerName: string;
  iteration?: number;
}): Promise<
  | { status: "ready"; score: number; reason: string | null }
  | { status: "pending" }      // task ran, scorer registered, no row yet
  | { status: "missing" }      // task ran, no scorer registered
>;
```

This is for inspection / advanced use cases (e.g., a follow-up task that wants to wait for the async judge). **It is not on the gating path.**

## Decision Tree

```
ExtractPrompt(prompt, cacheKey, ...)
│
├── prompt provided AND len(prompt) >= MIN_TRIVIAL_LEN ?
│     → emit { source: "provided", ...prompt, score: 1.0 }
│
├── cache.get(cacheKey) returns hit ?
│     → emit { source: "cache", cacheHit: true, ...cached }
│
└── extract:
      ├── LoopUntilScored ( threshold from stakes, maxTurns )
      │     ├── Task("draft")        — agent produces structured prompt + self-score
      │     │      └── async scorer  — independent LLM-judge for telemetry
      │     └── HumanTask("probe")   — one Socratic question, prefilled with score banner
      │
      ├── HumanTask("ratify")        — final "ship it / keep going" with score warning
      │     warning rules:
      │       score >= threshold:  "I'm ready. Ship it, or keep refining?"
      │       score <  threshold:  "⚠ Score 0.6, threshold 1.0 (high). Override?"
      │
      └── cache.set(cacheKey, result)
            → emit { source: "extracted", cacheHit: false, ... }
```

## Human-in-the-loop UX

Per the rule "human always has final word; score informs but never blocks":

| Score state | What user sees |
|---|---|
| Below threshold, mid-loop | Next probing question + small score banner. No nag. |
| Below threshold, user requests "ship it" | ⚠ Override prompt: "Score is X, threshold is Y (stakes: Z). Ship anyway?" |
| At/above threshold | "I think this prompt is ready. Ship it, or keep refining?" |

Every override is recorded in the cached record (`overridden: true`) so it can be audited.

## File Layout

```
.smithers/components/
  LoopUntilScored.tsx                          (reusable beyond ExtractPrompt)
  extract-prompt/
    ExtractPrompt.tsx                          (top-level)
    PromptCache.ts                             (interface + driver registry)
    MarkdownPromptCache.ts                     (default driver)
    SqlitePromptCache.ts                       (opt-in driver)
    MemoryPromptCache.ts                       (for tests)
    rctfCompletenessScorer.ts                  (async LLM-judge scorer)
    stakesToThreshold.ts                       (helper)
    readLatestScore.ts                         (helper)
    rctfPromptSchema.ts                        (zod schema for output)
    index.ts                                   (barrel)

.smithers/prompts/
  extract-prompt.mdx                           (drafter prompt: Socratic principles + R-C-T-F)

.smithers/workflows/
  extract-prompt.tsx                           (example workflow using ExtractPrompt)

docs/components/
  extract-prompt.mdx                           (component reference)
  loop-until-scored.mdx                        (component reference)

docs/design-prompts/
  extract-prompt-design.md                     (this file)
```

Conventions followed:
- one named export per file, filename matches export name
- `index.ts` is a barrel only
- types and errors colocated with the component they belong to

## Open Questions (resolved by design)

1. **Cache key vs file path** — separated. Caller passes `cacheKey` (logical). The driver translates.
2. **Scorer execution change** — none. Gating uses inline self-score from the agent's output schema. Async scorers remain async; they're for telemetry.
3. **Stakes inference** — explicit only in v1. Heuristic is future work.
4. **GrillMe/WriteAPrd refactor** — deferred. They become presets after `<ExtractPrompt>` lands and is exercised.

## Sources

External:
- IBM 2026 Guide to Prompt Engineering — https://www.ibm.com/think/prompt-engineering
- Lakera Ultimate Guide to Prompt Engineering 2026 — https://www.lakera.ai/blog/prompt-engineering-guide
- IntuitionLabs Meta Prompting Guide — https://intuitionlabs.ai/articles/meta-prompting-automated-llm-prompt-engineering
- MARS: Multi-Agent Socratic Prompt Optimization — https://arxiv.org/html/2503.16874v1
- Princeton SocraticAI — https://princeton-nlp.github.io/SocraticAI/
- Reflecting in the Reflection (arXiv) — https://arxiv.org/html/2601.14798v1

Local:
- `.smithers/components/GrillMe.tsx`
- `.smithers/components/WriteAPrd.tsx`
- `.smithers/components/ValidationLoop.tsx`
- `packages/scorers/src/types.ts`
- `packages/scorers/src/llmJudge.js`
- `packages/scorers/src/schema.js`
- `packages/db/src/adapter/SmithersDb.js` (`listScorerResults`)
- `docs/components/loop.mdx`, `docs/components/human-task.mdx`
