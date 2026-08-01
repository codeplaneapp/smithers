import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  allocateConciergePort,
  bundleIsFresh,
  checkLocalWorkspaceReadiness,
  chooseLocalUiSource,
  hasConciergeCredential,
  startLocalUiServer,
} from "../src/localUiServer.js";

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()();
  }
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${address.port}`;
}

async function tempWorkspace({ smithers = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "smithers-local-ui-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  if (smithers) await mkdir(join(root, ".smithers"));
  return root;
}

async function tempDist() {
  const root = await mkdtemp(join(tmpdir(), "smithers-ui-dist-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Smithers</title>");
  return root;
}

describe("chooseLocalUiSource", () => {
  test("prefers the in-repo source over a prebuilt bundle", () => {
    // ui-dist is a pack-time artifact treated as permanently fresh, so a source
    // checkout that preferred it would serve whatever was last packed.
    expect(chooseLocalUiSource({ hasBundle: true, hasSource: true, hasVite: true })).toBe("source");
  });

  test("falls back to the bundle when the source app cannot be built", () => {
    expect(chooseLocalUiSource({ hasBundle: true, hasSource: true, hasVite: false })).toBe("bundle");
  });

  test("still uses the source when there is no bundle to fall back to", () => {
    expect(chooseLocalUiSource({ hasBundle: false, hasSource: true, hasVite: false })).toBe("source");
  });

  test("uses the bundle on a published install with no source tree", () => {
    expect(chooseLocalUiSource({ hasBundle: true, hasSource: false, hasVite: false })).toBe("bundle");
  });

  test("returns null when neither is available", () => {
    expect(chooseLocalUiSource({ hasBundle: false, hasSource: false, hasVite: false })).toBeNull();
  });
});

describe("bundleIsFresh", () => {
  test("becomes stale when an inlined workspace dependency source changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-ui-freshness-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const appDir = join(root, "app");
    const distDir = join(appDir, "dist");
    const dependencyDir = join(root, "gateway-ui");
    await mkdir(join(appDir, "src"), { recursive: true });
    await mkdir(distDir);
    await mkdir(join(dependencyDir, "src"), { recursive: true });
    await mkdir(join(appDir, "node_modules", "@smithers-orchestrator"), { recursive: true });
    await writeFile(join(appDir, "src", "main.tsx"), "");
    await writeFile(
      join(appDir, "package.json"),
      JSON.stringify({
        dependencies: { "@smithers-orchestrator/gateway-ui": "workspace:*" },
      }),
    );
    await writeFile(
      join(dependencyDir, "package.json"),
      JSON.stringify({
        name: "@smithers-orchestrator/gateway-ui",
        exports: { ".": "./src/index.ts" },
      }),
    );
    const dependencySource = join(dependencyDir, "src", "index.ts");
    await writeFile(dependencySource, "");
    await symlink(dependencyDir, join(appDir, "node_modules", "@smithers-orchestrator", "gateway-ui"));
    const bundle = join(distDir, "index.html");
    await writeFile(bundle, "");

    const old = new Date("2020-01-01T00:00:00Z");
    const built = new Date("2020-01-02T00:00:00Z");
    const changed = new Date("2020-01-03T00:00:00Z");
    await utimes(join(appDir, "src", "main.tsx"), old, old);
    await utimes(join(appDir, "package.json"), old, old);
    await utimes(join(dependencyDir, "package.json"), old, old);
    await utimes(dependencySource, old, old);
    await utimes(bundle, built, built);
    expect(bundleIsFresh(distDir, appDir)).toBe(true);

    await utimes(dependencySource, changed, changed);
    expect(bundleIsFresh(distDir, appDir)).toBe(false);
  });

  test("sees a workspace dependency whose entry the CommonJS resolver cannot take", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-ui-freshness-esm-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const appDir = join(root, "app");
    const distDir = join(appDir, "dist");
    const dependencyDir = join(root, "ui");
    await mkdir(join(appDir, "src"), { recursive: true });
    await mkdir(distDir);
    await mkdir(join(dependencyDir, "src"), { recursive: true });
    await mkdir(join(appDir, "node_modules", "@smithers-orchestrator"), { recursive: true });
    await writeFile(join(appDir, "src", "main.tsx"), "");
    await writeFile(
      join(appDir, "package.json"),
      JSON.stringify({ dependencies: { "@smithers-orchestrator/ui": "workspace:*" } }),
    );
    await writeFile(
      join(dependencyDir, "package.json"),
      // Only an `import` condition: `require.resolve` cannot reach this entry.
      JSON.stringify({ name: "@smithers-orchestrator/ui", exports: { ".": { import: "./src/index.ts" } } }),
    );
    const dependencySource = join(dependencyDir, "src", "index.ts");
    await writeFile(dependencySource, "");
    await symlink(dependencyDir, join(appDir, "node_modules", "@smithers-orchestrator", "ui"));
    const bundle = join(distDir, "index.html");
    await writeFile(bundle, "");

    const old = new Date("2020-01-01T00:00:00Z");
    const built = new Date("2020-01-02T00:00:00Z");
    const changed = new Date("2020-01-03T00:00:00Z");
    await utimes(join(appDir, "src", "main.tsx"), old, old);
    await utimes(join(appDir, "package.json"), old, old);
    await utimes(join(dependencyDir, "package.json"), old, old);
    await utimes(dependencySource, old, old);
    await utimes(bundle, built, built);
    expect(bundleIsFresh(distDir, appDir)).toBe(true);

    await utimes(dependencySource, changed, changed);
    expect(bundleIsFresh(distDir, appDir)).toBe(false);
  });

  test("tracks transitive workspace sources and package manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-ui-freshness-transitive-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const appDir = join(root, "app");
    const distDir = join(appDir, "dist");
    const directDir = join(root, "gateway-ui");
    const transitiveDir = join(root, "workspace-theme");
    await mkdir(join(appDir, "src"), { recursive: true });
    await mkdir(distDir);
    await mkdir(join(directDir, "src"), { recursive: true });
    await mkdir(join(transitiveDir, "src"), { recursive: true });
    await mkdir(join(appDir, "node_modules", "@smithers-orchestrator"), { recursive: true });
    await mkdir(join(directDir, "node_modules"), { recursive: true });
    await writeFile(join(appDir, "src", "main.tsx"), "");
    await writeFile(
      join(appDir, "package.json"),
      JSON.stringify({ dependencies: { "@smithers-orchestrator/gateway-ui": "workspace:*" } }),
    );
    await writeFile(
      join(directDir, "package.json"),
      JSON.stringify({
        name: "@smithers-orchestrator/gateway-ui",
        exports: { ".": "./src/index.ts" },
        dependencies: { "workspace-theme": "workspace:*" },
      }),
    );
    await writeFile(join(directDir, "src", "index.ts"), "");
    const transitiveManifest = join(transitiveDir, "package.json");
    await writeFile(
      transitiveManifest,
      JSON.stringify({ name: "workspace-theme", exports: { ".": "./src/index.ts" } }),
    );
    const transitiveSource = join(transitiveDir, "src", "index.ts");
    await writeFile(transitiveSource, "");
    await symlink(directDir, join(appDir, "node_modules", "@smithers-orchestrator", "gateway-ui"));
    await symlink(transitiveDir, join(directDir, "node_modules", "workspace-theme"));
    const bundle = join(distDir, "index.html");
    await writeFile(bundle, "");

    const old = new Date("2020-01-01T00:00:00Z");
    const built = new Date("2020-01-02T00:00:00Z");
    const changed = new Date("2020-01-03T00:00:00Z");
    for (const path of [
      join(appDir, "src", "main.tsx"),
      join(appDir, "package.json"),
      join(directDir, "package.json"),
      join(directDir, "src", "index.ts"),
      transitiveManifest,
      transitiveSource,
    ]) {
      await utimes(path, old, old);
    }
    await utimes(bundle, built, built);
    expect(bundleIsFresh(distDir, appDir)).toBe(true);

    await utimes(transitiveSource, changed, changed);
    expect(bundleIsFresh(distDir, appDir)).toBe(false);
    await utimes(transitiveSource, old, old);
    await utimes(transitiveManifest, changed, changed);
    expect(bundleIsFresh(distDir, appDir)).toBe(false);
  });

  test("stays fresh when a declared dependency is not installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-ui-freshness-missing-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const appDir = join(root, "app");
    const distDir = join(appDir, "dist");
    await mkdir(join(appDir, "src"), { recursive: true });
    await mkdir(distDir);
    await writeFile(join(appDir, "src", "main.tsx"), "");
    await writeFile(
      join(appDir, "package.json"),
      JSON.stringify({ dependencies: { "@smithers-orchestrator/absent": "workspace:*" } }),
    );
    const bundle = join(distDir, "index.html");
    await writeFile(bundle, "");
    const old = new Date("2020-01-01T00:00:00Z");
    const built = new Date("2020-01-02T00:00:00Z");
    await utimes(join(appDir, "src", "main.tsx"), old, old);
    await utimes(join(appDir, "package.json"), old, old);
    await utimes(bundle, built, built);
    expect(bundleIsFresh(distDir, appDir)).toBe(true);
  });
});

describe("localUiServer workspace readiness", () => {
  test("allocates an available ephemeral port for each concierge session", async () => {
    const occupied = createServer();
    const occupiedBase = await listen(occupied);
    const occupiedPort = Number(new URL(occupiedBase).port);

    const conciergePort = await allocateConciergePort();

    expect(conciergePort).toBeGreaterThan(0);
    expect(conciergePort).not.toBe(occupiedPort);
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(conciergePort, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
  });

  test("reports a ready local workspace scoped to the proxied gateway", async () => {
    const workspace = await tempWorkspace();
    const gatewayBase = await listen(
      createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      }),
    );

    const readiness = await checkLocalWorkspaceReadiness({
      workspaceRoot: workspace,
      serverWorkspaceRoot: workspace,
      gatewayBase,
    });

    expect(readiness.status).toBe("ready");
    expect(readiness.gatewayReachable).toBe(true);
    expect(readiness.scopedToSelectedRoot).toBe(true);
  });

  test("serves readiness over the local-only UI API", async () => {
    const workspace = await tempWorkspace();
    const distDir = await tempDist();
    const gatewayBase = await listen(
      createServer((req, res) => {
        res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: req.url === "/health" }));
      }),
    );
    const uiServer = await startLocalUiServer({ distDir, gatewayBase, port: 0, workspaceRoot: workspace });
    cleanups.push(() => new Promise((resolve) => uiServer.close(resolve)));
    const address = uiServer.address();
    if (!address || typeof address !== "object") throw new Error("UI server did not bind");

    const res = await fetch(`http://127.0.0.1:${address.port}/__smithers/local-workspace/readiness`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: workspace }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.readiness.status).toBe("ready");
    expect(body.readiness.workspaceRoot).toBe(await realpath(workspace));
  });

  test("detects a concierge chat credential from any supported env var", () => {
    expect(hasConciergeCredential({})).toBe(false);
    expect(hasConciergeCredential({ OPENAI_API_KEY: "  " })).toBe(false);
    expect(hasConciergeCredential({ CEREBRAS_API_KEY: "csk-1" })).toBe(true);
    expect(hasConciergeCredential({ CODEX_ACCESS_TOKEN: "t" })).toBe(true);
    expect(hasConciergeCredential({ CODEX_REFRESH_TOKEN: "r" })).toBe(true);
    expect(hasConciergeCredential({ OPENAI_API_KEY: "sk-1" })).toBe(true);
  });

  test("reports missing local setup before treating a workspace as ready", async () => {
    const workspace = await tempWorkspace({ smithers: false });
    const readiness = await checkLocalWorkspaceReadiness({
      workspaceRoot: workspace,
      serverWorkspaceRoot: workspace,
      gatewayBase: "http://127.0.0.1:1",
    });

    expect(readiness.status).toBe("missing-setup");
    expect(readiness.missing).toContain(".smithers/");
  });
});
