/**
 * Graph fixtures shared by the plan suites.
 *
 * These live outside a `*.test.ts` file on purpose. `PlanStore.test.ts` used to
 * import `compile` and `draft` from `Plan.test.ts`, and importing a test module
 * REGISTERS ITS SUITES in the importer: every case in `Plan.test.ts` ran a
 * second time under `PlanStore.test.ts`, including the 10,000-node chain, which
 * is the most expensive case in the package. CI reported it as
 * `PlanStore.test.ts > Plan.compile > compiles a 10,000-node Ref chain` and it
 * timed out there, on a slower runner, for work `PlanStore` never asked for.
 */
import * as KeyMaterial from "../src/KeyMaterial.ts"
import * as Plan from "../src/Plan.ts"

export const effects = (
  reads: ReadonlyArray<string>,
  writes: ReadonlyArray<string>
): Plan.NodeEffects => ({ reads, writes, boundaryMode: "hard" })

export const draft = (
  id: string,
  options: {
    readonly body?: unknown
    readonly inputs?: ReadonlyArray<KeyMaterial.InputRef>
    readonly reads?: ReadonlyArray<string>
    readonly writes?: ReadonlyArray<string>
    readonly removes?: ReadonlyArray<string>
  } & Omit<Plan.NodeDraft, "id" | "material" | "effects"> = {}
): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: options.body ?? { action: id },
    inputs: options.inputs ?? [],
    layers: [],
    capabilities: []
  },
  effects: {
    ...effects(options.reads ?? [], options.writes ?? []),
    ...(options.removes === undefined ? {} : { removes: options.removes })
  },
  ...(options.kind === undefined ? {} : { kind: options.kind }),
  ...(options.priority === undefined ? {} : { priority: options.priority }),
  ...(options.conflictStrategy === undefined ? {} : { conflictStrategy: options.conflictStrategy }),
  ...(options.runtimeStrategy === undefined ? {} : { runtimeStrategy: options.runtimeStrategy })
})

export const compile = (nodes: ReadonlyArray<Plan.NodeDraft>, planId = "plan-1") =>
  Plan.compile({ planId, flow: "example/Build", nodes })
