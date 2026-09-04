import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Option from "effect/Option"
import { fileURLToPath } from "node:url"
import type * as Route from "../src/Route.ts"

export const visibleModule = fileURLToPath(new URL("./fixtures/command/visible.ts", import.meta.url))
export const specialModule = fileURLToPath(new URL("./fixtures/command/special%23flow.ts", import.meta.url))
export const invalidModule = fileURLToPath(new URL("./fixtures/command/invalid.ts", import.meta.url))
export const recordedModule = fileURLToPath(new URL("./fixtures/command/recorded.ts", import.meta.url))
export const refinedModule = fileURLToPath(new URL("./fixtures/command/refined.ts", import.meta.url))

/** How many times the import-recording fixture has been evaluated. */
export const recordedImports = (): number => (globalThis as { fsRecordedImports?: number }).fsRecordedImports ?? 0

export const makeRoute = (
  name: string,
  sourcePath = visibleModule,
  overrides: Partial<Route.Route> = {}
): Route.Route => ({
  name,
  segments: name.split("/"),
  kind: "module",
  sourcePath,
  description: Option.some(`${name} description`),
  input: new Descriptor.SchemaRefModule({ path: sourcePath, field: "input" }),
  output: new Descriptor.SchemaRefModule({ path: sourcePath, field: "output" }),
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  modelInvocable: true,
  placement: Option.none(),
  ui: Option.none(),
  ...overrides
})
