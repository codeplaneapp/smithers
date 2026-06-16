export type SmithersBackendChoice = {
	backend: "sqlite" | "pglite" | "postgres";
	source: "options" | "env" | "config" | "default";
	dbPath: string;
	workspaceRoot: string;
	runCount: number;
	schemaVersion: string;
	migratedMarker: boolean;
};
