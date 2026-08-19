/** @jsxImportSource smthrs */
/*
 * REPRO: a <Task> that declares `deps` is silently dropped from the rendered graph.
 *
 *   bunx smthrs graph .repros/task-deps-drops-node.tsx | grep -o "id: [a-z-]*" | sort -u
 *
 * Observed: only `id: one` (and the workflow/sequence). The `triage` node is absent —
 * no error, no warning, no failed render. Downstream nodes that `dependsOn: ["triage"]`
 * are left depending on a node that does not exist.
 *
 * Expected: both `one` and `triage` render, and `triage` receives the `a` dependency.
 *
 * Remove the `deps={{ a: outputs.a }}` prop and `triage` renders. The function child is
 * not the cause: a compute Task with a function child and no `deps` renders fine.
 *
 * Found while authoring a workflow whose aggregate node collected results from a
 * Parallel of lanes. The workflow ran, the aggregate silently never existed, and the
 * loop condition it fed could never go true.
 */
import { Sequence, Task, createSmithers } from "smthrs"
import { z } from "zod"

const { Workflow, smithers, outputs } = createSmithers({
  a: z.object({ n: z.number() }),
  t: z.object({ m: z.number() }),
})

export default smithers(() => (
  <Workflow name="task-deps-drops-node">
    <Sequence>
      <Task id="one" output={outputs.a}>{{ n: 1 }}</Task>
      <Task id="triage" output={outputs.t} dependsOn={["one"]} deps={{ a: outputs.a }}>
        {(d: any) => ({ m: Object.keys(d).length })}
      </Task>
    </Sequence>
  </Workflow>
))
