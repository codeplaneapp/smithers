export type SmithersMigrationResult = {
	backend: "sqlite" | "pglite" | "postgres";
	source: {
		backend: "sqlite" | "pglite" | "postgres";
		dbPath?: string;
		dataDir?: string;
		url?: string;
	};
	dbPath: string;
	markerPath: string;
	target: {
		backend: "sqlite" | "pglite" | "postgres";
		dbPath?: string;
		dataDir?: string;
		url?: string;
	};
	runCount: number;
	schemaVersion: string;
	durationMs: number;
	tables: Array<{ table: string; sourceRows: number; targetRows: number; durationMs: number }>;
	sqliteRemoved: boolean;
};
