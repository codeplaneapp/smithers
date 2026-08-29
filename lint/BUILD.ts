/**
 * First-wave LLM lint targets for the flows software factory.
 *
 * Each target reviews the paths a diff against `origin/main` touched, against
 * one rubric, through a cheap codex agent. `durableIdentityGuard` fails the
 * build; the two documentation lints report at `warning` while their rubrics
 * are tuned.
 */
import { Smithers } from "@smthrs/targets"

/** The base revision every first-wave lint diffs against. */
const changes = Smithers.gitDiff("origin/main")

/** The cheap fast codex tier the first wave runs on. */
const model = "gpt-5.6-luna"

/** Shared framing prepended to every rubric. */
const prompt = "You are reviewing a diff in `flows`, an Effect v4 coding-agent harness written from " +
  "scratch. Report only violations of the rubric below. Judgment calls that the rubric does not " +
  "cover are not findings. Prefer no finding over a speculative one."

/**
 * Guards identity strings, migrations, persisted schemas, and durable keys.
 *
 * @since 0.1.0
 * @category lint
 */
export const durableIdentityGuard = Smithers.LlmLint({
  changes,
  include: [
    Smithers.glob("//packages/engine-store/src/**"),
    Smithers.glob("//packages/run-store/src/**"),
    Smithers.glob("//packages/step-cache/src/**"),
    Smithers.glob("//packages/journal/src/**"),
    Smithers.glob("//packages/database/src/**"),
    Smithers.glob("//packages/engine-store/src/migrations/**"),
    Smithers.glob("//packages/run-store/src/migrations/**"),
    Smithers.glob("//packages/step-cache/src/migrations/**"),
    Smithers.glob("//packages/journal/src/migrations/**")
  ],
  deps: [],
  prompt,
  rubric: [
    "1. An identity string passed to `Action.make`, `Flow.make`, a service tag, or a",
    "   `Schema.TaggedError` tag must equal the defining module path. A tag that names a",
    "   different module, a moved module that kept its old tag, or a tag that no longer",
    "   matches the file it is defined in is an error.",
    "2. A rename must rename the identity everywhere and leave no backwards-compatible",
    "   alias, re-export, or fallback branch. A compat alias is an error.",
    "3. A change to a persisted schema, a table, or a stored column must add a NEW migration",
    "   file. Editing a migration that has already shipped is an error.",
    "4. A change to a durable key: a step key, a cache key, a run key, or the material any of",
    "   them hashes, is a replay and cache hazard. It is an error unless the diff carries an",
    "   explicit note saying so.",
    "Report the offending identity or key by name. Line 1 is fine for whole-file findings."
  ].join("\n"),
  engine: "codex",
  model,
  batchSize: 2,
  failOn: "error"
})

/**
 * Checks hand-written reference and concept documentation against public APIs.
 *
 * @since 0.1.0
 * @category lint
 */
export const docsReferenceSync = Smithers.LlmLint({
  changes,
  include: [Smithers.glob("//packages/*/src/**")],
  context: [
    Smithers.glob("//docs/reference/*.md"),
    Smithers.glob("//docs/concepts/**/*.md"),
    Smithers.glob("//docs/guides/**/*.md")
  ],
  deps: [],
  prompt,
  rubric: [
    "The context files are the hand-written package reference, concept, and guide pages.",
    "They did not change in this diff. Compare them against the changed source.",
    "1. A public export whose reference page still describes removed, renamed, or changed",
    "   behavior is a warning against the reference page.",
    "2. A new public export absent from its package's reference page is a warning against the",
    "   reference page.",
    "3. A concept page contradicted by the change is a warning against the concept page.",
    "Name the stale documentation page in `file`. Do not report a source file for these.",
    "Private helpers, tests, and internal modules are out of scope."
  ].join("\n"),
  engine: "codex",
  model,
  batchSize: 3,
  failOn: "warning"
})

/**
 * Checks whether changed exported implementations still match their JSDoc.
 *
 * @since 0.1.0
 * @category lint
 */
export const jsdocTruthfulness = Smithers.LlmLint({
  changes,
  include: [Smithers.glob("//packages/*/src/**/*.ts")],
  deps: [],
  prompt,
  rubric: [
    "For each export whose body changed in this diff:",
    "1. The JSDoc prose must still describe what the code does. Prose that describes the old",
    "   behavior is a warning.",
    "2. The documented error channel must match the actual `Schema.TaggedError` union the",
    "   code can fail with. A documented error the code cannot raise, or a raised error the",
    "   doc never mentions, is a warning.",
    "3. A documented default must match the default in the code.",
    "4. `@since` on a NEW export must be the current unreleased version, not a value",
    "   copy-pasted from a neighboring export.",
    "Report against the source file and the line of the JSDoc block. Presence of JSDoc is",
    "already gated by eslint; only truthfulness is in scope."
  ].join("\n"),
  engine: "codex",
  model,
  batchSize: 3,
  failOn: "warning"
})
