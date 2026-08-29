/**
 * The command-line projection of reserved system flows.
 *
 * @since 0.1.0
 */
import { SystemFlows } from "@smthrs/control"

/**
 * Metadata used to construct a command heading.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Verb {
  readonly name: string
  readonly flowId: string
  readonly help: string
  readonly deployClass: boolean
  readonly planBearing: boolean
}

const words = (name: string): string => name.replaceAll("-", " ")

const entryToVerb = (entry: (typeof SystemFlows.catalog)[number]): Verb => {
  const name = entry.verb
  return {
    name,
    flowId: entry.flowId,
    help: `Run the ${words(name)} ${entry.projection === "procedure" ? "control procedure" : "system flow"}`,
    deployClass: entry.deployClass,
    planBearing: entry.planBearing
  }
}

/**
 * CLI verbs derived from the system-flow catalog. This is intentionally not a
 * second catalog: catalog changes are visible to the command tree directly.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const verbs: ReadonlyArray<Verb> = SystemFlows.catalog.map(entryToVerb)

/**
 * Finds one catalog-derived verb by command name.
 *
 * @category getters
 * @since 0.1.0
 * @slop
 */
export const find = (name: string): Verb | undefined => verbs.find((verb) => verb.name === name)
