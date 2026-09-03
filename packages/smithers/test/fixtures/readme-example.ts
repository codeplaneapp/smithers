/**
 * The README's TypeScript example, verbatim.
 *
 * `Readme.test.ts` asserts this file and the README's `ts` block hold the same
 * source, and `tsconfig.test.json` includes it, so the package typecheck is
 * what proves the published example compiles. The README example had already
 * drifted once: it called `NodeControl.makeConfig` with one argument after the
 * signature grew the environment and working directory, and nothing was
 * reading it.
 *
 * Edit the README block and this file together.
 */
import { Command, NodeControl, Version } from "@smthrs/cli"
import { Effect } from "effect"
import { Command as Cli } from "effect/unstable/cli"

const config = NodeControl.makeConfig(
  ["--remote", "http://127.0.0.1:3000", "--credential", "alpha-secret"],
  process.env,
  process.cwd()
)

const main = Cli.run(Command.cli, { version: Version.packageVersion }).pipe(
  Effect.provide(NodeControl.layer(config))
)

export { main }
