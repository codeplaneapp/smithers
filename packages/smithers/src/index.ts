/**
 * The public command-line projection for flows.
 *
 * Every module under `src/` is exported here and is also reachable as
 * `@smthrs/cli/<Module>`. The barrel is complete on purpose: a module that is
 * a subpath export but not a namespace here is public through one spelling and
 * invisible through the other. `test/Readme.test.ts` compares `README.md`'s
 * table against this list, so a module or a runtime export that reaches one
 * and not the other fails the suite.
 *
 * @since 0.1.0
 */

/**
 * @category agents
 * @since 1.0.0
 */
export * as Agents from "./Agents.ts"
/**
 * @category layers
 * @since 1.0.0
 */
export * as Application from "./Application.ts"
/**
 * @category reporting
 * @since 1.0.0
 */
export * as Bug from "./Bug.ts"
/**
 * @category protocol
 * @since 1.0.0
 */
export * as ClaudeMirror from "./ClaudeMirror.ts"
/**
 * @category errors
 * @since 1.0.0
 */
export * as CliError from "./CliError.ts"
/**
 * @category node
 * @since 1.0.0
 */
export * as CodexAuth from "./CodexAuth.ts"
/**
 * @category commands
 * @since 1.0.0
 */
export * as Command from "./Command.ts"
/**
 * @category execution
 * @since 1.0.0
 */
export * as Detached from "./Detached.ts"
/**
 * @category diagnostics
 * @since 1.0.0
 */
export * as Doctor from "./Doctor.ts"
/**
 * @category configuration
 * @since 1.0.0
 */
export * as Environment from "./Environment.ts"
/**
 * @category execution
 * @since 1.0.0
 */
export * as ExecutorOwnership from "./ExecutorOwnership.ts"
/**
 * @category diagnostics
 * @since 1.0.0
 */
export * as Forensics from "./Forensics.ts"
/**
 * @category retention
 * @since 1.0.0
 */
export * as Gc from "./Gc.ts"
/**
 * @category scaffolding
 * @since 1.0.0
 */
export * as Init from "./Init.ts"
/**
 * @category migration
 * @since 1.0.0
 */
export * as Legacy from "./Legacy.ts"
/**
 * @category mcp
 * @since 1.0.0
 */
export * as McpServer from "./McpServer.ts"
/**
 * @category node
 * @since 1.0.0
 */
export * as NodeControl from "./NodeControl.ts"
/**
 * @category projections
 * @since 1.0.0
 */
export * as NodeOutput from "./NodeOutput.ts"
/**
 * @category output
 * @since 1.0.0
 */
export * as Output from "./Output.ts"
/**
 * @category project
 * @since 1.0.0
 */
export * as Project from "./Project.ts"
/**
 * @category serve
 * @since 1.0.0
 */
export * as Serve from "./Serve.ts"
/**
 * @category refusals
 * @since 1.0.0
 */
export * as Unsupported from "./Unsupported.ts"
/**
 * @category update
 * @since 1.0.0
 */
export * as Update from "./Update.ts"
/**
 * @category models
 * @since 1.0.0
 */
export * as Verb from "./Verb.ts"
/**
 * @category configuration
 * @since 1.0.0
 */
export * as Version from "./Version.ts"
