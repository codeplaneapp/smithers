export type MigrateSmithersStoreOptions = {
	cwd?: string;
	dbPath?: string;
	to?: "pglite" | "postgres";
	url?: string;
	env?: Record<string, string | undefined>;
	pgliteDataDir?: string;
	keepSqlite?: boolean;
	batchSize?: number;
	onProgress?: (event:
		| { type: "table-start"; table?: string; sourceRows?: number }
		| {
				type: "table-copied";
				table?: string;
				copiedRows?: number;
				sourceRows?: number;
				targetRows?: number;
				durationMs?: number;
		  }
		| { type: "done"; copiedRows?: number; tableCount?: number; durationMs?: number }
	) => void | Promise<void>;
};
