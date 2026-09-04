/**
 * The `smithers-migrate` command: its flags, its handler, and the program the
 * executable runs.
 *
 * It exists because the tool has to run inside a project that does not have
 * Smithers 1.0 yet: `npx @smthrs/migrate` is the first command an operator
 * types, before `@smthrs/cli` is anywhere near the tree. Once the project is
 * migrated the same flow is reachable as `smithers migrate` and as a durable
 * `smthrs plan migrate` / `approve` / `run`.
 *
 * The default mode is `plan`. Editing is never the default: `--apply` is a
 * thing the operator types after reading `report.md`.
 *
 * The command lives here and not in `bin.ts` so a test can run it in process
 * with an argument list: `bin.ts` is the three lines that hand {@link main} to
 * the Node runtime when the module is evaluated, which is exactly the side
 * effect a test must not import.
 *
 * @since 1.0.0-rc.0
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { Command, Flag } from "effect/unstable/cli"
import type { MigrateError } from "../MigrateError.ts"
import * as CommandModule from "./Command.ts"

const optional = <A>(value: { readonly _tag: "Some"; readonly value: A } | { readonly _tag: "None" }): A | undefined =>
  value._tag === "Some" ? value.value : undefined

const flags = {
  root: Flag.string("root").pipe(Flag.optional),
  scan: Flag.boolean("scan"),
  apply: Flag.boolean("apply"),
  seat: Flag.string("seat").pipe(Flag.optional),
  allowUnsafe: Flag.string("allow-unsafe").pipe(Flag.optional),
  acknowledgeRunState: Flag.boolean("acknowledge-run-state"),
  allowNoVcs: Flag.boolean("allow-no-vcs"),
  keepOldSources: Flag.boolean("keep-old-sources"),
  unit: Flag.string("unit").pipe(Flag.optional),
  maxRepairRounds: Flag.integer("max-repair-rounds").pipe(Flag.optional),
  reportDir: Flag.string("report-dir").pipe(Flag.optional),
  flowsDir: Flag.string("flows-dir").pipe(Flag.optional),
  // What the project really runs to verify itself. The detection ladder reads
  // the manifests and the lockfile and is right about most projects; these are
  // for the rest. They matter more than a convenience: the agent's shell is
  // confined to these exact command lines, so a wrongly derived command is one
  // an operator has no other way to correct.
  verifyInstall: Flag.string("verify-install").pipe(
    Flag.withDescription("The command that installs dependencies, instead of the one the lockfile implies"),
    Flag.optional
  ),
  verifyFormat: Flag.string("verify-format").pipe(
    Flag.withDescription("The command that formats the project, instead of the one its config implies"),
    Flag.optional
  ),
  verifyTypecheck: Flag.string("verify-typecheck").pipe(
    Flag.withDescription(
      "The command that typechecks the project, repeatable; one empty value runs no typecheck at all"
    ),
    Flag.atLeast(0)
  ),
  verifyTest: Flag.string("verify-test").pipe(
    Flag.withDescription("The command that runs the tests, instead of the project's own test script"),
    Flag.optional
  ),
  json: Flag.boolean("json")
}

/**
 * The version `smithers-migrate --version` prints and every report records
 * as its tool version. It is the package's own release version; the release
 * bump rewrites it through `scripts/set-release-version.mjs`, and
 * `test/flow/Dependencies.test.ts` pins it to `package.json`.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const version = "1.0.0-rc.0"

/**
 * The command: one migration, one report, one exit code.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const command = Command.make("smithers-migrate", flags, (config) =>
  Effect.gen(function*() {
    const options = CommandModule.optionsOf(
      {
        root: optional(config.root),
        scan: config.scan,
        apply: config.apply,
        seat: optional(config.seat),
        allowUnsafe: optional(config.allowUnsafe),
        acknowledgeRunState: config.acknowledgeRunState,
        allowNoVcs: config.allowNoVcs,
        keepOldSources: config.keepOldSources,
        unit: optional(config.unit),
        maxRepairRounds: optional(config.maxRepairRounds),
        reportDir: optional(config.reportDir),
        flowsDir: optional(config.flowsDir),
        verifyInstall: optional(config.verifyInstall),
        verifyFormat: optional(config.verifyFormat),
        verifyTypecheck: config.verifyTypecheck,
        verifyTest: optional(config.verifyTest)
      },
      process.cwd(),
      process.env
    )
    const outcome = yield* Effect.result(CommandModule.runNode(options, { environment: process.env }))
    if (outcome._tag === "Failure") {
      const error: MigrateError = outcome.failure
      // A refused gate is not a crash. It prints the operator's own
      // instructions, exits 3, and leaves the project untouched.
      yield* Console.error(
        `smthrs migrate: ${error.message}${error.details === undefined ? "" : `\n${error.details}`}`
      )
      process.exitCode = error.code === "run-state-blocked" || error.code === "unsafe-blocked" ? 3 : 1
      return
    }
    const report = outcome.success
    yield* Console.log(
      CommandModule.render(report, config.json ? "json" : "human", CommandModule.reportDirectory(options))
    )
    process.exitCode = CommandModule.exitCode(report)
  })).pipe(
    Command.withDescription("Upgrade a Smithers 0.x project to Smithers 1.0 flows and write an auditable report")
  )

/**
 * The executable's entry point.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const main = Command.run(command, { version }).pipe(
  Effect.provide(NodeServices.layer)
)
