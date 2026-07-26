import type { SmithersAlertPolicy } from "@smithers-orchestrator/scheduler/SmithersWorkflowOptions";

export type CreateSmithersOptions = {
	readableName?: string;
	description?: string;
	alertPolicy?: SmithersAlertPolicy;
	dbPath?: string;
	journalMode?: string;
	/**
	 * Maximum connections in the process-local PostgreSQL pool for this URL.
	 * Defaults to 16; all owners of one normalized URL must use one value.
	 * Exceeding it fails an acquire with `PG_POOL_SATURATED` rather than queueing
	 * forever.
	 */
	postgresPoolMax?: number;
	/**
	 * Backend the caller resolved this API to. The synchronous `createSmithers`
	 * only serves `"sqlite"`; `"pglite"`/`"postgres"` require the async
	 * `openSmithersBackend` factory and fail loud here rather than silently
	 * opening bun:sqlite.
	 */
	backend?: "sqlite" | "pglite" | "postgres";
};
