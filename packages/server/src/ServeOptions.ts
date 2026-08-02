import type { SmithersWorkflow } from "@smthrs/components/SmithersWorkflow";
import type { SmithersDb } from "@smthrs/db/adapter";

export type ServeOptions = {
  workflow: SmithersWorkflow<unknown>;
  adapter: SmithersDb;
  runId: string;
  abort: AbortController;
  authToken?: string;
  metrics?: boolean;
  /**
   * Opt out of the unauthenticated Host/Origin rebinding+CSRF defense for a
   * deliberate remote unauthenticated bind (the CLI `--insecure` flag). Ignored
   * when `authToken` is set (the token is the gate). `SMITHERS_SERVE_TRUST_ANY_HOST`
   * is an equivalent env opt-out.
   */
  insecure?: boolean;
};
