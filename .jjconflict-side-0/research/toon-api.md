# Smithers TOON API — Complete Self-Contained Reference

This document is a fully self-contained reconstruction of the `.toon` workflow definition format that Smithers shipped between **March 14 and March 28, 2026**, before the public surface was retired in favor of JSX. It is written as briefing material for an agent designing a homoiconic Lisp (Lion-lang) front-end for Smithers — **the agent reading this has no access to the codebase**, so all relevant source, docs, examples, and tests are inlined verbatim.

> **TL;DR for the Lion designer:** TOON was a YAML-like declarative format that compiled to the same `BuilderNode` graph the JSX surface produces. Anything Lion creates only needs to produce the same graph. Sections [3](#3-formal-spec) and [10](#10-implementation-the-toon-compiler-source) are the load-bearing ones — the rest are context, examples, and design hints.

---

## Table of Contents

1. [Timeline & Scope](#1-timeline--scope)
2. [Quick Mental Model](#2-quick-mental-model)
3. [Formal Spec](#3-formal-spec)
4. [Schemas (Type System)](#4-schemas-type-system)
5. [Node Kinds (Full Reference)](#5-node-kinds-full-reference)
6. [Prompts, Interpolation, Expressions](#6-prompts-interpolation-expressions)
7. [Inline Code (`run:` and `handler:`)](#7-inline-code-run-and-handler)
8. [Components (Parameterized Reusable Blocks)](#8-components-parameterized-reusable-blocks)
9. [Imports (Schemas, Services, Components, Workflows, Plugins, Agents)](#9-imports-schemas-services-components-workflows-plugins-agents)
10. [Implementation: The TOON Compiler (Source)](#10-implementation-the-toon-compiler-source)
11. [The Compile Target: `BuilderNode` and Engine Wiring](#11-the-compile-target-buildernode-and-engine-wiring)
12. [CLI Dispatch](#12-cli-dispatch)
13. [Plugin System](#13-plugin-system)
14. [Real-World Examples (Full Fixtures)](#14-real-world-examples-full-fixtures)
15. [Test Coverage (What Was Verified)](#15-test-coverage-what-was-verified)
16. [Hints for the Lion-Language Designer](#16-hints-for-the-lion-language-designer)

---

## 1. Timeline & Scope

| Date | Commit | Event |
| --- | --- | --- |
| 2026-03-14 | `74f128cd3` | Migrate `.toon` parser from YAML to real TOON format (drops `yaml` dep, adds `@toon-format/toon`). |
| 2026-03-15 | `5be16d562` | Add named-prompts support (`prompts:` block). |
| 2026-03-15 | `15c2ca470` | Support TOON tabular format for imports and agents. |
| 2026-03-15 | `921b9bc43` | Support flat `maxAttempts` and string `needs:`. |
| 2026-03-24 | `30246efad` | **Remove TOON documentation pages and examples.** Format kept internally as "experimental." |
| 2026-03-24 | `abc82d51e` | Mark TOON as internal/experimental in source comments. |
| 2026-03-28 | `02e3bc121` | Remove TOON-specific code paths from CLI. |
| Later | `9a1efe504` | Extract `@smithers/core` as Effect library + `@smithers/core-react` adapter — JSX becomes the canonical surface. |

The TOON format never reached 1.0; it was deliberately retired in favor of JSX. Both its strengths (declarative, prompt-first, zero ceremony) and its weaknesses (string-DSL schemas, ad-hoc JS-in-strings expressions, special tabular forms) are useful inputs for the Lion design.

---

## 2. Quick Mental Model

A `.toon` file was a [TOON](https://github.com/toon-format/toon) (Token-Oriented Object Notation) document — line-oriented like YAML, but with **explicit array lengths**, **CSV-style tabular rows** for uniform arrays, and **no comment syntax**. TOON files compiled to the exact same `WorkflowNode` graph as the Effect builder / JSX surfaces.

### 2.1 The "hello world"

```toon
name: hello-world
agents:
  assistant:
    type: claude-code
    model: claude-opus-4-7
    subscription: true
    instructions: You are a friendly assistant.

input:
  greeting: string

steps[1]:
  - id: greet
    agent: assistant
    prompt: "Say hello to the user.\nTheir greeting was: {input.greeting}"
    output:
      message: string
```

### 2.2 What the pipeline does

```
.toon file
  └─ readFileSync + decode (@toon-format/toon)
  └─ raw plain object
  └─ resolve all imports (schemas, agents, services, components, workflows, plugins)
  └─ build a ToonEnv (handles + schemas + agents + ... + baseDir + componentCtx?)
  └─ compileNodes(steps, env) — recurse and produce BuilderNode tree
  └─ createWorkflow({name, input}).build($ => buildGraph($))
  └─ BuiltSmithersWorkflow with .execute(input, opts)
  └─ runWorkflow() — same Effect-based engine as JSX path
```

Implicit dependency edges fall out of `{stepId.field}` interpolation in prompts/conditions/skip-ifs/cache keys/component params. There is no `dependsOn:` boilerplate — references **are** edges.

### 2.3 A two-step research workflow (canonical example)

```toon
name: research-report
agents:
  researcher:
    type: claude-code
    model: claude-opus-4-7
    subscription: true
    instructions: You are an expert research assistant.
  writer:
    type: claude-code
    model: claude-opus-4-7
    subscription: true
    instructions: You are a technical writer.

input:
  topic: string

steps[2]:
  - id: research
    agent: researcher
    prompt: "Research the topic.\nTopic: {input.topic}"
    output:
      summary: string
      keyPoints: "string[]"

  - id: report
    agent: writer
    prompt: "Summary: {research.summary}\nKey points: {research.keyPoints}"
    output:
      title: string
      body: string
      wordCount: number
```

The compiler infers the `research → report` edge from the two interpolations.

---

## 3. Formal Spec

(Verbatim from `docs/reference/toon-spec.mdx` at commit `30246efad^`.)

### 3.1 File Structure

```toon
imports:        # optional — external schemas, services, components, plugins, agents, workflows
name:           # required — workflow name
agents:         # optional — named agent declarations
input:          # required — input schema (inline block or imported reference)
schemas:        # optional — reusable named output schemas
components:     # optional — reusable, parameterized step groups
prompts:        # optional — named prompt templates (added 2026-03-15)
steps:          # required — the workflow graph (array of nodes)
```

### 3.2 Top-Level Keys

#### `name` (required, string)
Workflow identifier used in persistence, logs, CLI, and API.

#### `input` (required)
Either an inline schema block or a reference to an imported `Schema.Class`.

```toon
# Inline
input:
  ticketId: string
  description: string

# Imported
input: TicketInput
```

#### `agents` (optional)
Named agent declarations. Required only when steps use `prompt:` and agents are not imported.

```toon
agents:
  coder:
    type: claude-code
    subscription: true
    instructions: You are a senior software engineer.
  reviewer:
    type: codex
    fullAuto: true
  analyst:
    type: anthropic
    model: claude-opus-4-7
    instructions: You are a data analyst.
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string | yes | Agent runtime: `claude-code`, `codex`, `gemini`, `pi`, `kimi`, `forge`, `anthropic`, `openai`, `api` |
| `model` | string | conditional | Model identifier. Required for `anthropic`, `openai`, `api`. Optional for CLI agents. |
| `instructions` | string | no | System prompt / persona |
| `tools` | string[] | no | Tool names |
| `subscription` | boolean | no | Use subscription billing (Claude Code) |
| `timeoutMs` | number | no | Hard timeout in milliseconds |
| `idleTimeoutMs` | number | no | Inactivity timeout |

Additional type-specific fields are passed through (`fullAuto` for Codex, `permissionMode` for Claude Code, `sandbox` for Gemini, etc.).

For `type: api` you must additionally specify `provider: anthropic | openai` and `model:`.

#### `schemas` (optional)
Named output schemas reusable across steps.

```toon
schemas:
  Review:
    approved: boolean
    feedback: string
```

#### `components` (optional)
Named, parameterized step groups. See §8.

#### `prompts` (optional)
Top-level named prompt templates. A step's `prompt:` field can either be inline text or a name resolving here.

```toon
prompts:
  reviewSpec: |
    You are a reviewer. Look at {draft.content} and respond with approval status.
```

#### `steps` (required)
Array of nodes that define the workflow graph.

#### `imports` (optional)
Object with sub-keys `schemas`, `services`, `components`, `workflows`, `plugins`, `agents`. See §9.

### 3.3 Field Type Mini-DSL

| TOON syntax | Effect equivalent |
| --- | --- |
| `string` | `Schema.String` |
| `number` | `Schema.Number` |
| `boolean` | `Schema.Boolean` |
| `"a"` | `Schema.Literal("a")` |
| `"a" \| "b"` | `Schema.Literal("a", "b")` |
| `"string[]"` | `Schema.Array(Schema.String)` |
| `"number[]"` | `Schema.Array(Schema.Number)` |
| `string?` | `Schema.optional(Schema.String)` |
| `T?` | `Schema.optional(T)` |
| nested block | `Schema.Struct({...})` |
| `- field: type` items | `Schema.Array(Schema.Struct({...}))` |

### 3.4 Node Kinds — Quick Reference

```toon
# 1. Step (default — no `kind:`)
- id: analyze
  agent: coder
  prompt: Analyze the code.
  output: AnalysisOutput
  needs[2]: step-id-1,step-id-2
  maxAttempts: 3
  timeout: 5m
  skipIf: "expression"

# 2. sequence
- kind: sequence
  children[2]: ...

# 3. parallel
- kind: parallel
  maxConcurrency: 2       # optional
  children[2]: ...

# 4. loop
- kind: loop
  id: review-loop          # optional
  until: "expression"      # required
  maxIterations: 5         # optional (default 5)
  onMaxReached: fail | return-last  # optional (default return-last)
  children[1]: ...

# 5. approval
- kind: approval
  id: approve-deploy       # required
  needs[1]: build          # optional
  request:                 # required
    title: "Deploy?"
    summary: "Details..."
  onDeny: fail | continue | skip  # optional (default fail)

# 6. branch
- kind: branch
  condition: "expression"  # required
  then[1]: ...             # required
  else[1]: ...             # optional

# 7. worktree
- kind: worktree
  path: ./feature          # required
  branch: feature/x        # optional
  children[1]: ...

# 8. workflow (sub-workflow invocation)
- kind: workflow
  id: run-tests            # required
  use: testSuite           # required — alias from imports.workflows
  input:                   # optional — input mapping
    repo: "{input.repoUrl}"
    branch: "{checkout.branch}"

# 9. component (instantiate a parameterized component)
- id: my-review            # required — caller id (used for {id} substitution)
  kind: component
  use: ReviewCycle         # required — component name
  with:                    # required — parameter values
    content: "{draft.content}"
    reviewer: "tech lead"

# 10. Custom / plugin-registered kinds
- kind: linear-ticket      # registered by a plugin's `nodes.linear-ticket` handler
  ...
```

### 3.5 Step Properties (when no `kind:` is given)

| Property | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique within workflow |
| `agent` | string | Required for `prompt:` steps |
| `prompt` / `run` / `handler` | string | **Exactly one required** |
| `output` | schema or named ref | Required |
| `needs` | string or `string[]` | Explicit deps; comma-string also accepted |
| `maxAttempts` | number | Flat alternative to nested `retry:` |
| `retry` | object | `{ maxAttempts, backoff: "exponential"\|"linear"\|"fixed", initialDelay }` |
| `timeout` | duration string | `"30s"`, `"5m"`, `"1h"`, `"250ms"` |
| `cache` | object | `{ by: string[], version: string }` |
| `skipIf` | string | JS expression evaluated against context |

### 3.6 Interpolation Grammar

```
{expression}     — interpolate a value
{{               — literal {
}}               — literal }
```

Where it works: `prompt:`, `request.title`, `request.summary`, `skipIf:`, `until:`, `condition:`, `cache.by`, component `with:` values.

| Form | Example | Resolves to |
| --- | --- | --- |
| `input.field` | `{input.topic}` | Workflow input field |
| `stepId.field` | `{analyze.summary}` | Upstream step output |
| `stepId.nested.field` | `{config.deploy.env}` | Nested output field |
| `params.field` | `{params.content}` | Component parameter |
| `loop.iteration` | `{loop.iteration}` | Current iteration (1-based) |
| `id` | `{id}` | Caller id (inside components) |
| Ternary | `{input.score > 7 ? 'good' : 'bad'}` | Conditional value |
| Method call | `{input.tags.join(', ')}` | Result of method |
| Concat | `{'Hello ' + input.name}` | Concatenated string |

Expressions are evaluated as JavaScript. All standard operators, ternaries, and method calls work.

### 3.7 Duration Syntax

| Format | Example |
| --- | --- |
| Milliseconds | `250ms` |
| Seconds | `30s` |
| Minutes | `5m` |
| Hours | `1h` |

### 3.8 Import Block Forms

Imports use TOON's tabular array form for compact two-column declarations. (Tabular form: `name[N]{col1,col2}:` followed by `N` CSV-style rows.)

```toon
imports:
  schemas[1]{from,use}:
    ./schemas.ts,"TicketInput,AnalysisOutput,ReviewOutput"
  agents[1]{from,use}:
    ./agents.ts,"coder,reviewer"
  services[2]{from,use}:
    ./services/coder.ts,Coder
    ./services/jj.ts,JJ
  components[1]{from,use}:
    ./shared/patterns.toon,"ReviewLoop,DeployGate"
  workflows[1]{from,as}:
    ./sub-workflows/research.toon,research
  plugins[2]:                          # plugins use expanded list (per-entry config)
    - from: smithers-plugin-anthropic
      config:
        defaultModel: claude-opus-4-7
    - from: smithers-plugin-linear
      config:
        team: ENG
```

Resolution: paths starting with `./` or `/` are filesystem-relative to the `.toon` file's directory. Bare names resolve from `node_modules`.

### 3.9 Execution Semantics

- Steps in `steps:` execute **sequentially** by default (top to bottom).
- `kind: parallel` children execute **concurrently**.
- `kind: sequence` is explicit sequential grouping (useful inside `parallel`).
- `kind: loop` repeats children until `until:` is true or `maxIterations` is reached.
- `kind: approval` **suspends durably** — the run halts and persists; `smithers approve --run-id ...` resumes it.
- `kind: branch` takes one path based on `condition:`.
- `kind: workflow` invokes an imported `.toon` as a sub-workflow.
- Dependencies declared in `needs:` plus implicit deps from `{stepId.field}` references are resolved before each step runs.
- A `.toon` workflow compiles to the same `WorkflowNode` graph as the Effect builder API.

---

## 4. Schemas (Type System)

(Adapted from `docs/toon/schemas.mdx`.)

### 4.1 Inline workflow input

```toon
name: bugfix
input:
  ticketId: string
  description: string
  priority: "low" | "medium" | "high"
```

### 4.2 Inline step output

```toon
steps[1]:
  - id: analyze
    prompt: "Analyze this bug: {input.description}"
    output:
      summary: string
      severity: "low" | "medium" | "high"
      affectedFiles: "string[]"
```

### 4.3 Nested objects

```toon
steps[1]:
  - id: plan
    prompt: "Create a fix plan for: {input.description}"
    output:
      plan:
        steps: "string[]"
        estimatedHours: number
        risk: "low" | "medium" | "high"
      metadata:
        author: string?
        createdAt: string
```

### 4.4 Optional fields

Append `?` to the type or to the field name:

```toon
input:
  ticketId: string
  description: string
  assignee: string?
  labels: "string[]?"
```

### 4.5 Imported `Schema.Class` types

```toon
imports:
  schemas[1]{from,use}:
    ./schemas.ts,"TicketInput,AnalysisOutput"

name: bugfix
input: TicketInput

steps[1]:
  - id: analyze
    prompt: "Analyze: {input.description}"
    output: AnalysisOutput
```

```ts
// schemas.ts
import { Schema } from "effect";
import { Model } from "@effect/sql";

export class TicketInput extends Schema.Class<TicketInput>("TicketInput")({
  ticketId: Schema.String,
  description: Schema.String,
}) {}

export class AnalysisOutput extends Model.Class<AnalysisOutput>("AnalysisOutput")({
  summary: Schema.String,
  severity: Schema.Literal("low", "medium", "high"),
}) {}
```

### 4.6 Reusing schemas via the top-level `schemas:` block

```toon
schemas:
  Review:
    approved: boolean
    feedback: string

steps[2]:
  - id: initial-review
    prompt: "Review the initial draft."
    output: Review
  - id: final-review
    prompt: "Review the final draft."
    output: Review
```

### 4.7 Arrays of objects

```toon
steps[1]:
  - id: find-bugs
    prompt: "Find all bugs in {input.repo}."
    output:
      bugs:
        - file: string
          line: number
          description: string
          severity: "low" | "medium" | "high"
```

### 4.8 Validation

Schemas are validated at two points:
1. **Build time** — `.toon` parsed and types checked.
2. **Runtime** — workflow input validated against input schema; each step output validated against its output schema before persistence.

Implementation note: TOON's array-type strings need quoting (`"string[]"`) because TOON treats unquoted `[]` as array-length annotations.

---

## 5. Node Kinds (Full Reference)

(Adapted from `docs/toon/nodes.mdx`.)

### 5.1 Step

The default node. Sends a prompt to an agent (or runs code) and produces structured output.

```toon
agents:
  coder:
    type: claude-code
    model: claude-opus-4-7
    subscription: true
    instructions: You are a senior software engineer.

steps[1]:
  - id: analyze
    agent: coder
    prompt: "Analyze the bug.\nDescription: {input.description}"
    output:
      summary: string
      severity: "low" | "medium" | "high"
```

#### Retry policy

```toon
- id: flaky-api
  prompt: "Call the external API."
  output:
    result: string
  retry:
    maxAttempts: 3
    backoff: exponential        # | linear | fixed
    initialDelay: 250ms
```

Equivalent flat form: `maxAttempts: 3` directly on the step.

#### Timeout

```toon
- id: slow-step
  prompt: "Process a large dataset."
  output:
    status: string
  timeout: 5m
```

#### Cache

```toon
- id: compute
  handler: ./toon-cache-handler.ts#compute
  output:
    count: number
    key: string
  cache:
    by[1]: input.key
    version: v1
```

`cache.by` is an array of expressions whose evaluated values form the cache key. `cache.version` invalidates when bumped.

### 5.2 Sequence

Steps are sequential by default. Use explicit `sequence` to group inside `parallel`:

```toon
- kind: parallel
  children[2]:
    - kind: sequence
      children[2]:
        - id: step-a
          prompt: Do A.
          output: { result: string }
        - id: step-b
          prompt: Do B using {step-a.result}.
          output: { result: string }
    - id: step-c
      prompt: Do C independently.
      output: { result: string }
```

### 5.3 Parallel (with optional concurrency limit)

```toon
- kind: parallel
  maxConcurrency: 2
  children[3]:
    - id: task-1 ...
    - id: task-2 ...
    - id: task-3 ...
```

### 5.4 Loop

```toon
- kind: loop
  id: review-loop
  maxIterations: 5
  until: "{review.approved} == true"
  children[2]:
    - id: review
      prompt: "Review draft:\n{draft.content}"
      output: { approved: boolean, feedback: string }
    - id: revise
      prompt: "Revise based on feedback:\n{review.feedback}"
      output: { content: string }
      skipIf: "{review.approved}"
```

| Property | Required | Notes |
| --- | --- | --- |
| `id` | no | Loop identifier |
| `maxIterations` | no | Default 5 |
| `until` | yes | Stop expression |
| `onMaxReached` | no | `"fail"` or `"return-last"` (default) |
| `children` | yes | Steps to repeat |

**Nested loops are not supported.** The compiler throws `TOON_NESTED_LOOP`.

### 5.5 Approval (durable suspend)

```toon
- kind: approval
  id: approve-deploy
  needs[1]: build
  request:
    title: "Deploy {build.version}?"
    summary: "Commit {build.commitSha} passed all checks."
  onDeny: fail
```

Resumed externally via `smithers approve --run-id <id> --node-id approve-deploy`.

### 5.6 Branch

```toon
- kind: branch
  condition: "{classify.severity} == 'high'"
  then[1]:
    - id: escalate
      prompt: Escalate to senior engineer.
      output: { action: string }
  else[1]:
    - id: auto-fix
      prompt: Generate an automated fix.
      output: { patch: string }
```

### 5.7 Worktree

```toon
- kind: worktree
  path: ./feature-branch
  branch: feature/x          # optional
  children[1]:
    - id: implement
      prompt: "Implement: {input.spec}"
      output: { files: "string[]", summary: string }
```

The worktree is created before children execute and cleaned up after.

### 5.8 Sub-workflow (`kind: workflow`)

```toon
imports:
  workflows[1]{from,as}:
    ./toon-subworkflow.toon,research

steps[2]:
  - id: do_research
    kind: workflow
    use: research
    input:
      topic: "{input.topic}"

  - id: report
    needs[1]: do_research
    run: "return { report: `Report: ${do_research.summary}` };\n"
    output: { report: string }
```

### 5.9 Free Nesting

All node kinds nest freely — parallels in loops, branches in parallels, components in sequences, etc.

---

## 6. Prompts, Interpolation, Expressions

(Adapted from `docs/toon/prompts.mdx`.)

### 6.1 Inline prompt

```toon
- id: greet
  agent: assistant
  prompt: Say hello to {input.name}.
  output: { message: string }
```

### 6.2 Multi-line prompt

TOON has no YAML-`|` block. Multi-line prompts are quoted strings with `\n`:

```toon
- id: analyze
  agent: coder
  prompt: "You are a senior software engineer.\n\nAnalyze the following bug report and identify:\n1. Root cause\n2. Affected systems\n3. Suggested fix\n\nBug report:\n{input.description}"
  output:
    rootCause: string
    affectedSystems: "string[]"
    suggestedFix: string
```

### 6.3 Named prompts (top-level `prompts:` block)

```toon
prompts:
  reviewSpec: |
    You are a reviewer. Look at {draft.content} and respond with approval status.

steps[1]:
  - id: review
    agent: reviewer
    prompt: reviewSpec               # name lookup if it matches a key in prompts:
    output: { approved: boolean }
```

### 6.4 Brace literals

```toon
prompt: "Return a JSON object like {{key: value}}.\nThe input topic is {input.topic}."
```

`{{` becomes `{`, `}}` becomes `}`.

### 6.5 Expressions inside `{...}`

Full JavaScript: ternaries, method calls, string concat.

```toon
- id: fix
  prompt: "Fix the bug.\n{input.priority == 'high' ? 'URGENT.\n' : ''}Description: {input.description}"
  output: { patch: string }
```

```toon
prompt: "{input.tags.length > 0 ? 'Tags: ' + input.tags.join(', ') : 'No tags provided.'}"
prompt: "Keywords: {input.tags.join(', ')}\nTitle: {draft.title.toUpperCase()}"
```

### 6.6 Loop iteration state

```toon
- kind: loop
  until: "{review.approved}"
  children[1]:
    - id: review
      prompt: "Review.\nIteration {loop.iteration}.\n{loop.iteration > 1 ? 'Previous feedback: ' + review.feedback : ''}"
      output: { approved: boolean, feedback: string }
```

### 6.7 Component params

```toon
components:
  Reviewer:
    params: { content: string, role: string }
    steps[1]:
      - id: "{id}-review"
        prompt: "You are {params.role}.\nReview: {params.content}"
        output: { approved: boolean, feedback: string }
```

### 6.8 Auto-injected JSON-output instructions

When a `prompt:` step has a non-empty `output:` schema, the compiler automatically appends a JSON-output section to the rendered prompt before sending it to the agent. The agent's text output is then scanned for a ```json fenced block, falling back to the last balanced `{...}` JSON object. (See `buildPromptInstructions` and `extractAgentOutput` in §10.)

This is a **load-bearing** detail: every prompt step ends up being instructed to emit JSON matching its schema, then the response gets parsed back. A homoiconic surface should preserve this automatic schema-coupling.

---

## 7. Inline Code (`run:` and `handler:`)

(Adapted from `docs/toon/inline-code.mdx`.)

### 7.1 `run:` — inline TypeScript

```toon
- id: transform
  run: "const items = input.rawData.split(\",\").map(s => s.trim());\nreturn { items, count: items.length };"
  output:
    items: "string[]"
    count: number
```

The `run:` body has access to:
- `input` — validated workflow input
- Upstream step outputs by id (e.g., `analyze`, `research`)
- `executionId`, `attempt`, `iteration`, `signal`, `stepId`
- Imported services
- Effect helpers: `Effect`, `Context`, `Schema`, `Layer`, `Duration`, `Schedule`

It must return an object matching the step's `output` schema. May `await`.

### 7.2 `handler:` — file reference

```toon
- id: deploy
  handler: ./handlers/deploy.ts#deployToProduction
  output: { url: string, deployId: string }
```

```ts
// handlers/deploy.ts
import { Effect } from "effect";
import { Deployer } from "../services/deployer";

export const deployToProduction = ({ input, build }: any) =>
  Effect.gen(function* () {
    const deployer = yield* Deployer;
    const result = yield* deployer.deploy({ version: build.version, env: "production" });
    return { url: result.url, deployId: result.id };
  });
```

Format: `./path/to/module.ts` or `./path/to/module.ts#namedExport`. Without `#`, the default export is used.

### 7.3 Return types accepted

A `run:` block or `handler:` may return:
- a plain object,
- a `Promise<object>`,
- an `Effect` (which is run with the workflow's Layer-provided environment).

### 7.4 Error handling

Errors are subject to the same retry/backoff semantics as prompt steps:

```toon
- id: external-api
  run: "const res = await fetch(input.webhookUrl, ...); if (!res.ok) throw new Error(`Webhook failed: ${res.status}`); return { status: 'sent' };"
  output: { status: string }
  retry:
    maxAttempts: 3
    backoff: exponential
    initialDelay: 1s
```

### 7.5 Mutual exclusion

A step uses **exactly one** of `prompt:`, `run:`, `handler:`. The compiler throws `TOON_STEP_AMBIGUOUS` if zero or more than one is present.

---

## 8. Components (Parameterized Reusable Blocks)

(Adapted from `docs/toon/components.mdx`.)

### 8.1 Defining and using a component

```toon
name: review-pipeline

components:
  ReviewCycle:
    params:
      content: string
      reviewer: string
    steps[2]:
      - id: "{id}-review"
        prompt: "You are {params.reviewer}.\nReview the following content:\n{params.content}"
        output:
          approved: boolean
          feedback: string

      - id: "{id}-revise"
        prompt: "Revise based on feedback: {params.feedback}"
        output: { content: string }
        skipIf: "{id}-review.approved"

input:
  topic: string

steps[3]:
  - id: draft
    prompt: Write a draft about {input.topic}.
    output: { content: string }

  - id: tech-review
    kind: component
    use: ReviewCycle
    with:
      content: "{draft.content}"
      reviewer: "a senior engineer"

  - id: style-review
    kind: component
    use: ReviewCycle
    with:
      content: "{tech-review-revise.content}"
      reviewer: "a technical writer"
```

### 8.2 `{id}` substitution

The `{id}` token inside a component definition is replaced with the **caller's id** at compile time. This produces collision-free unique step ids when a component is used multiple times.

In the example above, `tech-review` produces `tech-review-review` and `tech-review-revise`; `style-review` produces `style-review-review` and `style-review-revise`.

> **Wart:** outputs are referenced via the *expanded* ids, e.g. `{tech-review-revise.content}`, not the caller id `tech-review`. The next-generation surface should fix this — see §16.

### 8.3 Component params evaluated lazily

Param values can be expressions (`"{draft.content}"`) — they are evaluated **at runtime** against each step's context, not at compile time. This is what lets a component step transparently `needs` the upstream steps that flow into its params.

### 8.4 Components can contain control flow

```toon
components:
  GuardedDeploy:
    params: { version: string, env: string }
    steps[2]:
      - kind: approval
        id: "{id}-approve"
        request:
          title: "Deploy {params.version} to {params.env}?"
          summary: "Approval required for production deployment."
        onDeny: fail
      - id: "{id}-deploy"
        needs[1]: "{id}-approve"
        run: "await deployToEnv(params.env, params.version);"
        output: { url: string }
```

### 8.5 Components imported from other `.toon` files

```toon
imports:
  components[2]{from,use}:
    ./shared/review.toon,ReviewCycle
    ./shared/deploy.toon,GuardedDeploy
```

When a component is imported, the compiler also pulls in any schemas, services, plugin nodes, and layers transitively used by that file.

### 8.6 Component vs. sub-workflow

| Use components when... | Use sub-workflows when... |
| --- | --- |
| Pattern is a fragment within a larger workflow | The workflow is independently executable |
| You want to avoid duplicating step definitions | It has its own input schema and lifecycle |
| The fragment shares context with the parent | It should be invocable from CLI/API on its own |

---

## 9. Imports (Schemas, Services, Components, Workflows, Plugins, Agents)

(Adapted from `docs/toon/imports.mdx`.)

### 9.1 Schemas (TS `Schema.Class` / `Model.Class`)

```toon
imports:
  schemas[1]{from,use}:
    ./schemas.ts,"TicketInput,AnalysisOutput,ReviewOutput"

name: bugfix
input: TicketInput

steps[2]:
  - id: analyze
    prompt: Analyze {input.description}.
    output: AnalysisOutput
  - id: review
    prompt: Review {analyze.summary}.
    output: ReviewOutput
```

### 9.2 Effect services

```toon
imports:
  services[2]{from,use}:
    ./services/coder.ts,Coder
    ./services/jj.ts,JJ

steps[1]:
  - id: fix
    handler: ./handlers/fix.ts#applyFix
    output: { patch: string }
```

The imported services must be provided through the Layer stack at execution time. Example service definition:

```ts
// services/jj.ts
import { Context, Effect } from "effect";

export class JJ extends Context.Tag("JJ")<
  JJ,
  { readonly createBranch: (name: string) => Effect.Effect<{ name: string }> }
>() {}
```

### 9.3 Components from other `.toon` files

```toon
imports:
  components[2]{from,use}:
    ./shared/review-cycle.toon,ReviewCycle
    ./shared/deploy-gate.toon,GuardedDeploy
```

### 9.4 Whole `.toon` files as sub-workflows

```toon
imports:
  workflows[1]{from,as}:
    ./sub-workflows/research.toon,research

steps[2]:
  - id: do-research
    kind: workflow
    use: research
    input:
      topic: "{input.topic}"
  - id: report
    prompt: "Write a report based on:\n{do-research.summary}"
    output: { report: string }
```

### 9.5 Plugins (custom node kinds, services, layers)

Plugins use **expanded list items** (not tabular) because each entry has a per-entry `config:` object:

```toon
imports:
  plugins[2]:
    - from: smithers-plugin-anthropic
      config:
        defaultModel: claude-opus-4-7
    - from: smithers-plugin-linear
      config:
        team: ENG
```

A plugin module exports either a plugin object or a factory taking `config`:

```ts
// smithers-plugin-foo
import { Schema } from "effect";

export default (config: { suffix?: string } = {}) => ({
  name: "foo-plugin",
  nodes: {
    "shout": (node: any, env: any) => {
      const id = String(node.id ?? "shout");
      const text = String(node.text ?? "");
      const suffix = config.suffix ?? "";
      return env.builder.step(id, {
        output: Schema.Struct({ value: Schema.String }),
        run: () => ({ value: `${text}${suffix}`.toUpperCase() }),
      });
    },
  },
  // services: { Foo: ... },
  // layers: [FooLayer],
});
```

Plugin facilities:
- Add custom node kinds (`kind: shout` above).
- Provide services that get merged into the workflow's service map.
- Register Effect Layers that wrap the workflow execution.
- Optionally interpret `config:` from the import.

Plugins are loaded at build time. The fully resolved module path may be a package name (resolved from `node_modules`) or a relative `.ts`/`.js` file.

### 9.6 Agents (TS-defined `AgentLike`)

```toon
imports:
  agents[1]{from,use}:
    ./agents.ts,"coder,reviewer"
```

Each imported value must conform to `AgentLike` (have a `generate({prompt, abortSignal, timeout})` method).

### 9.7 Combine freely

```toon
imports:
  schemas[1]{from,use}:
    ./schemas.ts,"Input,Output"
  services[1]{from,use}:
    ./services/index.ts,"Coder,Reviewer,Deployer"
  components[1]{from,use}:
    ./shared/patterns.toon,"ReviewLoop,DeployGate"
  plugins[1]:
    - from: smithers-plugin-anthropic
```

### 9.8 Resolution rules

- `./...` and `/...` → filesystem-relative to the importing `.toon` file.
- bare names → resolved from `node_modules`.
- A `.toon` module can transitively import other `.toon` modules; the loader caches per absolute path (`toonModuleCache`).

---

## 10. Implementation: The TOON Compiler (Source)

The complete TOON-relevant source from `src/effect/builder.ts` (commit `30246efad^`). All of this needs to exist (in some form) for any new front-end (Lion, JSX, anything else) — though a Lisp can replace the **template parser**, **expression evaluator**, and **schema-string parser** with native AST handling.

The full file is 2447 lines. The portions below are the TOON-specific compiler — about 1500 lines. Surrounding infrastructure (the `BuilderApi` factory, retry helpers, payload table creation, etc.) is in §11.

### 10.1 Imports and types

```ts
// src/effect/builder.ts (top of file)
import { readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, desc, eq } from "drizzle-orm";
import {
  Context, Duration, Effect, Exit, JSONSchema, Layer, Schedule, Schema,
} from "effect";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import React from "react";
import { decode as parseToon } from "@toon-format/toon";

import type { AgentLike } from "../AgentLike";
import type { CachePolicy } from "../CachePolicy";
import type { RetryPolicy } from "../RetryPolicy";
import {
  AnthropicAgent, ClaudeCodeAgent, CodexAgent, ForgeAgent,
  GeminiAgent, KimiAgent, OpenAIAgent, PiAgent,
} from "../agents";
import { SmithersDb } from "../db/adapter";
import { runWorkflow } from "../engine";
import { runPromise } from "./runtime";
import { requireTaskRuntime } from "./task-runtime";
import {
  Branch, Loop, Parallel, Sequence, Task, Worktree, Workflow,
} from "../components";
import { camelToSnake } from "../utils/camelToSnake";
import { SmithersError } from "../utils/errors";
```

```ts
// Internal types
type ToonSchemaEntry = {
  schema: AnySchema;
  jsonSchema?: unknown;
};

type ToonComponentDef = {
  name: string;
  params?: Record<string, unknown>;
  steps: any[];           // raw TOON node array, compiled lazily on instantiation
};

type ToonPluginNodeHandler = (
  node: any,
  env: ToonEnv,
  helpers: {
    compileNode: (node: any, env: ToonEnv) => BuilderNode;
    compileNodes: (nodes: any[], env: ToonEnv) => BuilderNode;
  },
) => BuilderNode;

type ToonPlugin = {
  name?: string;
  nodes?: Record<string, ToonPluginNodeHandler>;
  services?: Record<string, unknown>;
  layers?: Layer.Layer<never, never, never> | Layer.Layer<never, never, never>[];
};

type ToonEnv = {
  builder: BuilderApi;
  handles: Map<string, BuilderStepHandle>;
  seenIds: Set<string>;
  schemas: Map<string, ToonSchemaEntry>;
  agents: Map<string, AgentLike>;
  components: Map<string, ToonComponentDef>;
  services: Map<string, unknown>;
  workflows: Map<string, string>;
  pluginNodes: Map<string, ToonPluginNodeHandler>;
  prompts: Map<string, string>;
  baseDir: string;
  componentId?: string;
  componentParams?: Record<string, unknown>;
  componentParamDeps?: Set<string>;
};

type TemplateNode =
  | { type: "text"; value: string }
  | { type: "expr"; expr: string };

const TOON_RESERVED = new Set([
  "input", "params", "loop", "id", "true", "false", "null",
  "steps", "executionId", "stepId", "attempt", "signal", "iteration", "services",
]);

const JS_KEYWORDS = new Set([
  "break","case","catch","continue","debugger","default","delete",
  "do","else","finally","for","function","if","in","instanceof",
  "new","return","switch","this","throw","try","typeof","var",
  "void","while","with","class","const","enum","export","extends",
  "import","super","implements","interface","let","package","private",
  "protected","public","static","yield","undefined","NaN","Infinity",
  "Math","Date","JSON","String","Number","Boolean","Array","Object",
  "RegExp","Error","Map","Set","Promise","Symbol","parseInt",
  "parseFloat","isNaN","isFinite","console","window","document",
  "globalThis","eval","arguments","of","from",
]);
```

### 10.2 Template parser (brace-aware, string-literal-safe)

```ts
function parseTemplate(source: string): TemplateNode[] {
  const input = String(source ?? "");
  const nodes: TemplateNode[] = [];
  let textBuf = "";
  const len = input.length;
  let i = 0;

  const pushText = () => {
    if (textBuf) { nodes.push({ type: "text", value: textBuf }); textBuf = ""; }
  };

  while (i < len) {
    if (input.startsWith("{{", i)) { textBuf += "{"; i += 2; continue; }
    if (input.startsWith("}}", i)) { textBuf += "}"; i += 2; continue; }
    if (input[i] === "{") {
      // Depth-aware brace matching — skip braces inside string literals
      let depth = 1;
      let j = i + 1;
      while (j < len && depth > 0) {
        const ch = input[j]!;
        if (ch === "'" || ch === '"' || ch === "`") {
          const quote = ch;
          j += 1;
          while (j < len) {
            if (input[j] === "\\") { j += 2; continue; }
            if (input[j] === quote) { j += 1; break; }
            j += 1;
          }
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        if (depth > 0) j += 1;
      }
      if (depth !== 0) {
        textBuf += input.slice(i);
        i = len;
        break;
      }
      const expr = input.slice(i + 1, j).trim();
      pushText();
      nodes.push({ type: "expr", expr });
      i = j + 1;
      continue;
    }
    textBuf += input[i]!;
    i += 1;
  }
  pushText();
  return nodes;
}
```

### 10.3 Expression evaluator (`new Function` based)

```ts
function evaluateExpression(expr: string, ctx: Record<string, unknown>): any {
  const trimmed = (expr ?? "").trim();
  if (!trimmed) return undefined;
  // Rewrite hyphenated context keys to bracket notation
  let processed = trimmed;
  for (const key of Object.keys(ctx)) {
    if (key.includes("-")) {
      processed = processed.replace(
        new RegExp(`\\b${key.replace(/-/g, "\\-")}\\b`, "g"),
        `__ctx__["${key}"]`,
      );
    }
  }
  const keys = Object.keys(ctx).filter((k) => !k.includes("-"));
  const values = keys.map((k) => ctx[k]);
  try {
    const fn = new Function("__ctx__", ...keys, `return (${processed});`);
    return fn(ctx, ...values);
  } catch {
    return undefined;
  }
}

function collectDepsFromExpression(expr: string, knownStepIds?: Set<string>): Set<string> {
  const deps = new Set<string>();
  const raw = (expr ?? "").trim();
  if (!raw) return deps;
  // Strip string literals to avoid false positives
  const stripped = raw.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
  // Extract identifiers (word chars, may include dots and hyphens for step IDs)
  const matches = stripped.match(/[A-Za-z_$][A-Za-z0-9_$-]*/g);
  if (!matches) return deps;
  for (const m of matches) {
    const root = m.split(".")[0]!;
    if (TOON_RESERVED.has(root)) continue;
    if (JS_KEYWORDS.has(root)) continue;
    if (knownStepIds) {
      if (knownStepIds.has(root)) deps.add(root);
    } else {
      deps.add(root);
    }
  }
  return deps;
}

function collectDepsFromTemplate(template: string, knownStepIds?: Set<string>): Set<string> {
  const deps = new Set<string>();
  const nodes = parseTemplate(template ?? "");
  for (const node of nodes) {
    if (node.type === "expr") {
      for (const dep of collectDepsFromExpression(node.expr, knownStepIds)) deps.add(dep);
    }
  }
  return deps;
}
```

### 10.4 Template rendering helpers

```ts
function formatTemplateValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderTemplateNodes(nodes: TemplateNode[], ctx: any): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") out += node.value;
    else if (node.type === "expr") out += formatTemplateValue(evaluateExpression(node.expr, ctx));
  }
  return out;
}

function renderTemplate(template: string, ctx: any): string {
  return renderTemplateNodes(parseTemplate(template ?? ""), ctx);
}

function resolveTemplateValue(template: string, ctx: any): any {
  const nodes = parseTemplate(template ?? "");
  if (nodes.length === 1 && nodes[0]!.type === "expr") {
    return evaluateExpression((nodes[0] as any).expr, ctx);
  }
  return renderTemplateNodes(nodes, ctx);
}

function applyComponentId(value: unknown, id?: string): unknown {
  if (!id) return value;
  if (typeof value === "string") return value.replace(/\{id\}/g, id);
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveImportPath(spec: string, baseDir: string): string {
  if (spec.startsWith(".") || spec.startsWith("/")) return resolve(baseDir, spec);
  return spec;
}

async function importModule(spec: string, baseDir: string): Promise<any> {
  const resolved = resolveImportPath(spec, baseDir);
  if (resolved.startsWith(".") || resolved.startsWith("/")) {
    return await import(pathToFileURL(resolved).href);
  }
  return await import(resolved);
}
```

### 10.5 Inline schema mini-DSL parser

```ts
function buildJsonSchema(schema: AnySchema): unknown | undefined {
  try { return JSONSchema.make(schema as any); } catch { return undefined; }
}

function parseSchemaType(
  def: unknown,
  registry: Map<string, ToonSchemaEntry>,
  label: string,
): AnySchema {
  if (typeof def === "string") {
    let raw = def.trim();
    let optional = false;
    if (raw.endsWith("?")) { optional = true; raw = raw.slice(0, -1).trim(); }
    if (raw.endsWith("[]")) {
      const inner = raw.slice(0, -2).trim();
      const innerSchema = parseSchemaType(inner, registry, label);
      const arraySchema = Schema.Array(innerSchema);
      return optional ? Schema.optional(arraySchema) : arraySchema;
    }
    if (raw.includes("|")) {
      const parts = raw.split("|").map((p) => p.trim()).filter(Boolean);
      const literals = parts.map((p) => p.replace(/^['"]|['"]$/g, ""));
      const schema = Schema.Literal(...(literals as [string, ...string[]]));
      return optional ? Schema.optional(schema) : schema;
    }
    if (raw.startsWith("\"") && raw.endsWith("\"")) {
      const schema = Schema.Literal(raw.slice(1, -1));
      return optional ? Schema.optional(schema) : schema;
    }
    if (registry.has(raw)) {
      const schema = registry.get(raw)!.schema;
      return optional ? Schema.optional(schema) : schema;
    }
    if (raw === "string")  { const s = Schema.String;  return optional ? Schema.optional(s) : s; }
    if (raw === "number")  { const s = Schema.Number;  return optional ? Schema.optional(s) : s; }
    if (raw === "boolean") { const s = Schema.Boolean; return optional ? Schema.optional(s) : s; }
    throw new SmithersError("TOON_SCHEMA_INVALID", `Unknown schema type "${raw}" for ${label}`);
  }
  if (Array.isArray(def)) {
    if (def.length === 1 && isRecord(def[0])) {
      return Schema.Array(parseSchemaType(def[0], registry, label));
    }
    throw new SmithersError("TOON_SCHEMA_INVALID", `Unsupported schema array definition for ${label}`);
  }
  if (isRecord(def)) {
    const fields: Record<string, AnySchema> = {};
    for (const [key, value] of Object.entries(def)) {
      const optional = key.endsWith("?");
      const fieldKey = optional ? key.slice(0, -1) : key;
      const fieldSchema = parseSchemaType(value, registry, `${label}.${fieldKey}`);
      fields[fieldKey] = optional ? Schema.optional(fieldSchema) : fieldSchema;
    }
    return Schema.Struct(fields);
  }
  throw new SmithersError("TOON_SCHEMA_INVALID", `Invalid schema definition for ${label}`);
}

function parseSchemaEntry(
  def: unknown,
  registry: Map<string, ToonSchemaEntry>,
  label: string,
): ToonSchemaEntry {
  const schema = parseSchemaType(def, registry, label);
  return { schema, jsonSchema: buildJsonSchema(schema) };
}
```

### 10.6 Runtime context shaping

```ts
function buildTemplateContext(
  base: Record<string, unknown>,
  params?: Record<string, unknown>,
  componentId?: string,
): Record<string, unknown> {
  const ctx: Record<string, unknown> = { ...base };
  const iteration = typeof (base as any).iteration === "number" ? (base as any).iteration : 0;
  ctx.loop = { iteration: iteration + 1 };
  if (params) ctx.params = params;
  if (componentId) ctx.id = componentId;

  const steps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === "input" || key === "executionId" || key === "stepId" ||
        key === "attempt" || key === "signal" || key === "iteration") continue;
    steps[key] = value;
  }
  ctx.steps = steps;
  return ctx;
}

function buildRunContext(
  base: Record<string, unknown>,
  params: Record<string, unknown> | undefined,
  componentId: string | undefined,
  services: Map<string, unknown>,
): Record<string, unknown> {
  const full = buildTemplateContext(base, params, componentId);
  const serviceEntries = Array.from(services.entries());
  const serviceCtx = serviceEntries.length > 0 ? Object.fromEntries(serviceEntries) : {};
  const helpers = { Effect, Context, Schema, Layer, Duration, Schedule };
  return {
    ...helpers,
    ...serviceCtx,
    services: serviceCtx,
    ...full,
  };
}

function resolveComponentParams(
  params: Record<string, unknown> | undefined,
  baseCtx: Record<string, unknown>,
  componentId?: string,
): Record<string, unknown> {
  if (!params) return {};
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      const ctx = buildTemplateContext(baseCtx, undefined, componentId);
      resolved[key] = resolveTemplateValue(value, ctx);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}
```

### 10.7 The `run:` and `handler:` execution helpers

```ts
function createRunFunction(code: string): (ctx: any) => Promise<any> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as any;
  const body = `with (ctx) { ${code} }`;
  return new AsyncFunction("ctx", body);
}

function parseHandlerRef(spec: string, baseDir: string): { modulePath: string; exportName?: string } {
  const [pathPart, exportName] = spec.split("#");
  const resolved = resolveImportPath(pathPart, baseDir);
  return { modulePath: resolved, exportName: exportName || undefined };
}

function buildNeedsMap(env: ToonEnv, deps: Set<string>): Record<string, BuilderStepHandle> {
  const needs: Record<string, BuilderStepHandle> = {};
  for (const id of deps) {
    const handle = env.handles.get(id);
    if (!handle) {
      throw new SmithersError("TOON_UNKNOWN_DEPENDENCY", `Unknown dependency "${id}"`);
    }
    needs[id] = handle;
  }
  return needs;
}
```

### 10.8 Auto-injected JSON-output instructions

```ts
function buildPromptInstructions(prompt: string, jsonSchema: unknown | undefined): string {
  if (!jsonSchema) return prompt;
  const schemaDesc = JSON.stringify(jsonSchema, null, 2);
  const jsonInstructions = [
    "**REQUIRED OUTPUT** — You MUST end your response with a JSON object in a code fence matching this schema:",
    "```json",
    schemaDesc,
    "```",
    "Output the JSON at the END of your response. The workflow will fail without it.",
  ].join("\n");
  return [
    "IMPORTANT: After completing the task below, you MUST output a JSON object in a ```json code fence at the very end of your response. Do NOT forget this — the workflow fails without it.",
    "",
    prompt,
    "",
    "",
    jsonInstructions,
  ].join("\n");
}
```

### 10.9 Output extraction from agent text response

```ts
function extractAgentOutput(result: any): any {
  let output: any;
  try {
    if (result && result._output !== undefined && result._output !== null) {
      output = result._output;
    } else if (result && result.output !== undefined && result.output !== null) {
      output = result.output;
    }
  } catch {}

  if (output === undefined) {
    const text = (result?.text ?? "").toString();

    const tryParseJson = (raw: string): any | undefined => {
      try { return JSON.parse(raw); } catch { return undefined; }
    };

    const extractBalancedJson = (str: string): string | null => {
      const start = str.indexOf("{");
      if (start === -1) return null;
      let depth = 0, inString = false, escape = false;
      for (let i = start; i < str.length; i++) {
        const c = str[i]!;
        if (escape) { escape = false; continue; }
        if (c === "\\") { escape = true; continue; }
        if (c === '"' && !escape) { inString = !inString; continue; }
        if (inString) continue;
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) return str.slice(start, i + 1);
        }
      }
      return null;
    };

    const extractLastBalancedJson = (str: string): string | null => {
      let pos = str.lastIndexOf("{");
      while (pos >= 0) {
        const json = extractBalancedJson(str.slice(pos));
        if (json) return json;
        pos = str.lastIndexOf("{", pos - 1);
      }
      return null;
    };

    const fenceMatch = text.match(/```json([\s\S]*?)```/i);
    if (fenceMatch) {
      const json = tryParseJson(fenceMatch[1]!.trim());
      if (json !== undefined) output = json;
    }
    if (output === undefined) {
      const trimmed = text.trim();
      const direct = tryParseJson(trimmed);
      if (direct !== undefined) {
        output = direct;
      } else {
        const extracted = extractLastBalancedJson(text);
        if (extracted) {
          const parsed = tryParseJson(extracted);
          if (parsed !== undefined) output = parsed;
        }
      }
    }
  }
  if (typeof output === "string") {
    try { return JSON.parse(output); } catch { return output; }
  }
  return output;
}
```

### 10.10 Agent factory

```ts
async function buildAgentFromConfig(name: string, config: Record<string, any>): Promise<AgentLike> {
  const type = config.type;
  const opts = { ...config };
  delete opts.type;
  if (!opts.id) opts.id = name;
  if (!type || typeof type !== "string") {
    throw new SmithersError("TOON_AGENT_CONFIG_INVALID", `Agent "${name}" is missing a valid type`);
  }
  switch (type) {
    case "anthropic":
      if (!opts.model) throw new SmithersError("TOON_AGENT_CONFIG_INVALID", `Agent "${name}" (type: anthropic) requires "model"`);
      return new AnthropicAgent(opts as any);
    case "claude-code": return new ClaudeCodeAgent(opts);
    case "codex":       return new CodexAgent(opts);
    case "gemini":      return new GeminiAgent(opts);
    case "openai":
      if (!opts.model) throw new SmithersError("TOON_AGENT_CONFIG_INVALID", `Agent "${name}" (type: openai) requires "model"`);
      return new OpenAIAgent(opts as any);
    case "pi":    return new PiAgent(opts);
    case "kimi":  return new KimiAgent(opts);
    case "forge": return new ForgeAgent(opts);
    case "api": {
      const providerName = opts.provider;
      const modelName = opts.model;
      if (!providerName || !modelName) {
        throw new SmithersError("TOON_AGENT_CONFIG_INVALID", `Agent "${name}" (type: api) requires "provider" and "model"`);
      }
      const rest = { ...opts };
      delete (rest as any).provider;
      delete (rest as any).model;
      if (providerName === "anthropic") return new AnthropicAgent({ model: modelName, ...rest });
      if (providerName === "openai")    return new OpenAIAgent({ model: modelName, ...rest });
      throw new SmithersError("TOON_AGENT_CONFIG_INVALID", `Unsupported api provider "${providerName}" for agent "${name}"`);
    }
    default:
      throw new SmithersError("TOON_AGENT_CONFIG_INVALID", `Unknown agent type "${type}" for "${name}"`);
  }
}

function coerceUseList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw.length > 0) return raw.split(",").map((s) => s.trim());
  return [];
}
```

### 10.11 Import resolvers (one per import-block kind)

```ts
async function resolveImportedSchemas(imports: any, baseDir: string): Promise<Map<string, ToonSchemaEntry>> {
  const out = new Map<string, ToonSchemaEntry>();
  const list = Array.isArray(imports) ? imports : [];
  for (const entry of list) {
    const from = String(entry?.from ?? "");
    const use = coerceUseList(entry?.use);
    if (!from || use.length === 0) continue;
    const mod = await importModule(from, baseDir);
    for (const name of use) {
      const value = mod[name];
      if (!value) throw new SmithersError("TOON_NOT_FOUND", `Schema "${name}" not found in ${from}`);
      out.set(name, { schema: value, jsonSchema: buildJsonSchema(value) });
    }
  }
  return out;
}

async function resolveImportedAgents(imports: any, baseDir: string): Promise<Map<string, AgentLike>> {
  const out = new Map<string, AgentLike>();
  const list = Array.isArray(imports) ? imports : [];
  for (const entry of list) {
    const from = String(entry?.from ?? "");
    const use = coerceUseList(entry?.use);
    if (!from || use.length === 0) continue;
    const mod = await importModule(from, baseDir);
    for (const name of use) {
      const value = mod[name];
      if (!value || typeof value.generate !== "function") {
        throw new SmithersError("TOON_NOT_FOUND", `Agent "${name}" not found in ${from}`);
      }
      out.set(name, value as AgentLike);
    }
  }
  return out;
}

async function resolveImportedServices(imports: any, baseDir: string): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const list = Array.isArray(imports) ? imports : [];
  for (const entry of list) {
    const from = String(entry?.from ?? "");
    const use = coerceUseList(entry?.use);
    if (!from || use.length === 0) continue;
    const mod = await importModule(from, baseDir);
    for (const name of use) {
      const value = mod[name];
      if (value === undefined) {
        throw new SmithersError("TOON_NOT_FOUND", `Service "${name}" not found in ${from}`);
      }
      out.set(name, value);
    }
  }
  return out;
}

async function resolveImportedWorkflows(imports: any, baseDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = Array.isArray(imports) ? imports : [];
  for (const entry of list) {
    const from = String(entry?.from ?? "");
    const alias = String(entry?.as ?? "");
    if (!from || !alias) continue;
    const resolved = resolveImportPath(from, baseDir);
    const absPath = resolved.startsWith(".") || resolved.startsWith("/")
      ? resolved
      : resolve(baseDir, resolved);
    if (out.has(alias)) {
      throw new SmithersError("TOON_DUPLICATE_ALIAS", `Duplicate workflow alias "${alias}" in ${from}`);
    }
    out.set(alias, absPath);
  }
  return out;
}

async function resolveImportedPlugins(imports: any, baseDir: string): Promise<{
  plugins: ToonPlugin[];
  pluginNodes: Map<string, ToonPluginNodeHandler>;
  services: Map<string, unknown>;
  layers: Layer.Layer<never, never, never>[];
}> {
  const plugins: ToonPlugin[] = [];
  const pluginNodes = new Map<string, ToonPluginNodeHandler>();
  const services = new Map<string, unknown>();
  const layers: Layer.Layer<never, never, never>[] = [];
  const list = Array.isArray(imports) ? imports : [];
  for (const entry of list) {
    const from = String(entry?.from ?? "");
    if (!from) continue;
    const mod = await importModule(from, baseDir);
    const exported = mod?.toonPlugin ?? mod?.plugin ?? mod?.default ?? mod;
    const pluginFactory = typeof exported === "function" ? exported : () => exported;
    const plugin = await pluginFactory(entry?.config ?? {});
    if (!plugin || typeof plugin !== "object") {
      throw new SmithersError("TOON_PLUGIN_INVALID", `Plugin "${from}" did not export a plugin object`);
    }
    plugins.push(plugin as ToonPlugin);
    const nodes = (plugin as ToonPlugin).nodes;
    if (nodes && typeof nodes === "object") {
      for (const [kind, handler] of Object.entries(nodes)) {
        if (typeof handler !== "function") continue;
        pluginNodes.set(kind, handler as ToonPluginNodeHandler);
      }
    }
    const pluginServices = (plugin as ToonPlugin).services;
    if (pluginServices && typeof pluginServices === "object") {
      for (const [name, value] of Object.entries(pluginServices)) services.set(name, value);
    }
    const pluginLayers = (plugin as ToonPlugin).layers;
    if (Array.isArray(pluginLayers)) layers.push(...(pluginLayers as Layer.Layer<never, never, never>[]));
    else if (pluginLayers) layers.push(pluginLayers as Layer.Layer<never, never, never>);
  }
  return { plugins, pluginNodes, services, layers };
}
```

### 10.12 `.toon` module loader (used for component/sub-workflow imports)

```ts
const toonModuleCache = new Map<string, Promise<{
  schemas: Map<string, ToonSchemaEntry>;
  components: Map<string, ToonComponentDef>;
  services: Map<string, unknown>;
  pluginNodes: Map<string, ToonPluginNodeHandler>;
  layers: Layer.Layer<never, never, never>[];
}>>();

async function loadToonModule(absPath: string) {
  const cached = toonModuleCache.get(absPath);
  if (cached) return cached;
  const promise = (async () => {
    const rawText = readFileSync(absPath, "utf8");
    const rawData = parseToon(rawText);
    if (!isRecord(rawData)) throw new SmithersError("TOON_INVALID_FILE", `Invalid TOON file: ${absPath}`);
    const data = rawData as Record<string, any>;
    const baseDir = dirname(absPath);
    const imports = isRecord(data.imports) ? data.imports : {};
    const importSchemas    = await resolveImportedSchemas(imports.schemas, baseDir);
    const importServices   = await resolveImportedServices(imports.services, baseDir);
    const importPlugins    = await resolveImportedPlugins(imports.plugins, baseDir);
    const importComponents = await resolveImportedComponents(imports.components, baseDir);

    const schemas = new Map<string, ToonSchemaEntry>(importSchemas);
    for (const [name, entry] of importComponents.schemas) {
      if (!schemas.has(name)) schemas.set(name, entry);
    }
    if (isRecord(data.schemas)) {
      for (const [name, def] of Object.entries(data.schemas)) {
        if (schemas.has(name)) throw new SmithersError("TOON_DUPLICATE_SCHEMA", `Duplicate schema "${name}" in ${absPath}`);
        schemas.set(name, parseSchemaEntry(def, schemas, name));
      }
    }

    const components = new Map<string, ToonComponentDef>(importComponents.components);
    if (isRecord(data.components)) {
      for (const [name, def] of Object.entries(data.components)) {
        if (components.has(name)) throw new SmithersError("TOON_DUPLICATE_COMPONENT", `Duplicate component "${name}" in ${absPath}`);
        if (!isRecord(def) || !Array.isArray((def as any).steps)) {
          throw new SmithersError("TOON_COMPONENT_MISSING_STEPS", `Component "${name}" is missing steps`);
        }
        components.set(name, {
          name,
          params: isRecord((def as any).params) ? (def as any).params : undefined,
          steps: (def as any).steps,
        });
      }
    }

    const services = new Map<string, unknown>(importComponents.services);
    for (const [n, v] of importServices) services.set(n, v);
    for (const [n, v] of importPlugins.services) services.set(n, v);

    const pluginNodes = new Map<string, ToonPluginNodeHandler>(importComponents.pluginNodes);
    for (const [k, h] of importPlugins.pluginNodes) pluginNodes.set(k, h);

    const layers = [...importComponents.layers, ...importPlugins.layers];
    return { schemas, components, services, pluginNodes, layers };
  })();
  toonModuleCache.set(absPath, promise);
  return promise;
}

async function resolveImportedComponents(imports: any, baseDir: string) {
  const components = new Map<string, ToonComponentDef>();
  const schemas = new Map<string, ToonSchemaEntry>();
  const services = new Map<string, unknown>();
  const pluginNodes = new Map<string, ToonPluginNodeHandler>();
  const layers: Layer.Layer<never, never, never>[] = [];
  const list = Array.isArray(imports) ? imports : [];
  for (const entry of list) {
    const from = String(entry?.from ?? "");
    const use = coerceUseList(entry?.use);
    if (!from || use.length === 0) continue;
    const resolved = resolveImportPath(from, baseDir);
    const absPath = resolved.startsWith(".") || resolved.startsWith("/")
      ? resolved
      : resolve(baseDir, resolved);
    const module = await loadToonModule(absPath);
    for (const [n, e] of module.schemas) if (!schemas.has(n)) schemas.set(n, e);
    for (const name of use) {
      const def = module.components.get(name);
      if (!def) throw new SmithersError("TOON_NOT_FOUND", `Component "${name}" not found in ${from}`);
      components.set(name, def);
    }
    for (const [n, v] of module.services) if (!services.has(n)) services.set(n, v);
    for (const [k, h] of module.pluginNodes) if (!pluginNodes.has(k)) pluginNodes.set(k, h);
    if (module.layers.length > 0) layers.push(...module.layers);
  }
  return { components, schemas, services, pluginNodes, layers };
}
```

### 10.13 Plugin handle registration

```ts
function registerPluginHandles(env: ToonEnv, node: BuilderNode) {
  const handles = collectHandles(node);
  for (const handle of handles) {
    const existing = env.handles.get(handle.id);
    if (existing && existing !== handle) {
      throw new SmithersError("TOON_DUPLICATE_STEP", `Duplicate step id "${handle.id}"`);
    }
    if (!existing) {
      if (env.seenIds.has(handle.id)) {
        throw new SmithersError("TOON_DUPLICATE_STEP", `Duplicate step id "${handle.id}"`);
      }
      env.seenIds.add(handle.id);
      env.handles.set(handle.id, handle);
    }
  }
}
```

### 10.14 Recursive node compiler — `compileNodes` and `compileNode`

This is the heart of the compiler. Each `kind:` is a separate branch.

```ts
function compileNodes(nodes: any[], env: ToonEnv): BuilderNode {
  const compiled: BuilderNode[] = nodes.map((node) => compileNode(node, env));
  if (compiled.length === 1) return compiled[0]!;
  return env.builder.sequence(...compiled);
}

function compileNode(node: any, env: ToonEnv): BuilderNode {
  if (!isRecord(node)) throw new SmithersError("TOON_UNKNOWN_NODE", "Invalid TOON node");
  const kind = node.kind;

  // ── sequence ───────────────────────────────────────────────────
  if (kind === "sequence") {
    const children = Array.isArray(node.children) ? node.children : [];
    return env.builder.sequence(...children.map((c: any) => compileNode(c, env)));
  }

  // ── parallel ───────────────────────────────────────────────────
  if (kind === "parallel") {
    const children = Array.isArray(node.children) ? node.children : [];
    const compiled = children.map((c: any) => compileNode(c, env));
    const maxConcurrency = node.maxConcurrency ?? undefined;
    return maxConcurrency === undefined
      ? env.builder.parallel(...compiled)
      : env.builder.parallel(...compiled, { maxConcurrency });
  }

  // ── loop ───────────────────────────────────────────────────────
  if (kind === "loop") {
    const children = Array.isArray(node.children) ? node.children : [];
    const childNode = compileNodes(children, env);
    const untilRaw = applyComponentId(node.until ?? "", env.componentId) as string;
    const untilFn = (ctx: Record<string, unknown>) => {
      const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
      const fullCtx = buildTemplateContext(ctx, params, env.componentId);
      return Boolean(evaluateExpression(untilRaw, fullCtx));
    };
    return env.builder.loop({
      id: node.id ? String(applyComponentId(node.id, env.componentId)) : undefined,
      children: childNode,
      until: untilFn,
      maxIterations: typeof node.maxIterations === "number" ? node.maxIterations : undefined,
      onMaxReached: node.onMaxReached === "fail" ? "fail"
                  : node.onMaxReached === "return-last" ? "return-last"
                  : undefined,
    });
  }

  // ── branch ─────────────────────────────────────────────────────
  if (kind === "branch") {
    const conditionRaw = applyComponentId(node.condition ?? "", env.componentId) as string;
    const deps = collectDepsFromExpression(conditionRaw, env.seenIds);
    const needs = buildNeedsMap(env, deps);
    const thenNodes = Array.isArray(node.then) ? node.then : [];
    const elseNodes = Array.isArray(node.else) ? node.else : [];
    const thenNode = compileNodes(thenNodes, env);
    const elseNode = elseNodes.length ? compileNodes(elseNodes, env) : undefined;
    return {
      kind: "branch",
      needs,
      condition: (ctx) => {
        const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
        const fullCtx = buildTemplateContext(ctx, params, env.componentId);
        return Boolean(evaluateExpression(conditionRaw, fullCtx));
      },
      then: thenNode,
      else: elseNode,
    };
  }

  // ── worktree ───────────────────────────────────────────────────
  if (kind === "worktree") {
    const children = Array.isArray(node.children) ? node.children : [];
    const childNode = compileNodes(children, env);
    const skipIfRaw = node.skipIf ? String(applyComponentId(node.skipIf, env.componentId)) : undefined;
    const skipDeps = skipIfRaw ? collectDepsFromExpression(skipIfRaw, env.seenIds) : new Set<string>();
    const needs = skipDeps.size ? buildNeedsMap(env, skipDeps) : undefined;
    return {
      kind: "worktree",
      id: node.id ? String(applyComponentId(node.id, env.componentId)) : undefined,
      path: String(node.path ?? ""),
      branch: node.branch ? String(node.branch) : undefined,
      needs,
      skipIf: skipIfRaw
        ? (ctx) => {
            const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
            const fullCtx = buildTemplateContext(ctx, params, env.componentId);
            return Boolean(evaluateExpression(skipIfRaw, fullCtx));
          }
        : undefined,
      children: childNode,
    };
  }

  // ── workflow (sub-workflow invocation) ─────────────────────────
  if (kind === "workflow") {
    const id = String(applyComponentId(node.id, env.componentId) ?? "");
    if (!id) throw new SmithersError("TOON_WORKFLOW_INVALID", "Workflow node missing id");
    if (env.seenIds.has(id)) throw new SmithersError("TOON_DUPLICATE_STEP", `Duplicate step id "${id}"`);
    env.seenIds.add(id);
    const alias = String(node.use ?? "");
    if (!alias) throw new SmithersError("TOON_WORKFLOW_INVALID", `Workflow step "${id}" is missing "use"`);
    const workflowPath = env.workflows.get(alias);
    if (!workflowPath) throw new SmithersError("TOON_NOT_FOUND", `Workflow "${alias}" not found`);
    const inputDef = isRecord(node.input) ? node.input : {};
    const deps = new Set<string>();
    for (const value of Object.values(inputDef)) {
      if (typeof value === "string") {
        const applied = String(applyComponentId(value, env.componentId));
        if (applied.includes("{")) {
          for (const dep of collectDepsFromTemplate(applied, env.seenIds)) deps.add(dep);
        } else {
          for (const dep of collectDepsFromExpression(applied, env.seenIds)) deps.add(dep);
        }
      }
    }
    if (env.componentParamDeps) for (const dep of env.componentParamDeps) deps.add(dep);
    const needs = deps.size ? buildNeedsMap(env, deps) : {};
    const runFn = async (ctx: any) => {
      const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
      const fullCtx = buildRunContext(ctx, params, env.componentId, env.services);
      const input: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(inputDef)) {
        if (typeof value === "string") {
          const applied = String(applyComponentId(value, env.componentId));
          input[key] = applied.includes("{")
            ? resolveTemplateValue(applied, fullCtx)
            : evaluateExpression(applied, fullCtx);
        } else input[key] = value;
      }
      const workflow = await getToonWorkflow(workflowPath);
      return (workflow as any).execute(input, { workflowPath });
    };
    const handle = env.builder.step(id, { output: Schema.Unknown, run: runFn, needs });
    env.handles.set(id, handle);
    return handle;
  }

  // ── component (instantiate) ────────────────────────────────────
  if (kind === "component") {
    const instanceId = String(node.id ?? "").trim();
    if (!instanceId) throw new SmithersError("TOON_WORKFLOW_INVALID", "Component instance is missing id");
    const useName = String(node.use ?? "");
    const def = env.components.get(useName);
    if (!def) throw new SmithersError("TOON_NOT_FOUND", `Component "${useName}" not found`);
    const withParams = isRecord(node.with) ? node.with : {};
    const appliedParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(withParams)) {
      appliedParams[key] = applyComponentId(value, env.componentId);
    }
    const paramDeps = new Set<string>();
    for (const value of Object.values(appliedParams)) {
      if (typeof value === "string") {
        for (const dep of collectDepsFromTemplate(value, env.seenIds)) paramDeps.add(dep);
      }
    }
    const nextEnv: ToonEnv = {
      ...env,
      componentId: instanceId,
      componentParams: appliedParams,
      componentParamDeps: paramDeps,
    };
    return compileNodes(def.steps, nextEnv);
  }

  // ── approval ───────────────────────────────────────────────────
  if (kind === "approval") {
    const id = String(applyComponentId(node.id, env.componentId) ?? "");
    if (!id) throw new SmithersError("TOON_WORKFLOW_INVALID", "Approval node missing id");
    if (env.seenIds.has(id)) throw new SmithersError("TOON_DUPLICATE_STEP", `Duplicate step id "${id}"`);
    env.seenIds.add(id);
    const deps = new Set<string>();
    for (const dep of coerceUseList(node.needs)) {
      deps.add(String(applyComponentId(dep, env.componentId)));
    }
    const titleTemplate = applyComponentId(node.request?.title ?? "", env.componentId) as string;
    const summaryTemplate = node.request?.summary
      ? String(applyComponentId(node.request.summary, env.componentId)) : undefined;
    for (const dep of collectDepsFromTemplate(titleTemplate, env.seenIds)) deps.add(dep);
    if (summaryTemplate) for (const dep of collectDepsFromTemplate(summaryTemplate, env.seenIds)) deps.add(dep);
    const needs = buildNeedsMap(env, deps);
    const request = (ctx: Record<string, unknown>) => {
      const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
      const fullCtx = buildTemplateContext(ctx, params, env.componentId);
      return {
        title: renderTemplate(titleTemplate, fullCtx),
        summary: summaryTemplate ? renderTemplate(summaryTemplate, fullCtx) : null,
      };
    };
    const handle = env.builder.approval(id, {
      needs,
      request,
      onDeny: node.onDeny === "continue" || node.onDeny === "skip" ? node.onDeny : "fail",
    });
    env.handles.set(id, handle);
    return handle;
  }

  // ── plugin-defined kinds ───────────────────────────────────────
  if (typeof kind === "string" && kind.length > 0) {
    const handler = env.pluginNodes.get(kind);
    if (handler) {
      const result = handler(node, env, { compileNode, compileNodes });
      registerPluginHandles(env, result);
      return result;
    }
    throw new SmithersError("TOON_UNKNOWN_NODE", `Unknown TOON node kind "${kind}"`);
  }

  // ── default: a plain step (prompt | run | handler) ─────────────
  const id = String(applyComponentId(node.id, env.componentId) ?? "");
  if (!id) throw new SmithersError("TOON_WORKFLOW_INVALID", "Step node missing id");
  if (env.seenIds.has(id)) throw new SmithersError("TOON_DUPLICATE_STEP", `Duplicate step id "${id}"`);
  env.seenIds.add(id);

  // Resolve output schema (named or inline)
  const outputDef = node.output;
  let outputEntry: ToonSchemaEntry | undefined;
  if (typeof outputDef === "string" && env.schemas.has(outputDef)) {
    outputEntry = env.schemas.get(outputDef);
  } else if (outputDef !== undefined) {
    outputEntry = parseSchemaEntry(outputDef, env.schemas, id);
  }
  if (!outputEntry) throw new SmithersError("TOON_STEP_MISSING_OUTPUT", `Step "${id}" is missing output schema`);

  // Resolve prompt: inline text OR a name in env.prompts
  const rawPrompt = node.prompt !== undefined ? String(applyComponentId(node.prompt, env.componentId)) : undefined;
  const prompt = rawPrompt !== undefined && env.prompts.has(rawPrompt) ? env.prompts.get(rawPrompt)! : rawPrompt;

  const runCode = node.run !== undefined ? String(node.run) : undefined;
  const handlerRef = node.handler !== undefined ? String(node.handler) : undefined;
  const hasPrompt = typeof prompt === "string";
  const hasRun = typeof runCode === "string";
  const hasHandler = typeof handlerRef === "string";

  if ((hasPrompt ? 1 : 0) + (hasRun ? 1 : 0) + (hasHandler ? 1 : 0) !== 1) {
    throw new SmithersError("TOON_STEP_AMBIGUOUS", `Step "${id}" must define exactly one of prompt, run, or handler`);
  }

  // Collect dependencies
  const deps = new Set<string>();
  for (const dep of coerceUseList(node.needs)) deps.add(String(applyComponentId(dep, env.componentId)));
  if (prompt) for (const dep of collectDepsFromTemplate(prompt, env.seenIds)) deps.add(dep);
  const skipIfRaw = node.skipIf !== undefined ? String(applyComponentId(node.skipIf, env.componentId)) : undefined;
  if (skipIfRaw) for (const dep of collectDepsFromExpression(skipIfRaw, env.seenIds)) deps.add(dep);
  if (env.componentParamDeps) for (const dep of env.componentParamDeps) deps.add(dep);

  // Build cache policy if `cache.by` or `cache.version` is set
  let cachePolicy: CachePolicy | undefined;
  if (isRecord(node.cache)) {
    const version = node.cache.version != null ? String(node.cache.version) : undefined;
    const rawBy = Array.isArray(node.cache.by) ? node.cache.by
                : node.cache.by !== undefined ? [node.cache.by] : [];
    const byEntries = rawBy
      .map((v: any) => String(applyComponentId(v, env.componentId)))
      .filter((v: string) => v.length > 0);
    for (const entry of byEntries) {
      if (entry.includes("{")) for (const dep of collectDepsFromTemplate(entry, env.seenIds)) deps.add(dep);
      else for (const dep of collectDepsFromExpression(entry, env.seenIds)) deps.add(dep);
    }
    if (byEntries.length > 0 || version) {
      cachePolicy = {
        version,
        by: (ctx: any) => {
          const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
          const fullCtx = buildRunContext(ctx, params, env.componentId, env.services);
          const payload: Record<string, unknown> = {};
          for (const entry of byEntries) {
            payload[entry] = entry.includes("{")
              ? resolveTemplateValue(entry, fullCtx)
              : evaluateExpression(entry, fullCtx);
          }
          return payload;
        },
      };
    }
  }

  const needs = deps.size ? buildNeedsMap(env, deps) : {};

  // Build the runner
  let runFn: (ctx: any) => any;
  if (hasPrompt) {
    const agentName = String(node.agent ?? "");
    if (!agentName) throw new SmithersError("TOON_STEP_MISSING_AGENT", `Prompt step "${id}" requires an agent`);
    const agent = env.agents.get(agentName);
    if (!agent) throw new SmithersError("TOON_STEP_MISSING_AGENT", `Agent "${agentName}" not found for step "${id}"`);
    const timeoutMs = durationToMs(node.timeout);
    runFn = async (ctx: any) => {
      const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
      const fullCtx = buildTemplateContext(ctx, params, env.componentId);
      const renderedPrompt = renderTemplate(prompt, fullCtx);
      const finalPrompt = buildPromptInstructions(renderedPrompt, outputEntry!.jsonSchema);
      const result = await agent.generate({
        prompt: finalPrompt,
        abortSignal: ctx.signal,
        timeout: timeoutMs ? { totalMs: timeoutMs } : undefined,
      });
      return extractAgentOutput(result);
    };
  } else if (hasRun) {
    const fn = createRunFunction(runCode!);
    runFn = async (ctx: any) => {
      const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
      const fullCtx = buildRunContext(ctx, params, env.componentId, env.services);
      return await fn(fullCtx);
    };
  } else {
    const handler = parseHandlerRef(handlerRef!, env.baseDir);
    let cached: { mod?: any; fn?: any } = {};
    runFn = async (ctx: any) => {
      if (!cached.fn) {
        const mod = await importModule(handler.modulePath, env.baseDir);
        const fn = handler.exportName ? mod[handler.exportName] : mod.default;
        if (typeof fn !== "function") {
          throw new SmithersError("TOON_HANDLER_INVALID", `Handler "${handlerRef}" did not export a function`);
        }
        cached.mod = mod;
        cached.fn = fn;
      }
      const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
      const fullCtx = buildRunContext(ctx, params, env.componentId, env.services);
      return await cached.fn(fullCtx);
    };
  }

  // Retry policy: number, {maxAttempts, backoff, initialDelay}, or flat maxAttempts
  const retrySource = node.retry;
  const flatMaxAttempts = typeof node.maxAttempts === "number" ? node.maxAttempts : undefined;
  const retryCount =
    typeof retrySource === "number" ? Math.max(0, Math.floor(retrySource)) :
    typeof retrySource?.maxAttempts === "number" ? Math.max(0, Math.floor(retrySource.maxAttempts - 1)) :
    flatMaxAttempts !== undefined ? Math.max(0, Math.floor(flatMaxAttempts - 1)) : undefined;
  const retryPolicy: RetryPolicy | undefined =
    retrySource && typeof retrySource === "object"
      ? {
          backoff: ["exponential","linear","fixed"].includes(retrySource.backoff) ? retrySource.backoff : undefined,
          initialDelayMs: durationToMs(retrySource.initialDelay) ?? undefined,
        }
      : undefined;

  const handle = env.builder.step(id, {
    output: outputEntry.schema,
    run: runFn,
    needs,
    retry: retryCount,
    retryPolicy,
    timeout: node.timeout,
    cache: cachePolicy,
    skipIf: skipIfRaw
      ? (ctx: any) => {
          const params = resolveComponentParams(env.componentParams, ctx, env.componentId);
          const fullCtx = buildTemplateContext(ctx, params, env.componentId);
          return Boolean(evaluateExpression(skipIfRaw, fullCtx));
        }
      : undefined,
  });
  env.handles.set(id, handle);
  return handle;
}
```

### 10.15 Top-level `compileToon` — turns a path into a `BuiltSmithersWorkflow`

```ts
async function compileToon(absPath: string): Promise<{
  name: string;
  inputSchema: AnySchema;
  buildGraph: (builder: BuilderApi) => BuilderNode;
  pluginLayers: Layer.Layer<never, never, never>[];
}> {
  const rawText = readFileSync(absPath, "utf8");
  const rawData = parseToon(rawText);
  if (!isRecord(rawData)) throw new SmithersError("TOON_INVALID_FILE", `Invalid TOON file: ${absPath}`);
  const data = rawData as Record<string, any>;
  const name = String(data.name ?? "").trim();
  if (!name) throw new SmithersError("TOON_WORKFLOW_INVALID", `TOON workflow missing name: ${absPath}`);
  const baseDir = dirname(absPath);

  const imports = isRecord(data.imports) ? data.imports : {};
  const importedSchemas    = await resolveImportedSchemas(imports.schemas, baseDir);
  const importedServices   = await resolveImportedServices(imports.services, baseDir);
  const importedAgents     = await resolveImportedAgents(imports.agents, baseDir);
  const importedComponents = await resolveImportedComponents(imports.components, baseDir);
  const importedWorkflows  = await resolveImportedWorkflows(imports.workflows, baseDir);
  const importedPlugins    = await resolveImportedPlugins(imports.plugins, baseDir);

  const schemas = new Map<string, ToonSchemaEntry>(importedSchemas);
  for (const [n, e] of importedComponents.schemas) if (!schemas.has(n)) schemas.set(n, e);
  if (isRecord(data.schemas)) {
    for (const [n, def] of Object.entries(data.schemas)) {
      if (schemas.has(n)) throw new SmithersError("TOON_DUPLICATE_SCHEMA", `Duplicate schema "${n}" in ${absPath}`);
      schemas.set(n, parseSchemaEntry(def, schemas, n));
    }
  }

  const components = new Map<string, ToonComponentDef>(importedComponents.components);
  if (isRecord(data.components)) {
    for (const [compName, def] of Object.entries(data.components)) {
      if (components.has(compName)) throw new SmithersError("TOON_DUPLICATE_COMPONENT", `Duplicate component "${compName}" in ${absPath}`);
      if (!isRecord(def) || !Array.isArray((def as any).steps)) {
        throw new SmithersError("TOON_COMPONENT_MISSING_STEPS", `Component "${compName}" is missing steps`);
      }
      components.set(compName, {
        name: compName,
        params: isRecord((def as any).params) ? (def as any).params : undefined,
        steps: (def as any).steps,
      });
    }
  }

  // Agents: object form OR tabular form (rows of {name, type, model, ...})
  const agents = new Map<string, AgentLike>(importedAgents);
  if (isRecord(data.agents)) {
    for (const [agentName, def] of Object.entries(data.agents)) {
      if (!isRecord(def)) throw new SmithersError("TOON_AGENT_CONFIG_INVALID", `Agent "${agentName}" definition must be an object`);
      agents.set(agentName, await buildAgentFromConfig(agentName, def));
    }
  } else if (Array.isArray(data.agents)) {
    for (const row of data.agents) {
      if (!isRecord(row) || typeof row.name !== "string") {
        throw new SmithersError("TOON_AGENT_CONFIG_INVALID", `Agent array entry must have a "name" field`);
      }
      const agentName = row.name;
      const def = { ...row };
      delete (def as any).name;
      agents.set(agentName, await buildAgentFromConfig(agentName, def));
    }
  }

  const services = new Map<string, unknown>(importedComponents.services);
  for (const [n, v] of importedServices) services.set(n, v);
  for (const [n, v] of importedPlugins.services) services.set(n, v);

  const workflows = new Map<string, string>(importedWorkflows);

  const pluginNodes = new Map<string, ToonPluginNodeHandler>(importedComponents.pluginNodes);
  for (const [k, h] of importedPlugins.pluginNodes) pluginNodes.set(k, h);
  const pluginLayers = [...importedComponents.layers, ...importedPlugins.layers];

  // Named prompts
  const prompts = new Map<string, string>();
  if (isRecord(data.prompts)) {
    for (const [pn, pt] of Object.entries(data.prompts)) {
      if (typeof pt !== "string") throw new SmithersError("TOON_WORKFLOW_INVALID", `Prompt "${pn}" must be a string`);
      prompts.set(pn, pt);
    }
  }

  const inputDef = data.input;
  if (!inputDef) throw new SmithersError("TOON_WORKFLOW_INVALID", `TOON workflow "${name}" missing input schema`);
  const inputSchema = typeof inputDef === "string" && schemas.has(inputDef)
    ? schemas.get(inputDef)!.schema
    : parseSchemaEntry(inputDef, schemas, "input").schema;

  const steps = Array.isArray(data.steps) ? data.steps : [];
  if (steps.length === 0) throw new SmithersError("TOON_WORKFLOW_INVALID", `TOON workflow "${name}" has no steps`);
  const buildGraph = (builder: BuilderApi) => {
    const env: ToonEnv = {
      builder,
      handles: new Map(), seenIds: new Set(),
      schemas, agents, components, services,
      workflows, pluginNodes, prompts, baseDir,
    };
    return compileNodes(steps, env);
  };

  return { name, inputSchema, buildGraph, pluginLayers };
}
```

### 10.16 Public surface and caches

```ts
const toonWorkflowCache = new Map<string, Promise<BuiltSmithersWorkflow>>();

function getToonWorkflow(path: string): Promise<BuiltSmithersWorkflow> {
  const absPath = resolve(process.cwd(), path);
  const cached = toonWorkflowCache.get(absPath);
  if (cached) return cached;
  const promise = compileToon(absPath).then((compiled) => {
    const workflow = createWorkflow({ name: compiled.name, input: compiled.inputSchema })
      .build(($) => compiled.buildGraph($));
    if (compiled.pluginLayers.length === 0) return workflow;
    const merged = Layer.mergeAll(
      ...(compiled.pluginLayers as [
        Layer.Layer<never, never, never>,
        ...Layer.Layer<never, never, never>[]
      ]),
    );
    return {
      execute: (input, opts) => workflow.execute(input, opts).pipe(Effect.provide(merged)),
    } as BuiltSmithersWorkflow;
  });
  toonWorkflowCache.set(absPath, promise);
  return promise;
}

function loadToon(path: string): BuiltSmithersWorkflow {
  return {
    execute(input: unknown, opts?) {
      return Effect.gen(function* () {
        const workflow = yield* Effect.promise(() => getToonWorkflow(path));
        return yield* (workflow as any).execute(input, opts);
      });
    },
  };
}

function sqlite(options: { filename: string }) {
  return Layer.succeed(SmithersSqlite, options);
}

export const Smithers = {
  sqlite,        // Layer factory: { filename } → SmithersSqlite layer
  loadToon,      // (path) => BuiltSmithersWorkflow
};
```

### 10.17 SmithersError codes thrown by the compiler

```
TOON_INVALID_FILE          TOON_WORKFLOW_INVALID
TOON_DUPLICATE_STEP        TOON_DUPLICATE_SCHEMA
TOON_DUPLICATE_COMPONENT   TOON_DUPLICATE_ALIAS
TOON_UNKNOWN_NODE          TOON_UNKNOWN_DEPENDENCY
TOON_NOT_FOUND             TOON_STEP_MISSING_OUTPUT
TOON_STEP_MISSING_AGENT    TOON_STEP_AMBIGUOUS
TOON_NESTED_LOOP           TOON_AGENT_CONFIG_INVALID
TOON_SCHEMA_INVALID        TOON_PLUGIN_INVALID
TOON_HANDLER_INVALID       TOON_COMPONENT_MISSING_STEPS
```

---

## 11. The Compile Target: `BuilderNode` and Engine Wiring

This is what TOON (or anything else, including a Lion-lang compiler) must produce. None of this needs to change for a new front-end.

### 11.1 The `BuilderNode` discriminated union

```ts
type BuilderStepContext = Record<string, unknown> & {
  input: unknown;
  executionId: string;
  stepId: string;
  attempt: number;
  signal: AbortSignal;
  iteration: number;
};

type StepOptions = {
  output: AnySchema;                                  // Effect Schema
  run: (ctx: BuilderStepContext) => AnyEffect;
  needs?: Record<string, BuilderStepHandle>;
  retry?: any;                                        // number, schedule, or {maxAttempts, ...}
  retryPolicy?: RetryPolicy;
  timeout?: unknown;                                  // duration string or number
  cache?: CachePolicy;
  skipIf?: (ctx: BuilderStepContext) => boolean;
};

type ApprovalOptions = {
  needs?: Record<string, BuilderStepHandle>;
  request: (ctx: Record<string, unknown>) => { title: string; summary?: string | null };
  onDeny?: "fail" | "continue" | "skip";
};

type BuilderStepHandle = {
  kind: "step" | "approval";
  id: string;
  localId: string;
  tableKey: string;
  tableName: string;
  table: any;                  // Drizzle table
  output: AnySchema;
  needs: Record<string, BuilderStepHandle>;
  run?: (ctx: BuilderStepContext) => AnyEffect;
  request?: ApprovalOptions["request"];
  onDeny?: "fail" | "continue" | "skip";
  retries: number;
  retryPolicy?: RetryPolicy;
  timeoutMs: number | null;
  skipIf?: (ctx: BuilderStepContext) => boolean;
  loopId?: string;
  cache?: CachePolicy;
};

type SequenceNode  = { kind: "sequence";  children: BuilderNode[] };
type ParallelNode  = { kind: "parallel";  children: BuilderNode[]; maxConcurrency?: number };
type LoopNode      = { kind: "loop";      id?: string; children: BuilderNode;
                       until: (outputs: Record<string, unknown>) => boolean;
                       maxIterations?: number; onMaxReached?: "fail" | "return-last";
                       handles?: BuilderStepHandle[] };
type MatchNode     = { kind: "match";     source: BuilderStepHandle;
                       when: (value: any) => boolean;
                       then: BuilderNode; else?: BuilderNode };
type BranchNode    = { kind: "branch";    condition: (ctx: Record<string, unknown>) => boolean;
                       needs?: Record<string, BuilderStepHandle>;
                       then: BuilderNode; else?: BuilderNode };
type WorktreeNode  = { kind: "worktree";  id?: string; path: string; branch?: string;
                       skipIf?: (ctx: Record<string, unknown>) => boolean;
                       needs?: Record<string, BuilderStepHandle>; children: BuilderNode };

type BuilderNode =
  | BuilderStepHandle | SequenceNode | ParallelNode
  | LoopNode | MatchNode | BranchNode | WorktreeNode;
```

### 11.2 The `BuilderApi` (handed to `compileToon`'s `buildGraph`)

```ts
type BuilderApi = {
  step:     (id: string, options: StepOptions) => BuilderStepHandle;
  approval: (id: string, options: ApprovalOptions) => BuilderStepHandle;
  sequence: (...nodes: BuilderNode[]) => BuilderNode;
  parallel: (...args: Array<BuilderNode | { maxConcurrency?: number }>) => BuilderNode;
  loop: (options: {
    id?: string;
    children: BuilderNode;
    until: (outputs: Record<string, unknown>) => boolean;
    maxIterations?: number;
    onMaxReached?: "fail" | "return-last";
  }) => BuilderNode;
  match: (source: BuilderStepHandle, options: {
    when: (value: any) => boolean;
    then: () => BuilderNode;
    else?: () => BuilderNode;
  }) => BuilderNode;
  component: (
    instanceId: string,
    definition: ComponentDefinition,
    params: Record<string, unknown>,
  ) => BuilderNode;
};
```

### 11.3 Builder factory (`createBuilder`) — produces `BuilderApi`

```ts
function createBuilder(prefix = ""): BuilderApi {
  const applyPrefix = (id: string) => (prefix ? `${prefix}.${id}` : id);

  const step = (id: string, options: StepOptions): BuilderStepHandle => {
    const fullId = applyPrefix(id);
    const tableName = makeTableName(fullId);
    return {
      kind: "step", id: fullId, localId: id,
      tableKey: sanitizeIdentifier(fullId),
      tableName, table: createPayloadTable(tableName),
      output: options.output, needs: options.needs ?? {},
      run: options.run,
      retries: deriveRetryCount(options.retry),
      retryPolicy: options.retryPolicy ?? deriveRetryPolicy(options.retry),
      timeoutMs: durationToMs(options.timeout),
      skipIf: options.skipIf, cache: options.cache,
    };
  };

  const approval = (id: string, options: ApprovalOptions): BuilderStepHandle => {
    const fullId = applyPrefix(id);
    const tableName = makeTableName(fullId);
    return {
      kind: "approval", id: fullId, localId: id,
      tableKey: sanitizeIdentifier(fullId),
      tableName, table: createPayloadTable(tableName),
      output: ApprovalDecision,            // built-in schema
      needs: options.needs ?? {},
      request: options.request,
      onDeny: options.onDeny ?? "fail",
      retries: 0, timeoutMs: null,
    };
  };

  return {
    step, approval,
    sequence: (...nodes) => ({ kind: "sequence", children: nodes }),
    parallel: (...args) => {
      let maxConcurrency: number | undefined;
      const items = [...args];
      const last = items[items.length - 1];
      if (last && typeof last === "object" && !Array.isArray(last) && !isBuilderNode(last) && "maxConcurrency" in last) {
        maxConcurrency = Number((last as any).maxConcurrency);
        items.pop();
      }
      return { kind: "parallel", children: items as BuilderNode[], maxConcurrency };
    },
    loop: (options) => ({
      kind: "loop",
      id: options.id ? applyPrefix(options.id) : undefined,
      children: options.children,
      until: options.until,
      maxIterations: options.maxIterations,
      onMaxReached: options.onMaxReached,
    }),
    match: (source, options) => ({
      kind: "match", source,
      when: options.when,
      then: options.then(),
      else: options.else?.(),
    }),
    component: (instanceId, definition, params) =>
      definition.buildWithPrefix(applyPrefix(instanceId), params),
  };
}
```

### 11.4 Duration parsing and retry helpers

```ts
function durationToMs(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input === "string") {
    const match = input.trim().match(/^(-?\d+(?:\.\d+)?)(ms|s|m|h)$/i);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) {
        const unit = match[2]!.toLowerCase();
        const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
        return Math.max(0, Math.floor(value * factor));
      }
    }
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    return Math.max(0, Math.floor(input));
  }
  try {
    return Math.max(0, Math.floor(Duration.toMillis(Duration.decode(input as any))));
  } catch { return null; }
}

function deriveRetryPolicy(retry: unknown): RetryPolicy | undefined {
  if (!retry || typeof retry !== "object") return undefined;
  const backoff = (retry as any).backoff;
  const initialDelayMs = durationToMs((retry as any).initialDelay);
  if (backoff !== "fixed" && backoff !== "linear" && backoff !== "exponential" && initialDelayMs == null) {
    return undefined;
  }
  return {
    backoff: ["fixed","linear","exponential"].includes(backoff) ? backoff : undefined,
    initialDelayMs: initialDelayMs ?? undefined,
  };
}

function deriveRetryCount(retry: unknown): number {
  if (retry == null) return 0;
  if (typeof retry === "number" && Number.isFinite(retry)) return Math.max(0, Math.floor(retry));
  if (typeof retry === "object" && retry !== null) {
    const maxAttempts = (retry as any).maxAttempts;
    if (typeof maxAttempts === "number" && Number.isFinite(maxAttempts)) {
      return Math.max(0, Math.floor(maxAttempts - 1));
    }
  }
  // Fallback: drive an Effect Schedule and count steps until it terminates
  try {
    const driver = Effect.runSync(Schedule.driver(retry as any));
    let count = 0;
    while (count < 100) {
      const exit = Effect.runSyncExit(driver.next(undefined) as any);
      if (Exit.isFailure(exit)) return count;
      count += 1;
    }
    return count;
  } catch { return 0; }
}
```

### 11.5 SQLite payload table per step

```ts
function createPayloadTable(name: string) {
  return sqliteTable(
    name,
    {
      runId: text("run_id").notNull(),
      nodeId: text("node_id").notNull(),
      iteration: integer("iteration").notNull().default(0),
      payload: text("payload", { mode: "json" }).$type<Record<string, unknown> | null>(),
    },
    (t) => ({ pk: primaryKey({ columns: [t.runId, t.nodeId, t.iteration] }) }),
  );
}

function sanitizeIdentifier(value: string): string {
  return camelToSnake(value)
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "node";
}

function makeTableName(id: string): string { return `smithers_${sanitizeIdentifier(id)}`; }
```

### 11.6 `createWorkflow` — compile into a runnable `BuiltSmithersWorkflow`

```ts
type BuiltSmithersWorkflow = {
  execute: (
    input: unknown,
    opts?: Omit<Parameters<typeof runWorkflow>[1], "input">,
  ) => AnyEffect;
};

function createWorkflow(options: { name: string; input: AnySchema }) {
  return {
    build(buildGraph: ($: BuilderApi) => BuilderNode): BuiltSmithersWorkflow {
      const root = buildGraph(createBuilder());
      annotateLoops(root);                         // tags step handles with their loop id
      const handles = collectHandles(root);

      return {
        execute(input, opts) {
          return Effect.gen(function* () {
            const env = yield* Effect.context<any>();
            const sqliteConfig = yield* SmithersSqlite;
            const decodedInput = decodeSchema(options.input, input);
            const encodedInput = JSON.parse(
              JSON.stringify(encodeSchema(options.input, decodedInput) ?? {}),
            ) as Record<string, unknown>;

            return yield* Effect.promise(async () => {
              const runtime = createBuilderDb(sqliteConfig.filename, handles);
              try {
                const workflow = {
                  db: runtime.db,
                  build: (ctx: any) =>
                    React.createElement(
                      Workflow,
                      { name: options.name },
                      renderNode(ctx && root ? root : root, ctx, decodedInput, env),
                    ),
                  opts: {},
                } as any;

                const result = await runWorkflow(workflow, {
                  ...(opts ?? {}),
                  input: encodedInput as Record<string, unknown>,
                });

                if (result.status === "finished") {
                  return await extractResult(root, runtime.db, result.runId, decodedInput);
                }
                if (result.status === "waiting-approval") return result;
                throw normalizeExecutionError(result);
              } finally {
                try { runtime.sqlite.close(); } catch {}
              }
            });
          });
        },
      };
    },
  };
}
```

### 11.7 The big-picture lifecycle

`createWorkflow` produces a `BuiltSmithersWorkflow`. Its `execute()` does:

1. Read the SQLite filename from the `SmithersSqlite` context tag.
2. Decode + encode the user input through the workflow's input schema.
3. Open a SQLite connection, ensure all per-step payload tables exist.
4. Build the React/JSX tree by recursively calling `renderNode` over the `BuilderNode` graph (each step compiles to a `<Task>`, parallels to `<Parallel>`, etc.). The same JSX components Smithers ships are reused.
5. Call `runWorkflow(workflow, { input: encodedInput, ... })` — the durable execution engine.
6. On `finished`, walk the graph again with `extractResult` to produce the workflow's return value (the leaf-most output, or a parallel array, etc.).
7. On `waiting-approval`, return that signal so the caller can handle it.
8. On any other status, throw the normalized error.

The key insight: **TOON's compile output is JSX-shaped.** A Lisp surface should produce the same JSX-shaped graph (via `BuilderApi`).

---

## 12. CLI Dispatch

Excerpt from `src/cli/index.ts` showing how `smithers run path.toon` and `smithers resume path.toon` dispatch:

```ts
const isToon = extname(resolvedWorkflowPath) === ".toon";
// ...
if (isToon) {
  const dbPath = resolve(dirname(resolvedWorkflowPath), "smithers.db");
  const toonWorkflow = Smithers.loadToon(workflowPath);
  const result = await runPromise(
    toonWorkflow.execute(input, {
      runId, resume,
      workflowPath: resolvedWorkflowPath,
      maxConcurrency: options.maxConcurrency,
      rootDir, logDir,
      allowNetwork: options.allowNetwork,
      maxOutputBytes: options.maxOutputBytes,
      toolTimeoutMs: options.toolTimeoutMs,
      hot: options.hot,
      onProgress, signal: abort.signal,
    }).pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  // ...
}
```

For TOON workflows, the SQLite DB is by convention `<workflow_dir>/smithers.db`.

The CLI verbs `run`, `resume`, `approve`, `list`, `status`, `frames`, `graph`, `revert`, `cancel` all dispatch on `extname(...) === ".toon"`.

---

## 13. Plugin System

A plugin is an ESM module exported as either:
- `export default plugin` (a plugin object), or
- `export default (config) => plugin` (a factory taking the import's `config`),
- or `export const toonPlugin = ...` / `export const plugin = ...`.

The plugin object's shape:

```ts
type ToonPlugin = {
  name?: string;
  nodes?: Record<string, ToonPluginNodeHandler>;
  services?: Record<string, unknown>;
  layers?: Layer.Layer<never, never, never> | Layer.Layer<never, never, never>[];
};

type ToonPluginNodeHandler = (
  node: any,
  env: ToonEnv,
  helpers: {
    compileNode: (node: any, env: ToonEnv) => BuilderNode;
    compileNodes: (nodes: any[], env: ToonEnv) => BuilderNode;
  },
) => BuilderNode;
```

**Complete working plugin example** (`tests/fixtures/toon-plugin.ts`):

```ts
import { Schema } from "effect";

export default (config: { suffix?: string } = {}) => ({
  name: "toon-test-plugin",
  nodes: {
    shout: (node: any, env: any) => {
      const id = String(node.id ?? "shout");
      const text = String(node.text ?? "");
      const suffix = typeof config.suffix === "string" ? config.suffix : "";
      return env.builder.step(id, {
        output: Schema.Struct({ value: Schema.String }),
        run: () => ({ value: `${text}${suffix}`.toUpperCase() }),
      });
    },
  },
});
```

Used in TOON via:

```toon
imports:
  plugins[1]:
    - from: ./toon-plugin.ts
      config:
        suffix: !
name: toon-plugin-workflow
input:
  name: string
steps[1]{kind,id,text}:
  shout,shout,hello
```

Note the **tabular-step form** at the bottom: `steps[1]{kind,id,text}:` with one CSV row `shout,shout,hello`. This works for any step kind whose required fields are flat strings.

`registerPluginHandles` (§10.13) is called automatically on the plugin handler's return value to register any newly-created step handles with the env so later steps can reference them as `needs`.

---

## 14. Real-World Examples (Full Fixtures)

### 14.1 `toon-basic.toon` — components and `run:` blocks

```toon
name: toon-basic
components:
  Wrap:
    params:
      value: string
    steps[1]:
      - id: "{id}-wrap"
        run: "return { wrapped: `<<${params.value}>>` };\n"
        output:
          wrapped: string
input:
  name: string
steps[2]:
  - id: greet
    run: "return { message: `Hello ${input.name}` };\n"
    output:
      message: string
  - id: wrap
    kind: component
    use: Wrap
    with:
      value: "{greet.message}"
```

Test: `execute({ name: "World" }) → { wrapped: "<<Hello World>>" }`.

### 14.2 `toon-prompt.toon` — imported agent + `prompt:`

```toon
imports:
  agents[1]{from,use}:
    ./toon-agent.ts,echo
name: toon-prompt
input:
  name: string
steps[1]:
  - id: greet
    agent: echo
    prompt: "Hello {input.name}\n"
    output:
      message: string
```

```ts
// toon-agent.ts
export const echo = {
  id: "echo",
  async generate({ prompt }: { prompt: string }) {
    return { text: JSON.stringify({ message: prompt }) };
  },
};
```

### 14.3 `toon-research-report.toon` — two-step research/report

```toon
imports:
  agents[1]{from,use}:
    ./toon-agent.ts,"researcher,writer"
name: research-report
input:
  topic: string
steps[2]:
  - id: research
    agent: researcher
    prompt: "Research the topic.\nTopic: {input.topic}\n"
    output:
      summary: string
      keyPoints: "string[]"
  - id: report
    agent: writer
    prompt: "Summary: {research.summary}\nKey points: {research.keyPoints}\n"
    output:
      title: string
      body: string
      wordCount: number
```

### 14.4 `toon-review-loop.toon` — loop with `skipIf`

```toon
name: review-loop
input:
  draft: string
steps[2]:
  - kind: loop
    id: review-cycle
    maxIterations: 3
    until: review.approved
    children[2]:
      - id: review
        run: "const approved = iteration >= 1;\nreturn { approved, notes: `round-${iteration}` };\n"
        output:
          approved: boolean
          notes: string
      - id: revise
        needs[1]: review
        skipIf: review.approved
        run: "return { content: `${input.draft} | ${review.notes}` };\n"
        output:
          content: string
  - id: finalize
    needs[1]: review
    run: "return {\n  approved: review.approved,\n  content: `${input.draft} | ${review.notes}`,\n};\n"
    output:
      approved: boolean
      content: string
```

### 14.5 `toon-components-workflow.toon` + `toon-components-lib.toon`

```toon
# toon-components-workflow.toon
imports:
  components[1]{from,use}:
    ./toon-components-lib.toon,Summarize
name: component-workflow
input:
  brief: string
steps[3]:
  - id: draft
    run: "return { content: `${input.brief} -- draft` };\n"
    output:
      content: string
  - id: synopsis
    kind: component
    use: Summarize
    with:
      text: "{draft.content}"
  - id: finalize
    needs[2]: synopsis_summary,synopsis_tags
    run: "return {\n  summary: synopsis_summary.summary,\n  tags: synopsis_tags.tags,\n};\n"
    output:
      summary: string
      tags: "string[]"
```

```toon
# toon-components-lib.toon
components:
  Summarize:
    params:
      text: string
    steps[2]:
      - id: "{id}_summary"
        run: "const trimmed = params.text.trim();\nreturn { summary: trimmed.slice(0, 40) };\n"
        output:
          summary: string
      - id: "{id}_tags"
        needs[1]: "{id}_summary"
        run: "const base = steps[`${id}_summary`].summary;\nconst words = base.split(/\\s+/).filter(Boolean);\nreturn { tags: words.slice(0, 2).map((w) => w.toLowerCase()) };\n"
        output:
          tags: "string[]"
```

Note `steps[\`${id}_summary\`].summary` — the run-block context exposes other steps under `steps[...]` keyed by their expanded id.

### 14.6 `toon-services.toon` + `toon-services.ts` — Effect service injection

```toon
imports:
  services[1]{from,use}:
    ./toon-services.ts,Greeter
name: toon-services
input:
  name: string
steps[1]:
  - id: greet
    run: "return Effect.gen(function* () {\n  const greeter = yield* Greeter;\n  const message = yield* greeter.greet(input.name);\n  return { message };\n});\n"
    output:
      message: string
```

```ts
// toon-services.ts
import { Context, Effect } from "effect";

export class Greeter extends Context.Tag("Greeter")<
  Greeter,
  { readonly greet: (name: string) => Effect.Effect<string> }
>() {}
```

### 14.7 `toon-workflow-import.toon` + `toon-subworkflow.toon`

```toon
# toon-workflow-import.toon
imports:
  workflows[1]{from,as}:
    ./toon-subworkflow.toon,research
name: toon-workflow-import
input:
  topic: string
steps[2]:
  - id: do_research
    kind: workflow
    use: research
    input:
      topic: "{input.topic}"
  - id: report
    needs[1]: do_research
    run: "return { report: `Report: ${do_research.summary}` };\n"
    output:
      report: string
```

```toon
# toon-subworkflow.toon
name: toon-subworkflow
input:
  topic: string
steps[1]:
  - id: research
    run: "return { summary: `Researching ${input.topic}` };\n"
    output:
      summary: string
```

### 14.8 `toon-cache.toon` — caching by key

```toon
name: toon-cache
input:
  key: string
steps[1]:
  - id: compute
    handler: ./toon-cache-handler.ts#compute
    output:
      count: number
      key: string
    cache:
      by[1]: input.key
      version: v1
```

```ts
// toon-cache-handler.ts
let counter = 0;
export function resetCounter() { counter = 0; }
export function getCounter() { return counter; }
export async function compute(ctx: { input: { key: string } }) {
  counter += 1;
  return { count: counter, key: ctx.input.key };
}
```

### 14.9 `toon-retry.toon` — flaky step with retries

```toon
name: toon-retry
input:
  name: string
steps[1]:
  - id: flaky
    run: "if (attempt < 3) {\n  throw new Error(\"flaky\");\n}\nreturn { ok: true };\n"
    output:
      ok: boolean
    retry:
      maxAttempts: 3
      backoff: fixed
      initialDelay: 30ms
```

### 14.10 `toon-expressions.toon` — JS expressions in `skipIf` and component params

```toon
name: toon-expressions
components:
  Labeler:
    params:
      text: string
    steps[1]:
      - id: "{id}-label"
        run: "return { label: params.text };\n"
        output:
          label: string
input:
  score: number
  tags: "string[]"
steps[3]:
  - id: compute
    run: "return { score: input.score, tags: input.tags };\n"
    output:
      score: number
      tags: "string[]"
  - id: skippable
    skipIf: "input.score > 7 ? true : false"
    run: "return { note: 'needs work' };\n"
    output:
      note: string
  - id: labeler
    kind: component
    use: Labeler
    with:
      text: "{input.score > 5 ? 'pass' : 'fail'}"
```

### 14.11 `parallel-research.toon` — parallel + components in two phases

```toon
name: parallel-research
agents:
  researcher:
    type: claude-code
    model: claude-opus-4-7
    subscription: true
    instructions: You are an expert research assistant.
  writer:
    type: claude-code
    model: claude-opus-4-7
    subscription: true
    instructions: You are a concise technical writer.

input:
  topic: string
  sources: "string[]"

components:
  Summarizer:
    params:
      content: string
      maxWords: number
      style: "bullet" | "prose"
    steps[1]:
      - id: "{id}-summarize"
        agent: writer
        prompt: "Summarize the following content in at most {params.maxWords} words.\nStyle: {params.style}\n\nContent:\n{params.content}"
        output:
          summary: string
          wordCount: number

steps[3]:
  - kind: parallel
    children[3]:
      - id: research-web
        agent: researcher
        prompt: "Search the web for recent information about: {input.topic}\nFocus on authoritative sources."
        output:
          findings: string
          sources: "string[]"
      - id: research-academic
        agent: researcher
        prompt: "Search academic papers about: {input.topic}\nFocus on peer-reviewed work."
        output:
          findings: string
          papers: "string[]"
      - id: research-community
        agent: researcher
        prompt: "Search developer communities about: {input.topic}\nFocus on practical experience."
        output:
          findings: string
          discussions: "string[]"

  - kind: parallel
    children[3]:
      - id: web-summary
        kind: component
        use: Summarizer
        with:
          content: "{research-web.findings}"
          maxWords: 200
          style: "bullet"
      - id: academic-summary
        kind: component
        use: Summarizer
        with:
          content: "{research-academic.findings}"
          maxWords: 200
          style: "bullet"
      - id: community-summary
        kind: component
        use: Summarizer
        with:
          content: "{research-community.findings}"
          maxWords: 200
          style: "bullet"

  - id: final-report
    agent: writer
    prompt: "Synthesize these summaries.\n\nWeb:\n{web-summary-summarize.summary}\n\nAcademic:\n{academic-summary-summarize.summary}\n\nCommunity:\n{community-summary-summarize.summary}"
    output:
      title: string
      report: string
      keyTakeaways: "string[]"
      totalSources: number
```

### 14.12 `review-and-publish.toon` — loop + approval + publish

```toon
name: review-and-publish
agents:
  writer:
    type: claude-code
    model: claude-opus-4-7
    subscription: true
    instructions: You are a technical writer.
  reviewer:
    type: claude-code
    model: claude-opus-4-7
    subscription: true
    instructions: You are a thorough technical reviewer.

input:
  topic: string
  targetAudience: string

steps[4]:
  - id: draft
    agent: writer
    prompt: "Write a technical article about {input.topic} for {input.targetAudience}.\n\nInclude: Introduction, Key concepts, Practical examples, Conclusion."
    output:
      title: string
      content: string

  - kind: loop
    id: review-cycle
    maxIterations: 3
    until: "{review.approved} == true"
    onMaxReached: return-last
    children[2]:
      - id: review
        agent: reviewer
        prompt: "Review.\n\nTitle: {draft.title}\nContent: {draft.content}\n\n{loop.iteration > 1 ? 'Previous feedback: ' + review.feedback + '\n' : ''}Respond with approval status."
        output:
          approved: boolean
          feedback: string
          score: number
      - id: revise
        agent: writer
        prompt: "Revise.\n\nOriginal: {draft.content}\nFeedback: {review.feedback}\nScore: {review.score}/10"
        output:
          title: string
          content: string
        skipIf: "{review.approved}"

  - kind: approval
    id: publish-gate
    request:
      title: "Publish '{draft.title}'?"
      summary: "Review score: {review.score}/10\nIterations: {loop.iteration}"
    onDeny: fail

  - id: publish
    needs[1]: publish-gate
    run: "return {\n  url: `https://blog.example.com/${draft.title.toLowerCase().replace(/ /g, '-')}`,\n  publishedAt: new Date().toISOString(),\n};"
    output:
      url: string
      publishedAt: string
```

### 14.13 `bugfix.toon` — schemas import + run + prompt mix

```toon
imports:
  schemas[1]{from,use}:
    ./schemas.ts,TicketInput

name: bugfix
agents:
  coder:
    type: claude-code
    model: claude-opus-4-7
    subscription: true
    instructions: You are a senior software engineer specializing in debugging.

input: TicketInput

steps[4]:
  - id: fetch-context
    run: "const response = await fetch(\n  `https://api.linear.app/tickets/${input.ticketId}`,\n  { headers: { Authorization: `Bearer ${process.env.LINEAR_API_KEY}` } }\n);\nconst data = await response.json();\nreturn {\n  title: data.title,\n  body: data.description,\n  labels: data.labels.map(l => l.name),\n};"
    output:
      title: string
      body: string
      labels: "string[]"

  - id: analyze
    agent: coder
    prompt: "Analyze the bug.\n\nTitle: {fetch-context.title}\nDescription: {fetch-context.body}\nLabels: {fetch-context.labels}\n\nOriginal report: {input.description}"
    output:
      rootCause: string
      affectedFiles: "string[]"
      severity: "low" | "medium" | "high"
      suggestedApproach: string

  - id: generate-fix
    agent: coder
    prompt: "Generate a code fix.\n\nRoot cause: {analyze.rootCause}\nAffected files: {analyze.affectedFiles}\nApproach: {analyze.suggestedApproach}"
    output:
      patch: string
      explanation: string
      testSuggestions: "string[]"

  - id: format-output
    run: "return { summary: `## ${fetch-context.title}\\n\\n**Severity:** ${analyze.severity}\\n\\n**Fix:**\\n${generate-fix.patch}`, filesChanged: analyze.affectedFiles.length };"
    output:
      summary: string
      filesChanged: number
```

```ts
// schemas.ts
import { Schema } from "effect";
export class TicketInput extends Schema.Class<TicketInput>("TicketInput")({
  ticketId: Schema.String,
  description: Schema.String,
}) {}
```

---

## 15. Test Coverage (What Was Verified)

The TOON implementation had end-to-end tests for every major feature. The behaviors below are what *must* hold for any replacement front-end (Lion or otherwise) targeting the same engine.

```ts
// tests/toon.test.ts (verbatim, abridged setup)

test("loadToon executes run steps and components", async () => {
  const workflow = Smithers.loadToon("tests/fixtures/toon-basic.toon");
  const result = await Effect.runPromise(
    workflow.execute({ name: "World" }).pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({ wrapped: "<<Hello World>>" });
});

test("loadToon executes prompt steps with imported agents", async () => {
  const workflow = Smithers.loadToon("tests/fixtures/toon-prompt.toon");
  const result = await Effect.runPromise(
    workflow.execute({ name: "Ada" }).pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({ message: expect.stringContaining("Hello Ada") });
});

test("loadToon executes quickstart-style research and report steps", async () => {
  const workflow = Smithers.loadToon("tests/fixtures/toon-research-report.toon");
  const result = await Effect.runPromise(
    workflow.execute({ topic: "Zig" }).pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({
    title: expect.stringContaining("Report"),
    body: expect.stringContaining("Zig"),
    wordCount: expect.any(Number),
  });
});

test("loadToon supports loop nodes with skipIf logic", async () => {
  const workflow = Smithers.loadToon("tests/fixtures/toon-review-loop.toon");
  const result = await Effect.runPromise(
    workflow.execute({ draft: "Draft v1" }).pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({ approved: true, content: expect.stringContaining("Draft v1") });
});

test("loadToon imports component libraries", async () => {
  const workflow = Smithers.loadToon("tests/fixtures/toon-components-workflow.toon");
  const result = await Effect.runPromise(
    workflow.execute({ brief: "Ship the hotfix" }).pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({
    summary: expect.stringContaining("Ship the hotfix"),
    tags: expect.arrayContaining(["ship", "the"]),
  });
});

test("loadToon imports Effect services for run blocks", async () => {
  const workflow = Smithers.loadToon("tests/fixtures/toon-services.toon");
  const result = await Effect.runPromise(
    workflow.execute({ name: "Sam" }).pipe(
      Effect.provide(Layer.mergeAll(
        Smithers.sqlite({ filename: dbPath }),
        Layer.succeed(Greeter, { greet: (name) => Effect.succeed(`Hello ${name}`) }),
      )),
    ),
  );
  expect(result).toEqual({ message: "Hello Sam" });
});

test("loadToon supports workflow imports", async () => {
  const workflow = Smithers.loadToon("tests/fixtures/toon-workflow-import.toon");
  const result = await Effect.runPromise(
    workflow.execute({ topic: "Bun" }).pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({ report: expect.stringContaining("Researching Bun") });
});

test("loadToon supports plugin-defined node kinds", async () => {
  const workflow = Smithers.loadToon("tests/fixtures/toon-plugin-workflow.toon");
  const result = await Effect.runPromise(
    workflow.execute({ name: "Ignored" }).pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({ value: "HELLO!" });
});

test("loadToon caches steps using cache.by and cache.version", async () => {
  resetCounter();
  const workflow = Smithers.loadToon("tests/fixtures/toon-cache.toon");
  const run = (key: string) => Effect.runPromise(
    workflow.execute({ key }).pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );

  const first  = await run("alpha"); expect(first).toEqual({ count: 1, key: "alpha" });   expect(getCounter()).toBe(1);
  const second = await run("alpha"); expect(second).toEqual({ count: 1, key: "alpha" });  expect(getCounter()).toBe(1);
  const third  = await run("beta");  expect(third).toEqual({ count: 2, key: "beta" });    expect(getCounter()).toBe(2);
});

test("loadToon respects retry backoff delays", async () => {
  const workflow = Smithers.loadToon("tests/fixtures/toon-retry.toon");
  const result = await Effect.runPromise(
    workflow.execute({ name: "Retry" }).pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(result).toEqual({ ok: true });
  // Verifies (via SQLite query of _smithers_attempts) that delays between
  // attempts >= configured initialDelay (30ms).
});

test("loadToon evaluates JS expressions in skipIf and component with", async () => {
  const workflow = Smithers.loadToon("tests/fixtures/toon-expressions.toon");

  // score=8 > 7 → skipIf evaluates true → skippable is skipped
  const highScore = await Effect.runPromise(
    workflow.execute({ score: 8, tags: ["fast", "clean"] }).pipe(Effect.provide(Smithers.sqlite({ filename: dbPath }))),
  );
  expect(highScore).toEqual({ label: "pass" });

  // score=3 ≤ 7 → skippable runs
  const lowScore = await Effect.runPromise(
    workflow.execute({ score: 3, tags: ["slow"] }).pipe(Effect.provide(Smithers.sqlite({ filename: dbPath2 }))),
  );
  expect(lowScore).toEqual({ label: "fail" });
});
```

These ten tests cover **everything Lion would also need to support**:

1. `run:` steps + components ✅
2. `prompt:` steps + imported agents ✅
3. Multi-step prompt+output chaining ✅
4. Loops with `skipIf` ✅
5. Cross-file component import ✅
6. Effect-service injection in `run:` blocks ✅
7. Sub-workflow invocation (`kind: workflow`) ✅
8. Plugin-defined node kinds ✅
9. Cache (`cache.by` + `cache.version`) ✅
10. Retry backoff delays ✅
11. JS-expression evaluation in `skipIf` and component `with` params ✅

---

## 16. Hints for the Lion-Language Designer

The TOON public surface was retired in March 2026 because Effect/JSX was simpler to maintain and offered better static typing. A homoiconic Lisp like Lion sidesteps many of TOON's specific pain points without losing TOON's strengths. Key design hints:

1. **Implicit deps from interpolation are the killer feature.** Users wrote `{research.summary}` and got a typed dependency edge for free. This is what made TOON pleasant. **Preserve this in some form.** In Lisp, references in any sub-expression (`(prompt ... (deref research summary))`) should drive automatic `needs:` edges. The dep collector in §10.3 (`collectDepsFromExpression`) is what to replace with proper AST walking.

2. **Inline string-DSL schemas were brittle.** TOON's `"a" | "b"`, `"string[]"`, `string?` mini-language exists only because TOON has no real type literals. A Lisp can express schemas as data: `(union "a" "b")`, `(array string)`, `(optional string)`, `(struct (name string) (age number))`. No quote-escaping wars. Map them to Effect `Schema` exactly as `parseSchemaType` does in §10.5.

3. **Tabular forms are a TOON hack.** `agents[2]{name,type,model,subscription}: ...` exists because TOON has no terse list-of-records syntax. A Lisp doesn't need them — `(agents (coder :type 'claude-code :model "...") (reviewer :type 'codex))` is already compact.

4. **Component `{id}-suffix` substitution is awkward.** It's a manual hygiene mechanism. Lisp macros can do hygienic gensym automatically. Consider: components emit *unprefixed* step ids internally and the call site references the *component instance id* — let the macro layer rewrite collisions.

5. **The expression sub-language was just JavaScript via `new Function`.** This was the worst part of TOON: untyped, unsafe, unrelated to the surrounding declarative format. A Lisp surface should make expressions *first-class Lion forms* (or first-class TS/Effect via interop), not strings to be `eval`'d. Replace `evaluateExpression` (§10.3) entirely.

6. **Named prompts (`prompts:` block) were added late as a workaround.** Tabular step rows can't carry multi-line prompts, so prompts had to be pulled out into a top-level map. A Lisp doesn't need a separate `prompts:` block — prompts are just string values, optionally bound with `let`/`define`.

7. **Auto-injected JSON-output instructions are load-bearing.** Every `prompt:` step automatically gets a "you MUST end with a JSON code fence matching this schema" tail (§10.8), and the response is JSON-extracted (§10.9). Preserve this. It's how Smithers gets typed outputs from text-only agents.

8. **One file ≈ one workflow, but composition is rich.** Imports cover schemas, services, components, sub-workflows, plugins, and agents. Whatever Lion designs, support modular composition along these six axes — and keep relative-path resolution to the importing file's directory.

9. **The compile target is the contract.** Anything Lion produces must reduce to `BuilderNode` (§11.1) using `BuilderApi` (§11.2). The translation is mechanical:

   | Lion form (sketch) | Maps to |
   | --- | --- |
   | `(workflow name :input I :steps S...)` | `createWorkflow({name, input: I}).build($ => ...)` |
   | `(parallel a b c)` | `$.parallel(a, b, c)` |
   | `(sequence a b)` | `$.sequence(a, b)` |
   | `(loop :until expr :max-iter 5 body)` | `$.loop({ until: ctx => expr, maxIterations: 5, children: body })` |
   | `(branch cond then else)` | `{ kind: "branch", condition: ctx => cond, then, else }` |
   | `(approval id :request {title summary} :on-deny 'fail)` | `$.approval(id, { request, onDeny })` |
   | `(step id :agent A :prompt P :output O)` | `$.step(id, { run: ctx => agent.generate({...}), output: O, needs: ... })` |
   | `(step id :run code :output O)` | `$.step(id, { run: ctx => code, output: O, needs: ... })` |

   Only the front-end (parser → `BuilderNode`) needs to change; everything below the line in §11 already works. **No engine changes required.**

10. **Reuse the same SQLite persistence.** §11.5 shows the per-step `<run_id, node_id, iteration> → payload` table layout. Lion-built workflows should reuse `createPayloadTable` so a single SQLite DB can hold runs from any front-end. This means runs are inspectable by the existing CLI commands (`smithers list/status/frames/graph/revert/cancel`).

11. **Plugins should keep working.** A plugin's `nodes:` map registers handlers keyed by `kind`. If Lion's surface form for `(kind/foo ...)` ultimately compiles via the same plugin handler, plugins are portable across surfaces. The `helpers` argument (`compileNode`, `compileNodes`) is what plugins use to recurse into their children — preserve that contract.

12. **Don't reinvent agents.** Imported agents are just objects with `.generate({prompt, abortSignal, timeout})`. If Lion lets users `(import-agent './agents.ts' coder reviewer)`, the rest of the agent ecosystem (Anthropic, Codex, Gemini, Pi, Kimi, Forge, custom) is reusable.

13. **Loop-in-loop is unsupported on purpose** (`TOON_NESTED_LOOP`). The engine only supports a single level of iteration tracking per execution. Either preserve this limitation or coordinate with the engine team if Lion wants to lift it.

14. **Approvals are durable suspend points.** They're not just a side-effect step — they cause the run to halt and persist, then resume on `smithers approve --run-id ... --node-id ...`. The compile path is: `kind: approval` → `$.approval(id, { request, onDeny })` → an `ApprovalDecision`-shaped output that downstream steps see.

15. **Naming.** `Smithers.loadToon(path)` was the public TS API. For Lion, mirror this: `Smithers.loadLion(path)` or similar, returning the same `BuiltSmithersWorkflow` shape with the same `.execute(input, opts)` Effect.

---

## Appendix A — File Inventory at `30246efad^`

| File | Role | Size |
| --- | --- | --- |
| `src/effect/builder.ts` | TOON parser + compiler + builder; all source in §10–§11 | ~2447 LOC |
| `src/cli/index.ts` | Detects `.toon` by extension, dispatches | ~700 LOC |
| `tests/toon.test.ts` | E2E tests covering every feature (verbatim in §15) | 212 LOC |
| `tests/fixtures/toon-*.toon` (15 files) | Self-contained example workflows | varies |
| `tests/fixtures/toon-agent.ts` | `AgentLike` test stubs | 50 LOC |
| `tests/fixtures/toon-services.ts` | Effect service test stub | 10 LOC |
| `tests/fixtures/toon-cache-handler.ts` | Cache test handler | 12 LOC |
| `tests/fixtures/toon-plugin.ts` | Plugin test fixture | 19 LOC |
| `docs/toon/{overview,quickstart,schemas,nodes,prompts,components,imports,inline-code,installation}.mdx` | User docs (8 files) | ~2000 LOC |
| `docs/reference/toon-spec.mdx` | Formal grammar | 393 LOC |
| `docs/examples/toon-{bugfix,hello,parallel,review-loop}.mdx` | Larger examples | ~370 LOC |

---

## Appendix B — Notable design quirks / known warts

1. **Component output references use expanded ids, not caller ids.** `tech-review.kind: component → use: ReviewCycle` produces steps `tech-review-review` and `tech-review-revise`; downstream code references `{tech-review-revise.content}`, not `{tech-review.content}`. The Lion surface should fix this.

2. **Component params are evaluated lazily but `{id}` is substituted at compile time.** Two different mechanisms for two different "templating" needs — easy to confuse.

3. **`kind: component` requires `id:` on the call (the instance id) but the *component definition* has no `name`-on-self knob — the name is its key in `components:`.**

4. **`needs:` accepts either an array (`needs[2]: a,b`) or a single string (`needs[1]: a` or `needs: a`).** A Lisp surface should pick one form.

5. **Hyphenated step ids work in interpolation but require bracket-rewriting** (see `evaluateExpression`): `{tech-review.x}` becomes `__ctx__["tech-review"].x`. A Lisp can sidestep this entirely by not using hyphens in symbol names, or by using proper symbol resolution.

6. **`run:` block uses `with (ctx) { ... }`.** This relies on the legacy `with` statement. It works but is non-standard. A Lion surface should bind context via destructuring or parameter passing.

7. **No comments in `.toon` files** — TOON has no comment syntax. Lion should support `;` comments natively.

8. **Tabular `agents[2]{name,type,model,subscription}: ...` is not symmetric with object form** for non-string values (e.g. `tools[]`, nested options). It only works for flat scalar fields.

9. **`maxIterations` defaults to 5.** Surprising for some users; `until` may never fire if outputs change slowly.

10. **`kind: workflow` sub-workflow output schema is `Schema.Unknown`** — i.e. the parent workflow can't statically know the sub-workflow's output shape. Lion could lift the sub-workflow's declared `name`/`output` into the type system at compile time.

End of document.
