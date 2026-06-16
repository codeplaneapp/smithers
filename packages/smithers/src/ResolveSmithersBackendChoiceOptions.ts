export type ResolveSmithersBackendChoiceOptions = {
	backend?: "sqlite" | "pglite" | "postgres";
	cwd?: string;
	dbPath?: string;
	configPath?: string;
	env?: Record<string, string | undefined>;
};
