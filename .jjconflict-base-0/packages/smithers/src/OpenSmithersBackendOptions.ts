import type { CreateSmithersOptions } from "./CreateSmithersOptions";

type SmithersBackend = "sqlite" | "pglite" | "postgres";

export type OpenSmithersBackendOptions = CreateSmithersOptions & {
	backend?: SmithersBackend;
	cwd?: string;
	configPath?: string;
	env?: Record<string, string | undefined>;
	connectionString?: string;
	connection?: object;
	pgliteDataDir?: string;
};
