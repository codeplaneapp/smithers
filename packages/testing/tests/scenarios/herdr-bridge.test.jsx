/**
 * T3 herdr bridge — machine oracles only.
 * Soft-skips when no herdr server is reachable (CI without herdr stays green).
 */
import { describe, expect, test } from "bun:test";
import { createHerdrClient } from "@smthrs/herdr";
import { runCampaign } from "../../src/campaign.ts";
import { watchPackScenarios } from "../../scripts/watch-pack.mjs";
import { tryCloseHerdrWorkspacesForRun } from "../../src/herdrBridge.ts";

async function herdrReachable() {
  const client = createHerdrClient({ logger: () => {} });
  const pong = await client.ping().catch(() => undefined);
  return { ok: Boolean(pong), client };
}

describe("herdr bridge (T3 machine)", () => {
  test("watch-pack campaign attaches herdr and asserts tabs when server up", async () => {
    const { ok, client } = await herdrReachable();
    if (!ok) {
      console.warn("[herdr-bridge] no server — soft-skip T3 campaign test");
      return;
    }

    const report = await runCampaign({
      scenarios: watchPackScenarios,
      repeat: 1,
      herdr: true,
      // Machine oracle: sleep stubs + virtual clock (not live smithers tail).
      liveUi: false,
      // use isolated session if present; else default
      herdrSession: process.env.HERDR_SESSION || process.env.SMITHERS_HERDR_SESSION,
      onFail: "stop",
      pauseMs: 100,
      log: (m) => console.log(m),
    });

    expect(report.ok).toBe(true);
    expect(report.results.every((r) => r.ok)).toBe(true);
    // At least one scenario should have attached herdr
    expect(report.results.some((r) => r.herdr === true)).toBe(true);

    // Cleanup so the suite does not litter the session
    for (const r of report.results) {
      if (r.runId) await tryCloseHerdrWorkspacesForRun(client, r.runId);
    }
  }, 120_000);
});
