import { readFileSync } from "node:fs"

/**
 * The two SWE-bench wave-10 model replies that carried more than one cell block.
 *
 * Each file is the verbatim `control.agent.model-settled` text of one recorded
 * settlement, lifted from that instance's journal at
 * `evals/swebench/work/<instance>/.flows/engine.db`, and named for the journal
 * sequence of the event that carried it. They are the whole population of
 * multi-block replies in that wave — 2 of 91 — and they are the two shapes the
 * concatenating extraction has to get right:
 *
 * - `django-16612-seq12` is a near-par program written as seven blocks: recon,
 *   probe, edit-plus-diagnostics-plus-reprobe, suite-plus-diff, state
 *   rehydration, guarded replay, completion. Five of the seven open with
 *   `const st = ctx.state`, so as one program it is a redeclaration the
 *   compiler names — a durable observation the next frame can act on. The
 *   harness of the day ran block seven alone, against a tree where blocks one
 *   through six had never run, and shipped an empty patch.
 * - `astropy-8707-seq77` is one state-echo block emitted twice, byte for byte.
 *   De-duplication is what keeps it a frame that runs.
 *
 * @since 0.1.0
 */
export const batchedReplyNames = [
  "astropy-8707-seq77",
  "django-16612-seq12"
] as const

/**
 * One recorded reply, as the model wrote it.
 */
export const batchedReply = (name: typeof batchedReplyNames[number]): string =>
  readFileSync(new URL(`./batched-replies/${name}.md`, import.meta.url), "utf8")
