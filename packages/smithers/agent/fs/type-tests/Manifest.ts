import type { Effect } from "effect"
import type * as Command from "../src/Command.ts"
import type * as FlowInvoker from "../src/FlowInvoker.ts"
import type { FsError } from "../src/FsError.ts"
import type * as Route from "../src/Route.ts"

declare module "../src/Route.ts" {
  interface Manifest {
    readonly "typed/scalar": { readonly input: number; readonly output: number }
    readonly "typed/review": {
      readonly input: { readonly title: string }
      readonly output: { readonly accepted: boolean }
    }
  }
}

declare const surface: Command.CommandSurface

surface.call("typed/review", { title: "review" })
const input: Route.Input<"typed/review"> = { title: "review" }
const output: Route.Output<"typed/review"> = { accepted: true }
void input
void output

// @ts-expect-error unknown route names are rejected once a manifest is installed
surface.call("typed/typo", { title: "review" })
// @ts-expect-error route-specific input is checked
surface.call("typed/review", { title: 1 })

const scalar: Effect.Effect<number, FsError, FlowInvoker.FlowInvoker> = surface.call("typed/scalar", 42)
void scalar
// @ts-expect-error encoded strings are not decoded numeric input
surface.call("typed/scalar", "42")
