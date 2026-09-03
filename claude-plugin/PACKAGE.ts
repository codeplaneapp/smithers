/**
 * Targets for the Smithers Claude Code plugin.
 *
 * The plugin ships standalone, so its tests live beside what they guard rather
 * than in a package's suite. They are dependency-free `node:test` files, and
 * the live half of the SessionStart suite spawns the working tree's own
 * `smithers` binary, which is why the environment names a wide probe budget:
 * a source checkout strips types on every CLI start.
 */
import { Smithers } from "@smthrs/targets"
import { runtime } from "../PACKAGE.ts"

/** Every file the plugin's gates read, digested as their key material. */
const sources = Smithers.glob("//claude-plugin/**/*.mjs")

/**
 * The four-tier CLI resolver, and the byte-identity of its two plugin copies.
 *
 * @since 0.1.0
 * @category test
 */
const cliResolution = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//claude-plugin/lib/resolve-smithers-cli.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * The SessionStart hook: the context it builds, the `ls` and `ps` shapes it
 * reads, and one end-to-end run against the real CLI in this working tree.
 *
 * @since 0.1.0
 * @category test
 */
const sessionStart = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//claude-plugin/hooks/session-start.test.mjs")]),
  srcs: [sources],
  deps: [],
  env: { SMITHERS_HOOK_TIMEOUT_MS: "150000" }
})

/**
 * The advisory PreToolUse nudge: the documents it emits, the mirror it stays
 * silent for, and the verb and MCP tool it advertises.
 *
 * @since 0.1.0
 * @category test
 */
const preferSmithers = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//claude-plugin/hooks/prefer-smithers.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * The `/workflows` mirror's contract with the CLI: the version it speaks, the
 * commands it builds, and the vocabulary it treats as terminal.
 *
 * @since 0.1.0
 * @category test
 */
const mirror = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//claude-plugin/workflows/smithers-run.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * Both plugin skills and both plugins' manifests.
 *
 * @since 0.1.0
 * @category test
 */
const skills = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//claude-plugin/skills/smithers/skill.test.mjs")]),
  srcs: [sources],
  deps: []
})

export const Package = Smithers.Package({
  targets: { cliResolution, mirror, preferSmithers, sessionStart, skills }
})
