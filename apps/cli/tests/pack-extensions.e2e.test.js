import { expect, onTestFinished, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createTempRepo } from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");

async function findOpenPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!address || typeof address === "string") throw new Error("Could not allocate an open port");
  return address.port;
}

async function waitFor(predicate, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Timed out waiting for the pack-extension Gateway");
}

async function stopProcess(child, closePromise) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const closed = await Promise.race([
    closePromise.then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
  ]);
  if (!closed) {
    child.kill("SIGKILL");
    await closePromise;
  }
}

test("smithers gateway loads a typed pack extension and isolates a malformed sibling", async () => {
  const repo = createTempRepo();
  repo.write(".smithers/smithers.config.ts", "export default {};\n");
  repo.write(
    ".smithers/gateway-extensions.ts",
    [
      'import type { GatewayExtensionDefinition } from "smthrs";',
      "",
      "const files = new Map<string, string>();",
      "const extensions = {",
      '  "invalid namespace": { resources: {} },',
      "  vault: {",
      '    title: "Vault",',
      '    defaultScope: "run:read",',
      "    resources: {",
      "      file: {",
      "        handler: async (params) => ({",
      '          path: String(params.path ?? ""),',
      '          content: files.get(String(params.path ?? "")) ?? null,',
      "        }),",
      "      },",
      "    },",
      "    actions: {",
      "      save: {",
      '        scope: "run:write",',
      "        handler: async (params) => {",
      '          const path = String(params.path ?? "");',
      '          const content = String(params.content ?? "");',
      "          files.set(path, content);",
      "          return { saved: path };",
      "        },",
      "      },",
      "    },",
      "  },",
      "} satisfies Record<string, GatewayExtensionDefinition>;",
      "",
      "export default extensions;",
      "",
    ].join("\n"),
  );

  const port = await findOpenPort();
  const child = spawn(process.execPath, ["run", CLI_ENTRY, "gateway", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repo.dir,
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      SMITHERS_HOME: repo.path("global-smithers"),
      SMITHERS_GATEWAY_STATE_DIR: repo.path("gateway-state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closePromise = new Promise((resolvePromise) => child.once("close", resolvePromise));
  onTestFinished(() => stopProcess(child, closePromise));

  try {
    await waitFor(() => stderr.includes("Runtime state:"));
    expect(stderr).toContain('skipped extension "invalid namespace"');

    const save = await fetch(`http://127.0.0.1:${port}/v1/rpc/ext.vault.save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes/demo.md", content: "hello from the pack" }),
      signal: AbortSignal.timeout(5_000),
    }).then((response) => response.json());
    expect(save).toMatchObject({ ok: true, payload: { saved: "notes/demo.md" } });

    const read = await fetch(`http://127.0.0.1:${port}/v1/rpc/ext.vault.file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes/demo.md" }),
      signal: AbortSignal.timeout(5_000),
    }).then((response) => response.json());
    expect(read).toMatchObject({
      ok: true,
      payload: { path: "notes/demo.md", content: "hello from the pack" },
    });
  } finally {
    await stopProcess(child, closePromise);
  }
}, 75_000);
