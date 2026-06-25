import type { SmithersDb } from "@smithers-orchestrator/db/adapter";
import type { SmithersBackendChoice } from "./SmithersBackendChoice";

export type OpenSmithersStoreResult = {
	choice: SmithersBackendChoice;
	adapter: SmithersDb;
	db: unknown;
	dbPath?: string;
	cleanup: () => Promise<void> | void;
};
