/**
 * @smthrs/database public API.
 *
 * This entry point is the driver-neutral write boundary, so it stays
 * browser-bundleable. Each driver is platform-specific and lives under an
 * explicit subpath, the way `effect` keeps platform packages out of its own
 * root: the Node driver is `node:sqlite` through `@effect/sql-sqlite-node`,
 * and the Cloudflare driver runs on a Durable Object's own SQLite storage.
 *
 * ```ts
 * import { DurableWriter } from "@smthrs/database"
 * import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
 * import * as DurableObjectDatabase from "@smthrs/database/cloudflare/DurableObjectDatabase"
 * import * as TestDatabase from "@smthrs/database/test/TestDatabase"
 * ```
 *
 * @since 0.1.0
 */

/**
 * @category services
 * @since 0.1.0
 * @slop
 */
export * as DurableWriter from "./DurableWriter.ts"

/**
 * @category metrics
 * @since 0.1.0
 * @slop
 */
export * as DatabaseMetrics from "./DatabaseMetrics.ts"

/**
 * @category migrations
 * @since 0.1.0
 * @slop
 */
export * as Migrations from "./Migrations.ts"
