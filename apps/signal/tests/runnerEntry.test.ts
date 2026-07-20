import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getR2Object, putR2Object } from "../../../.smithers/lib/daily-ceo-intel/cloudflare";
import { runOnce } from "../runner/src/entry";

const CF_ENV_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_KV_NAMESPACE_ID", "CLOUDFLARE_R2_BUCKET"] as const;
const originalEnv = Object.fromEntries(CF_ENV_KEYS.map((key) => [key, process.env[key]]));
const originalSpawn = Bun.spawn;
const originalFetch = globalThis.fetch;
const runtimeDbDirectory = mkdtempSync(join(tmpdir(), "smithers-signal-runner-"));
const runtimeDbPath = join(runtimeDbDirectory, "ceo-intel.sqlite");

afterEach(() => {
  for (const key of CF_ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  rmSync(runtimeDbDirectory, { force: true, recursive: true });
  Bun.spawn = originalSpawn;
  globalThis.fetch = originalFetch;
});

function setCfCreds(): void {
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  process.env.CLOUDFLARE_KV_NAMESPACE_ID = "test-kv";
  process.env.CLOUDFLARE_R2_BUCKET = "test-bucket";
}

function clearCfCreds(): void {
  for (const key of CF_ENV_KEYS) delete process.env[key];
}

/** State sync down returns 404 (no prior state), state sync up PUT succeeds. */
function mockR2Fetch(): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") return new Response(null, { status: 200 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

type SpawnScenario = {
  upExitCode?: number;
  upStderr?: string;
  publishOutput?: Record<string, unknown> | null;
  finalizeOutput?: Record<string, unknown> | null;
};

function mockSpawn(scenario: SpawnScenario): void {
  Bun.spawn = ((argv: string[]) => {
    const sub = argv[1];
    if (sub === "up") {
      return {
        stdout: "",
        stderr: scenario.upStderr ?? "",
        exited: Promise.resolve(scenario.upExitCode ?? 0),
      };
    }
    if (sub === "output") {
      const nodeId = argv[3];
      const out = nodeId === "publish" ? scenario.publishOutput : nodeId === "finalize" ? scenario.finalizeOutput : null;
      return {
        stdout: out === null || out === undefined ? "" : JSON.stringify(out),
        stderr: "",
        exited: Promise.resolve(0),
      };
    }
    throw new Error(`unexpected spawn: ${argv.join(" ")}`);
  }) as typeof Bun.spawn;
}

describe("cloudflare.ts: getR2Object (used by the runner's state sync-down)", () => {
  test("returns null on a 404 instead of throwing (first-ever run has no state yet)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    try {
      const result = await getR2Object({ accountId: "a", apiToken: "t", kvNamespaceId: "k", r2Bucket: "b" }, "state/ceo-intel.sqlite");
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns the object bytes on 200", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch;
    try {
      const result = await getR2Object({ accountId: "a", apiToken: "t", kvNamespaceId: "k", r2Bucket: "b" }, "state/ceo-intel.sqlite");
      expect(result).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws on a non-404 error status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    try {
      await expect(getR2Object({ accountId: "a", apiToken: "t", kvNamespaceId: "k", r2Bucket: "b" }, "state/ceo-intel.sqlite")).rejects.toThrow(/HTTP 500/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("cloudflare.ts: putR2Object accepts binary bodies (sqlite state sync-up)", () => {
  test("PUTs Uint8Array bodies for the sqlite state file", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: unknown;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const bytes = new Uint8Array([9, 9, 9]);
      await putR2Object({ accountId: "a", apiToken: "t", kvNamespaceId: "k", r2Bucket: "b" }, "state/ceo-intel.sqlite", bytes, "application/vnd.sqlite3");
      expect(capturedBody).toBe(bytes);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("entry.ts: runOnce() orchestration", () => {
  test("no Cloudflare credentials: ok reflects only the CLI exit code (archive-only expected)", async () => {
    clearCfCreds();
    mockSpawn({ upExitCode: 0, publishOutput: { published: false, skippedReason: "Cloudflare credentials are not present in env." } });
    const result = await runOnce({ dbPath: runtimeDbPath });
    expect(result.ok).toBe(true);
    expect(result.cliExitCode).toBe(0);
    expect(result.stateSyncedDown).toBe(false);
    expect(result.stateSyncedUp).toBe(false);
    expect(result.errors.some((e) => e.includes("Cloudflare credentials not present"))).toBe(true);
  });

  test("with Cloudflare credentials: published=true and ok=true when publish output reports published", async () => {
    setCfCreds();
    mockR2Fetch();
    mkdirSync(join(runtimeDbPath, ".."), { recursive: true });
    await Bun.write(runtimeDbPath, new Uint8Array([1, 2, 3]));
    mockSpawn({ upExitCode: 0, publishOutput: { published: true, idempotentSkip: false }, finalizeOutput: { status: "published" } });
    const result = await runOnce({ dbPath: runtimeDbPath });
    expect(result.ok).toBe(true);
    expect(result.published).toBe(true);
    expect(result.finalizeStatus).toBe("published");
    expect(result.stateSyncedUp).toBe(true);
  });

  test("idempotentSkip counts as published (duplicate-publish is not a failure)", async () => {
    setCfCreds();
    mockR2Fetch();
    mockSpawn({ upExitCode: 0, publishOutput: { published: false, idempotentSkip: true, skippedReason: "Already delivered for this issue date; KV writes skipped." } });
    const result = await runOnce({ dbPath: runtimeDbPath });
    expect(result.ok).toBe(true);
    expect(result.published).toBe(true);
    expect(result.publishSkippedReason).toBe("Already delivered for this issue date; KV writes skipped.");
  });

  test("with Cloudflare credentials: ok=false when the composed issue was not published (verifier rejection etc.)", async () => {
    setCfCreds();
    mockR2Fetch();
    mockSpawn({ upExitCode: 0, publishOutput: { published: false, idempotentSkip: false, skippedReason: "The composed issue failed verification." } });
    const result = await runOnce({ dbPath: runtimeDbPath });
    expect(result.ok).toBe(false);
    expect(result.published).toBe(false);
    expect(result.publishSkippedReason).toBe("The composed issue failed verification.");
  });

  test("non-zero CLI exit code: ok=false and the exit code plus stderr tail are captured", async () => {
    clearCfCreds();
    mockSpawn({ upExitCode: 1, upStderr: "boom: workflow crashed" });
    const result = await runOnce({ dbPath: runtimeDbPath });
    expect(result.ok).toBe(false);
    expect(result.cliExitCode).toBe(1);
    expect(result.published).toBe(false);
    expect(result.errors.some((e) => e.includes("smithers up exited 1") && e.includes("boom: workflow crashed"))).toBe(true);
  });

  test("non-zero CLI exit code short-circuits reading publish/finalize node output", async () => {
    clearCfCreds();
    let outputCalls = 0;
    Bun.spawn = ((argv: string[]) => {
      if (argv[1] === "up") return { stdout: "", stderr: "fail", exited: Promise.resolve(1) };
      if (argv[1] === "output") {
        outputCalls += 1;
        return { stdout: "", stderr: "", exited: Promise.resolve(0) };
      }
      throw new Error(`unexpected spawn: ${argv.join(" ")}`);
    }) as typeof Bun.spawn;
    const result = await runOnce({ dbPath: runtimeDbPath });
    expect(result.ok).toBe(false);
    expect(outputCalls).toBe(0);
  });

  test("runId is derived from today's date and a random suffix", async () => {
    clearCfCreds();
    mockSpawn({ upExitCode: 0, publishOutput: { published: false } });
    const result = await runOnce({ dbPath: runtimeDbPath });
    expect(result.runId).toMatch(/^signal-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
  });
});
