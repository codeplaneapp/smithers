/**
 * Targets for the Smithers Codex plugin.
 *
 * The plugin's suites are written against `bun:test`, the convention its App
 * Server routing test already used, so the gate names the Bun runtime rather
 * than the Node one every other gate in this repository uses.
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime } from "../PACKAGE.ts"

/**
 * The App Server routing configurator and the SessionStart hook, including one
 * end-to-end run against the real CLI in this working tree.
 *
 * @since 0.1.0
 * @category test
 */
const plugin = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.testSuite(["hooks", "scripts"]),
  srcs: [Smithers.glob("//codex-plugin/**/*.mjs")],
  deps: [],
  cwd: "codex-plugin",
  env: { SMITHERS_HOOK_TIMEOUT_MS: "150000" }
})

export const Package = Smithers.Package({
  targets: { plugin }
})
