/**
 * Partitions a scan into ordered migration units.
 *
 * A unit is one checkpoint, one agent frame, and one verification. Keeping
 * them small is what makes a failure recoverable: the tool restores the unit's
 * checkpoint, marks it failed, and carries on with the next one, so a project
 * never ends up half rewritten with no way back.
 *
 * The order is fixed. Dependencies first, so the new packages are installed
 * beside the old ones and every later unit can import them. Then one unit per
 * workflow, with each shared component or library attached to the first
 * workflow that needs it. Then one unit per integration. Then the project unit,
 * which removes the old packages, the JSX settings, and the old CLI scripts
 * once nothing depends on them.
 *
 * @since 0.1.0
 */
import type { Detection, SpecifierContext } from "./Detect.ts"
import { localPackageName } from "./Detect.ts"
import * as Sort from "./internal/Sort.ts"
import type { InventoryEntry } from "./Inventory.ts"
import * as Mapping from "./Mapping.ts"
import type { PromptHint } from "./PromptHints.ts"
import type { ZodHint } from "./ZodSchemaHints.ts"

/**
 * What a unit migrates.
 *
 * @category models
 * @since 0.1.0
 */
export type UnitKind = "dependencies" | "workflow" | "integration" | "project"

/**
 * The commands that verify one unit.
 *
 * @category models
 * @since 0.1.0
 */
export interface VerifyCommands {
  readonly install: string | undefined
  readonly format: string | undefined
  readonly typecheck: ReadonlyArray<string>
  readonly test: string | undefined
  readonly discovery: { readonly flowsDir: string }
}

/**
 * Something the plan itself could not settle, in the shape the report's
 * `unresolved` table takes.
 *
 * @category models
 * @since 0.1.0
 */
export interface UnitNote {
  readonly construct: string
  readonly reason: string
  readonly file: string
  readonly line: number
  readonly suggestion: string
}

/**
 * One migration unit.
 *
 * @category models
 * @since 0.1.0
 */
export interface UnitPlan {
  readonly id: string
  readonly kind: UnitKind
  readonly sources: ReadonlyArray<string>
  readonly targets: ReadonlyArray<string>
  readonly constructs: ReadonlyArray<InventoryEntry>
  readonly mapping: ReadonlyArray<Mapping.MappingRow>
  readonly hints: { readonly zod: ReadonlyArray<ZodHint>; readonly prompt: ReadonlyArray<PromptHint> }
  /** Distinct constructs in this unit that have no safe automatic translation. */
  readonly unsafe: ReadonlyArray<string>
  /** What planning this unit could not settle. Reaches the report unresolved. */
  readonly notes: ReadonlyArray<UnitNote>
  /**
   * What the project's manifests said about the names that exist in both
   * trees, so a check can tell an old import from a new one.
   */
  readonly specifiers: SpecifierContext
  readonly verification: VerifyCommands
}

/**
 * What {@link plan} reads. A `ScanResult` satisfies it.
 *
 * @category models
 * @since 0.1.0
 */
export interface PlanInput {
  readonly detection: Detection
  readonly inventory: ReadonlyArray<InventoryEntry>
  readonly hints: { readonly zod: ReadonlyArray<ZodHint>; readonly prompt: ReadonlyArray<PromptHint> }
}

/**
 * Command overrides, from the CLI.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommandOverrides {
  readonly install?: string | undefined
  readonly format?: string | undefined
  readonly typecheck?: ReadonlyArray<string> | undefined
  readonly test?: string | undefined
}

/**
 * Options for {@link plan}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly flowsDir?: string | undefined
  readonly commands?: CommandOverrides | undefined
  /** Restrict the plan to these unit ids. */
  readonly units?: ReadonlyArray<string> | undefined
}

const installByManager: ReadonlyArray<[string, string]> = [
  ["bun", "bun install"],
  ["pnpm", "pnpm install"],
  ["yarn", "yarn install"],
  ["npm", "npm install"]
]

const installByLockfile: ReadonlyArray<[string, string]> = [
  ["bun.lock", "bun install"],
  ["bun.lockb", "bun install"],
  ["pnpm-lock.yaml", "pnpm install"],
  ["yarn.lock", "yarn install"],
  ["package-lock.json", "npm install"]
]

