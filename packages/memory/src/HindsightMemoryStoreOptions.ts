import type { HindsightClient } from "@vectorize-io/hindsight-client";

export type HindsightMemoryStoreOptions = {
  /** Hindsight API base URL, for example `http://127.0.0.1:8888`. */
  baseUrl: string;
  /** Optional Hindsight bearer token. */
  apiKey?: string;
  /** Prefix applied to Smithers-created and component-selected banks. */
  bankPrefix?: string;
  /** Optional client override for tests and advanced transports. */
  client?: HindsightClient;
};
