export type ResolveSmithersBackendChoiceOptions = {
	backend?: "sqlite" | "pglite" | "postgres";
	cwd?: string;
	dbPath?: string;
	pgliteDataDir?: string;
	connectionString?: string;
	connection?: { query?: (...args: any[]) => Promise<any> };
	configPath?: string;
	env?: Record<string, string | undefined>;
};
