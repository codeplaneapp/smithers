/**
 * The release gate, as a project declares it on disk.
 *
 * `16-fan-out-fan-in.ts` names its gate in code. A project names it here, in
 * `flows/<name>/flow.ts`, and the name is the directory: `gate`. Discovery
 * reads this file's metadata without evaluating it, so what an operator sees in
 * `smthrs ls` costs one file read.
 *
 * Two fields carry the decisions the runtime acts on.
 *
 * `flows` names what the descriptor delegates to. A discovered flow says WHAT
 * should run; the host says HOW, by registering a `@smthrs/flow` flow under
 * that name. `examples/GateRunner` is that registration.
 *
 * `Annotations.Priority` is the same annotation `Node.priority` writes inside a
 * body, which is the point: priority is a property of a declaration, and it
 * does not matter whether the declaration was typed into a flow body or found
 * in a file. Markdown frontmatter has no spelling for it, so a gate that wants
 * to be scheduled ahead of ordinary work is a module flow.
 */
import { Annotations, Flow } from "@smthrs/core"
import { Schema } from "effect"

/** The discovered descriptor: the gate's declaration, delegate, and priority. */
export default Flow.make({
  description: "Runs the release gate's checks, urgent ones first.",
  input: Schema.Struct({ target: Schema.String }),
  output: Schema.String,
  flows: ["examples/GateRunner"],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }
}).pipe(Flow.annotate(Annotations.Priority, 7))
