import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
import type { SmithersDb } from "@smithers/db/adapter";

export type ServeOptions = {
  workflow: SmithersWorkflow<unknown>;
  adapter: SmithersDb;
  runId: string;
  abort: AbortController;
  authToken?: string;
  metrics?: boolean;
};