const runner = (install: string | undefined): string => {
  if (install === undefined) return "npm run"
  if (install.startsWith("bun")) return "bun run"
  if (install.startsWith("pnpm")) return "pnpm run"
  if (install.startsWith("yarn")) return "yarn"
  return "npm run"
}

/**
 * Derives the commands that verify a migrated project: install from the
 * lockfile, format from the formatter the project already configures,
 * typecheck once per `tsconfig.json`, and test from `smithers.config.ts`
 * `repoCommands.test` or the root `package.json` test script.
 *
 * Every one of them is overridable, because the tool must never invent a
 * command that runs the operator's code.
 *
 * @category combinators
 * @since 0.1.0
 */
export const verifyCommands = (
  detection: Detection,
  overrides: CommandOverrides = {},
  flowsDir = "flows"
): VerifyCommands => {
  const lockfiles = new Set(detection.lockfiles.map((file) => file.split("/").pop() ?? file))
  const byLock = installByLockfile.find(([name]) => lockfiles.has(name))?.[1]
  const declared = detection.packageManager
  const byManager = declared === undefined
    ? undefined
    : installByManager.find(([name]) => declared.startsWith(name))?.[1]
  const install = overrides.install ?? byManager ?? byLock

  const hasDprint = detection.files.some((file) => file.endsWith("dprint.json"))
  const hasPrettier = detection.files.some((file) => /(^|\/)\.?prettierrc([^/]*)$/.test(file)) ||
    detection.manifests.some((manifest) => manifest.path === "package.json" && manifest.name === "prettier")
  const format = overrides.format ?? (hasDprint ? "dprint fmt" : hasPrettier ? "prettier --write ." : undefined)

  const typecheck = overrides.typecheck ??
    detection.tsconfigs
      .map((entry) => entry.path)
      .filter((path) => !path.includes("tsconfig.test.json"))
      .sort(Sort.byText)
      .map((path) => `tsc --noEmit -p ${path}`)

  const scriptTest = detection.manifests.find((manifest) => manifest.kind === "root")?.scripts.find((script) =>
    script.name === "test"
  )
  const test = overrides.test ??
    detection.config.smithersConfig?.repoCommands.get("test") ??
    (scriptTest === undefined ? undefined : `${runner(install)} test`)

  return { install, format, typecheck, test, discovery: { flowsDir } }
}

/**
 * The flow name a workflow file becomes, in registry path naming.
 *
 * A file under `.smithers/workflows/` keeps its position, so
 * `.smithers/workflows/pipelines/ci-fast.tsx` becomes `pipelines/ci-fast` and
 * lands at `flows/pipelines/ci-fast/flow.ts`. Anything else uses its basename.
 *
 * @category combinators
 * @since 0.1.0
 */
export const flowName = (path: string): string => {
  const match = /(?:^|\/)\.smithers\/workflows\/(.+)$/.exec(path)
  const relative = match?.[1] ?? path.split("/").pop() ?? path
  return relative.replace(/\.[^./]+$/, "")
}

/**
 * What the manifests decided about the specifiers that exist in both trees.
 *
 * Design 3.2 gates the import rules on 3.1: the bare name `smithers` and every
 * `@smthrs/<name>` that survived into 1.0 are old only where a manifest said
 * so, and a check that runs after the transform has to be told the same thing
 * the scan was.
 *
 * @category combinators
 * @since 0.1.0
 */
export const specifierContext = (detection: Detection): SpecifierContext => ({
  localFacade: detection.manifests.some((manifest) =>
    manifest.oldPackages.some((entry) => entry.name === localPackageName)
  ),
  oldScoped: [
    ...new Set(
      detection.manifests.flatMap((manifest) =>
        manifest.oldPackages
          .filter((entry) => entry.name.startsWith("@smthrs/"))
          .map((entry) => entry.name.slice("@smthrs/".length))
      )
    )
  ].sort(Sort.byText)
})

/**
 * Orders workflow files so a workflow another one imports is migrated first.
 *
 * Design 5.2 asks for dependency order, not path order: a pack whose
 * `a-first.tsx` imports `./z-last.tsx` has to migrate `z-last` first, or the
 * unit that rewrites `a-first` has nothing to point its child-flow reference
 * at. The sort is a depth-first topological walk with a lexical tie-break, so
 * two independent workflows always come out in the same order, and a cycle
 * falls back to the lexical order of the files in it.
 *
 * @category combinators
 * @since 0.1.0
 */
