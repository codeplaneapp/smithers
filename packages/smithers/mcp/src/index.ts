/**
 * Model Context Protocol client and flow bindings.
 *
 * `McpClient` speaks the stdio protocol to a configured MCP server, and
 * `McpFlows` projects that server's tools into the flow catalog as
 * `mcp/<server>/<tool>` bindings. `@smthrs/cli` composes both behind
 * `--mcp-config`.
 *
 * ```ts
 * import { McpFlows } from "@smthrs/mcp"
 * ```
 *
 * @since 1.0.0-rc.0
 */

/**
 * @category services
 * @since 1.0.0-rc.0
 * @slop
 */
export * as McpClient from "./McpClient.ts"

/**
 * @category services
 * @since 1.0.0-rc.0
 * @slop
 */
export * as Diagnostics from "./Diagnostics.ts"

/**
 * @category errors
 * @since 1.0.0-rc.0
 * @slop
 */
export * as McpError from "./McpError.ts"

/**
 * @category services
 * @since 1.0.0-rc.0
 * @slop
 */
export * as McpFlows from "./McpFlows.ts"
