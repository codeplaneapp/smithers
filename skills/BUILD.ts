/**
 * Targets for the curated agent skills.
 *
 * `smithers skills add` copies these files into every agent skill directory it
 * detects, and an agent then reads them as its only description of Smithers.
 * That makes them product surface, so they are checked the way the registry
 * checks them and read for any command 1.0 removed.
 */
import { Smithers } from "@smthrs/targets"
import { runtime } from "../BUILD.ts"

/**
 * Every curated skill parses, names itself after its directory, keeps its
 * description inside the Agent Skills limit, and names no removed command.
 *
 * @since 0.1.0
 * @category test
 */
export const curated = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//skills/skills.test.mjs")]),
  srcs: [Smithers.glob("//skills/**/SKILL.md")],
  deps: []
})