export const orderWorkflows = <A extends { readonly path: string }>(
  workflows: ReadonlyArray<A>,
  imports: ReadonlyArray<{ readonly file: string; readonly specifier: string; readonly kind: string }>
): { readonly ordered: ReadonlyArray<A>; readonly cycles: ReadonlyArray<ReadonlyArray<string>> } => {
  const sorted = [...workflows].sort(Sort.by((entry: { path: string }) => entry.path))
  const byPath = new Map(sorted.map((entry) => [entry.path, entry]))
  const dependencies = new Map<string, Array<string>>()
  for (const entry of sorted) dependencies.set(entry.path, [])
  for (const hit of imports) {
    if (hit.kind !== "relative") continue
    const list = dependencies.get(hit.file)
    if (list === undefined || !byPath.has(hit.specifier) || hit.specifier === hit.file) continue
    if (!list.includes(hit.specifier)) list.push(hit.specifier)
  }

  const ordered: Array<A> = []
  const done = new Set<string>()
  const stack: Array<string> = []
  const cycles: Array<ReadonlyArray<string>> = []
  const visit = (path: string): void => {
    if (done.has(path)) return
    if (stack.includes(path)) {
      cycles.push([...stack.slice(stack.indexOf(path)), path])
      return
    }
    stack.push(path)
    for (const next of [...(dependencies.get(path) ?? [])].sort(Sort.byText)) visit(next)
    stack.pop()
    if (done.has(path)) return
    done.add(path)
    const entry = byPath.get(path)
    if (entry !== undefined) ordered.push(entry)
  }
  for (const entry of sorted) visit(entry.path)
  return { ordered, cycles }
}

const unsafeConstructs = (hits: ReadonlyArray<InventoryEntry>): ReadonlyArray<string> =>
  [...new Set(hits.filter((hit) => Mapping.classify(hit) === "unsafe").map((hit) => hit.construct))].sort(Sort.byText)

const mappingRows = (hits: ReadonlyArray<InventoryEntry>): ReadonlyArray<Mapping.MappingRow> => {
  const rows = new Map<string, Mapping.MappingRow>()
  for (const hit of hits) {
    const row = Mapping.byConstruct(hit.construct)
    if (row !== undefined) rows.set(row.construct, row)
  }
  return [...rows.values()].sort(Sort.by((row: Mapping.MappingRow) => row.construct))
}

/**
 * Plans the migration.
 *
 * @category combinators
 * @since 0.1.0
 */
