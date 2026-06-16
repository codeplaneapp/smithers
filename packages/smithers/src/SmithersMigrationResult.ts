export type SmithersMigrationResult = {
	backend: "pglite" | "postgres";
	dbPath: string;
	markerPath: string;
	target: {
		backend: "pglite" | "postgres";
		dataDir?: string;
		url?: string;
	};
	runCount: number;
	schemaVersion: string;
	durationMs: number;
	tables: Array<{ table: string; sourceRows: number; targetRows: number; durationMs: number }>;
	sqliteRemoved: boolean;
};
