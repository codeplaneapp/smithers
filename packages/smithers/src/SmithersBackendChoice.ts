export type SmithersBackendChoice = {
	backend: "sqlite" | "pglite" | "postgres";
	source: "options" | "env" | "config" | "marker" | "default";
	dbPath: string;
	workspaceRoot: string;
	runCount: number;
	schemaVersion: string;
	sqlite: { dbPath: string; exists: boolean; runCount: number; schemaVersion: string };
	pglite: { dataDir: string; exists: boolean; initialized: boolean; runCount: number; schemaVersion: string; error?: string };
	postgres: {
		exists: boolean;
		initialized: boolean;
		runCount: number;
		schemaVersion: string;
		connectionString?: "set";
		error?: string;
	};
	migratedMarker: boolean;
};
