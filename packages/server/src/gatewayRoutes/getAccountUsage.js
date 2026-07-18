import { listAccounts } from "@smithers-orchestrator/accounts/listAccounts";
import { getUsageForAccounts } from "@smithers-orchestrator/usage/getUsageForAccounts";

/** Read cached/provider subscription reports; callers choose fresh explicitly. */
export async function getGatewayAccountUsage({ fresh = false, env = process.env, nowMs } = {}) {
  return getUsageForAccounts(listAccounts(env), { fresh, env, nowMs });
}