export const plan = (input: PlanInput, options: Options = {}): ReadonlyArray<UnitPlan> => {
  const flowsDir = options.flowsDir ?? "flows"
  const verification = verifyCommands(input.detection, options.commands ?? {}, flowsDir)
  const specifiers = specifierContext(input.detection)
  const byFile = new Map<string, Array<InventoryEntry>>()
  for (const hit of input.inventory) {
    const list = byFile.get(hit.file) ?? []
    list.push(hit)
    byFile.set(hit.file, list)
  }
  const zodByFile = new Map<string, Array<ZodHint>>()
  for (const hint of input.hints.zod) {
    const list = zodByFile.get(hint.file) ?? []
    list.push(hint)
    zodByFile.set(hint.file, list)
  }
  const promptByFile = new Map(input.hints.prompt.map((hint) => [hint.file, hint]))

  const units: Array<UnitPlan> = []

  const manifests = input.detection.manifests.filter((manifest) => manifest.oldPackages.length > 0)
  units.push({
    id: "dependencies",
    kind: "dependencies",
    sources: manifests.map((manifest) => manifest.path).sort(Sort.byText),
    targets: manifests.map((manifest) => manifest.path).sort(Sort.byText),
    constructs: [],
    mapping: [Mapping.byConstruct("package.json")!],
    hints: { zod: [], prompt: [] },
    unsafe: [],
    notes: [],
    specifiers,
    verification
  })

  // Shared components and libraries attach to the first workflow that imports
  // them, so no file is migrated twice and nothing is migrated by a unit that
  // does not know what it is for.
  const claimed = new Set<string>()
  const shared = new Set([...input.detection.components, ...input.detection.libs])
  // A file already written against Smithers 1.0 gets no unit. It has nothing
  // to migrate, and planning one would hand the agent its own output and write
  // the result to a second path named after `flow.ts`. Running the tool twice
  // has to be safe: the second run reports the file as already migrated and
  // leaves it where it is.
  const { cycles, ordered: workflows } = orderWorkflows(
    input.detection.workflowFiles.filter((workflow) => workflow.api !== "flows"),
    input.detection.imports
  )
  // A cycle is broken lexically so the plan stays deterministic, and the
  // operator is told which order the tool had to choose for itself.
  const cycleNotes = (path: string): ReadonlyArray<UnitNote> =>
    cycles
      .filter((cycle) => cycle.includes(path))
      .map((cycle) => ({
        construct: "workflow import cycle",
        reason: `${cycle.join(" -> ")} import each other, so no dependency order exists`,
        file: path,
        line: 1,
        suggestion: "migrate these workflows together, or break the cycle before running apply"
      }))

  const reachable = (from: string, depth: number): ReadonlyArray<string> => {
    if (depth === 0) return []
    const direct = input.detection.imports
      .filter((hit) => hit.file === from && (hit.kind === "relative" || hit.kind === "mdx"))
      .map((hit) => hit.specifier)
    return [...direct, ...direct.flatMap((next) => reachable(next, depth - 1))]
  }

  for (const workflow of workflows) {
    const attached = [...new Set(reachable(workflow.path, 8))]
      .filter((file) => shared.has(file) && !claimed.has(file))
      .sort(Sort.byText)
    for (const file of attached) claimed.add(file)
    // A prompt is claimed like a component: two workflows can import the same
    // `.mdx`, and migrating it twice would give one prompt two homes.
    const prompts = [...new Set(reachable(workflow.path, 8))]
      .filter((file) => promptByFile.has(file) && !claimed.has(file))
      .sort(Sort.byText)
    for (const file of prompts) claimed.add(file)
    const sources = [workflow.path, ...attached, ...prompts]
    const constructs = sources.flatMap((file) => byFile.get(file) ?? [])
    const name = flowName(workflow.path)
    units.push({
      id: `workflow:${name}`,
      kind: "workflow",
      sources,
      targets: [`${flowsDir}/${name}/flow.ts`],
      constructs,
      mapping: mappingRows(constructs),
      hints: {
        zod: sources.flatMap((file) => zodByFile.get(file) ?? []),
        prompt: prompts.flatMap((file) => {
          const hint = promptByFile.get(file)
          return hint === undefined ? [] : [hint]
        })
      },
      unsafe: unsafeConstructs(constructs),
      notes: cycleNotes(workflow.path),
      specifiers,
      verification
    })
  }

  const integrations = [...new Set(input.detection.integrations.map((hit) => hit.integration))].sort(Sort.byText)
  for (const integration of integrations) {
    const sources = [
      ...new Set(input.detection.integrations.filter((hit) => hit.integration === integration).map((hit) => hit.file))
    ]
      .sort(Sort.byText)
    const constructs = sources.flatMap((file) => byFile.get(file) ?? [])
    units.push({
      id: `integration:${integration}`,
      kind: "integration",
      sources,
      targets: [],
      constructs,
      mapping: mappingRows(constructs),
      hints: { zod: [], prompt: [] },
      unsafe: unsafeConstructs(constructs),
      notes: [],
      specifiers,
      verification
    })
  }

  const projectSources = [
    ...input.detection.manifests.map((manifest) => manifest.path),
    ...input.detection.tsconfigs.map((entry) => entry.path),
    ...input.detection.config.preload.map((entry) => entry.path),
    ...input.detection.config.bunfig.map((entry) => entry.path),
    ...input.detection.config.gateway,
    ...input.detection.config.agents,
    ...(input.detection.config.smithersConfig === undefined ? [] : [input.detection.config.smithersConfig.path]),
    ...input.detection.config.assetTypes,
    ...new Set(input.detection.scripts.map((hit) => hit.file))
  ]
  units.push({
    id: "project",
    kind: "project",
    sources: [...new Set(projectSources)].sort(Sort.byText),
    targets: [`${flowsDir}/seats.ts`],
    constructs: [],
    mapping: [
      Mapping.byConstruct("package.json")!,
      Mapping.byConstruct("tsconfig.json")!,
      Mapping.byConstruct("smithers.config.ts")!,
      Mapping.byConstruct("docs")!
    ],
    hints: { zod: [], prompt: [] },
    unsafe: [],
    notes: [],
    specifiers,
    verification
  })

  return options.units === undefined ? units : units.filter((unit) => options.units!.includes(unit.id))
}
