import type { OpenSmithersBackendOptions } from "./OpenSmithersBackendOptions";

export type OpenSmithersStoreOptions = OpenSmithersBackendOptions & {
	mode?: "read" | "write";
	wait?: {
		timeoutMs?: number;
		intervalMs?: number;
	};
};
