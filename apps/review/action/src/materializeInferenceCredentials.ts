import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Prepare the environment for the review subprocess once the inference mode is
 * resolved:
 *
 * 1. Scrub the raw ChatGPT credential (CODEX_AUTH_JSON) from `env` so it never
 *    rides into the agent processes that read the untrusted PR diff (runReview
 *    spreads the environment into them). The codex CLI reads
 *    $CODEX_HOME/auth.json, not this var, so nothing downstream needs it.
 *    Defence-in-depth only: agents run as the same user and can still read the
 *    file — this closes the `printenv CODEX_AUTH_JSON` recovery channel.
 *    CLAUDE_CODE_OAUTH_TOKEN is intentionally left intact (the claude CLI reads
 *    it at runtime).
 * 2. In codex-subscription mode, materialize auth.json into an isolated
 *    CODEX_HOME (mode 0600) outside the workspace and point env.CODEX_HOME at it,
 *    so the secret never has to be the user's real ~/.codex and the untrusted PR
 *    tree the agents traverse can never read it.
 *
 * Returns the CODEX_HOME used (codex-subscription mode) or null.
 */
export function materializeInferenceCredentials(input: {
  mode: "codex-subscription" | "claude-subscription" | "proxy";
  codexAuthJson: string | undefined;
  env: Record<string, string | undefined>;
}): string | null {
  const { env } = input;
  delete env.CODEX_AUTH_JSON;
  if (input.mode !== "codex-subscription") return null;
  const codexHome = env.CODEX_HOME?.trim() || join(env.RUNNER_TEMP?.trim() || tmpdir(), ".smithers-codex-home");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), input.codexAuthJson ?? "", { mode: 0o600 });
  env.CODEX_HOME = codexHome;
  return codexHome;
}
