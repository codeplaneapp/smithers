/**
 * Real CLI e2e tests require installed CLIs, credentials, and network access.
 * Keep the package test gate deterministic unless explicitly opted in.
 */
export const runRealAgentE2E = process.env.SMITHERS_RUN_AGENT_E2E === "1";
