import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { withTaskRuntime } from "@smthrs/driver/task-runtime";
import { executeSandbox } from "@smthrs/sandbox";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createDb(): { adapter: SmithersDb; db: ReturnType<typeof drizzle>; sqlite: Database } {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), db, sqlite };
}

function createRuntime(db: SmithersDb, rootDir: string) {
  return {
    runId: "case23-parent-run",
    stepId: "case23-sandbox",
    attempt: 1,
    iteration: 0,
    rootDir,
    signal: new AbortController().signal,
    db: db as unknown as Record<string, unknown>,
    heartbeat: () => undefined,
    lastHeartbeat: null,
  };
}

async function withHarnessProxyEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://harness.invalid:9999";
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.HTTPS_PROXY;
    } else {
      process.env.HTTPS_PROXY = previous;
    }
  }
}

describe("case 23: sandbox-owned egress proxy config", () => {
  test("iron-proxy config is delivered to the sandbox provider without reconfiguring the harness", async () => {
    const { adapter, sqlite } = createDb();
    const caPem = "-----BEGIN CERTIFICATE-----\ncase23-proxy-ca\n-----END CERTIFICATE-----\n";
    const rootDir = tempDir("case23-egress-");
    const providerCalls: Array<unknown> = [];
    const originalHarnessProxy = process.env.HTTPS_PROXY;

    try {
      const output = await withHarnessProxyEnv(() =>
        withTaskRuntime(createRuntime(adapter, rootDir), () =>
          executeSandbox({
            sandboxId: "case23-iron-proxy",
            provider: {
              id: "iron-proxy-fake",
              run: (request) => {
                providerCalls.push(request.egress);
                expect(process.env.HTTPS_PROXY).toBe("http://harness.invalid:9999");
                expect(request.egress).toMatchObject({
                  httpsProxy: "http://127.0.0.1:8080",
                  httpProxy: "http://127.0.0.1:8080",
                  noProxy: "127.0.0.1,localhost",
                  secretBindings: { "sk-proxy-anthropic": "anthropic" },
                });
                const caPath = join(request.requestBundlePath, ".smithers", "egress", "ca.crt");
                expect(existsSync(caPath)).toBe(true);
                expect(readFileSync(caPath, "utf8")).toBe(caPem);
                return {
                  status: "finished",
                  output: {
                    sandboxProxy: request.egress?.httpsProxy,
                    harnessProxy: process.env.HTTPS_PROXY,
                  },
                  runId: "case23-provider-run",
                };
              },
            },
            workflow: { build: () => null },
            executeChildWorkflow: async () => ({
              runId: "unused-child",
              status: "finished",
              output: {},
            }),
            input: { target: "https://api.anthropic.com/v1/messages" },
            rootDir,
            allowNetwork: true,
            maxOutputBytes: 1024,
            toolTimeoutMs: 250,
            reviewDiffs: false,
            config: {
              egress: {
                httpsProxy: "http://127.0.0.1:8080",
                httpProxy: "http://127.0.0.1:8080",
                noProxy: ["127.0.0.1", "localhost"],
                caCertPem: caPem,
                secretBindings: { "sk-proxy-anthropic": "anthropic" },
              },
            },
          }),
        ),
      );

      expect(output).toEqual({
        sandboxProxy: "http://127.0.0.1:8080",
        harnessProxy: "http://harness.invalid:9999",
      });
      expect(providerCalls).toHaveLength(1);
      expect(process.env.HTTPS_PROXY).toBe(originalHarnessProxy);

      const sandbox = await adapter.getSandbox("case23-parent-run", "case23-iron-proxy");
      expect(sandbox?.status).toBe("finished");
      expect(String(sandbox?.configJson)).not.toContain("case23-proxy-ca");
      expect(String(sandbox?.configJson)).not.toContain("sk-proxy-anthropic");
    } finally {
      sqlite.close();
    }
  });
});
