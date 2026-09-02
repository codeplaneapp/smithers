import type * as Command from "../src/Command.ts"
import type * as Route from "../src/Route.ts"

declare module "../src/Route.ts" {
  interface Manifest {
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
