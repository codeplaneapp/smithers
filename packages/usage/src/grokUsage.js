/**
 * xAI exposes per-session token spend and console-only rate-limit details, but
 * no live account quota endpoint. Do not turn published tier limits into a
 * usage estimate: they do not reveal the account's current consumption.
 *
 * @returns {Promise<import("./buildUsageReport.js").UsageProbe>}
 */
export async function grokUsage() {
  return {
    source: "none",
    error: "xAI exposes no live usage endpoint",
  };
}
