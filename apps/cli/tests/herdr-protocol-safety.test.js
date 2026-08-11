import { describe, expect, test } from "bun:test";
import { HERDR_PROTOCOL, HerdrError } from "@smthrs/herdr";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";
import {
  closeCurrentHerdrDetail,
  createUpHerdrSurface,
  ensureSessionStubWorkspace,
  launchHerdrHijackPane,
  openHerdrNodePane,
  probeCompatibleHerdr,
} from "../src/herdr.js";
import { openNodeDetail, probeHerdr } from "../src/smithers-top.js";
import { detectHerdrMirrorForRun } from "../src/steer.js";

/**
 * A deterministic Herdr client whose strict ping has the same mismatch contract
 * as createHerdrClient. Non-ping calls are recorded as observable mutations or
 * reads, so mismatch tests can prove the compatibility gate ran first.
 *
 * @param {number} protocol
 */
function fakeHerdrClient(protocol) {
  const pingOptions = [];
  const operations = [];
  const workspace = { workspace_id: "ws-1", label: "workflow run-1", number: 1 };
  let workspaceCreated = false;

  const pong = {
    type: "pong",
    version: protocol === HERDR_PROTOCOL ? "compatible-test" : "mismatch-test",
    protocol,
    capabilities: {},
  };

  const client = {
    socketPath: "/tmp/fake-herdr.sock",
    async ping(options) {
      pingOptions.push(options);
      if (options?.requireProtocolMatch === true && protocol !== HERDR_PROTOCOL) {
        throw new HerdrError(`herdr protocol mismatch: client expects ${HERDR_PROTOCOL}, server reports ${protocol}`, {
          method: "ping",
          code: "protocol_mismatch",
          cause: pong,
        });
      }
      return pong;
    },
    async tryCall(method, params) {
      operations.push({ kind: "tryCall", method, params });
      if (method === "workspace.list") {
        return { workspaces: workspaceCreated ? [workspace] : [] };
      }
      if (method === "workspace.create") {
        workspaceCreated = true;
        return {
          workspace,
          tab: { tab_id: "tab-root", workspace_id: workspace.workspace_id },
          root_pane: { pane_id: "pane-root" },
        };
      }
      if (method === "agent.list") return { agents: [] };
      if (method === "tab.create") {
        return { tab: { tab_id: "tab-detail", workspace_id: params?.workspace_id ?? workspace.workspace_id } };
      }
      if (method === "pane.list") {
        return {
          panes: [
            { pane_id: "pane-seed", tab_id: "tab-detail", workspace_id: workspace.workspace_id },
            { pane_id: "pane-agent", tab_id: "tab-detail", workspace_id: workspace.workspace_id },
          ],
        };
      }
      return { type: "ok" };
    },
    async call(method, params) {
      operations.push({ kind: "call", method, params });
      if (method === "workspace.list") {
        return { workspaces: workspaceCreated ? [workspace] : [] };
      }
      if (method === "workspace.create") {
        workspaceCreated = true;
        return {
          workspace,
          tab: { tab_id: "tab-root", workspace_id: workspace.workspace_id },
          root_pane: { pane_id: "pane-root" },
        };
      }
      if (method === "agent.list") return { agents: [] };
      if (method === "agent.start") {
        return { agent: { pane_id: "pane-agent", workspace_id: params?.workspace_id ?? workspace.workspace_id } };
      }
      return { type: "ok" };
    },
    subscribe() {
      return { close() {} };
    },
  };

  return { client, operations, pingOptions };
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function startProtocolServer(protocol) {
  const dir = mkdtempSync(join(tmpdir(), "smithers-herdr-protocol-"));
  const socketPath = join(dir, "herdr.sock");
  const readyPath = join(dir, "ready");
  const callsPath = join(dir, "calls.ndjson");
  const fixture = resolve(import.meta.dir, "fixtures/fake-herdr-protocol-server.js");
  const child = spawn(process.execPath, [fixture], {
    stdio: "ignore",
    env: {
      ...process.env,
      FAKE_HERDR_SOCKET_PATH: socketPath,
      FAKE_HERDR_READY_PATH: readyPath,
      FAKE_HERDR_CALLS_PATH: callsPath,
      FAKE_HERDR_PROTOCOL: String(protocol),
    },
  });
  await waitForFile(readyPath);
  return {
    socketPath,
    callsPath,
    async dispose() {
      if (child.exitCode === null) {
        const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 1_000))]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("CLI Herdr protocol safety", () => {
  test("the shared probe requests strict matching and preserves mismatch details", async () => {
    const fake = fakeHerdrClient(HERDR_PROTOCOL + 1);
    const result = await probeCompatibleHerdr(fake.client);

    expect(result.available).toBe(false);
    expect(result.reason).toBe("protocol_mismatch");
    expect(result.pong?.protocol).toBe(HERDR_PROTOCOL + 1);
    expect(fake.pingOptions).toEqual([{ requireProtocolMatch: true }]);
    expect(fake.operations).toEqual([]);
  });

  test("the shared probe rejects a mismatched pong even when an injected client ignores strict mode", async () => {
    const fake = fakeHerdrClient(HERDR_PROTOCOL);
    fake.client.ping = async (options) => {
      fake.pingOptions.push(options);
      return { type: "pong", version: "legacy-client", protocol: HERDR_PROTOCOL + 1, capabilities: {} };
    };

    const result = await probeCompatibleHerdr(fake.client);
    expect(result).toMatchObject({
      available: false,
      reason: "protocol_mismatch",
      pong: { protocol: HERDR_PROTOCOL + 1 },
    });
    expect(fake.operations).toEqual([]);
  });

  test("mismatch makes close, mirror, stub, open, and hijack paths zero-mutation soft failures", async () => {
    const actions = [
      async (fake) => closeCurrentHerdrDetail({ HERDR_ENV: "1", HERDR_TAB_ID: "tab-1" }, fake.client),
      async (fake) =>
        createUpHerdrSurface({
          session: undefined,
          label: "workflow run-1",
          adapter: {},
          runId: "run-1",
          cliPath: "/tmp/smithers.js",
          client: fake.client,
          logger: () => {},
        }),
      async (fake) =>
        ensureSessionStubWorkspace({
          workflowId: "workflow",
          runId: "run-1",
          sessionName: "run-session",
          client: fake.client,
          logger: () => {},
        }),
      async (fake) =>
        openHerdrNodePane({
          label: "workflow run-1",
          runId: "run-1",
          nodeId: "node-1",
          argv: ["smithers", "tail"],
          client: fake.client,
          logger: () => {},
        }),
      async (fake) =>
        launchHerdrHijackPane({
          spec: { command: "claude", args: [], cwd: "/tmp", env: {} },
          runId: "run-1",
          nodeId: "node-1",
          client: fake.client,
          logger: () => {},
        }),
    ];

    for (const action of actions) {
      const fake = fakeHerdrClient(HERDR_PROTOCOL + 1);
      await action(fake);
      expect(fake.pingOptions).toEqual([{ requireProtocolMatch: true }]);
      expect(fake.operations).toEqual([]);
    }
  });

  test("compatible protocol proceeds through close, stub creation, and node-pane placement", async () => {
    const closeFake = fakeHerdrClient(HERDR_PROTOCOL);
    await closeCurrentHerdrDetail({ HERDR_ENV: "1", HERDR_TAB_ID: "tab-1" }, closeFake.client);
    expect(closeFake.operations.map((entry) => entry.method)).toEqual(["tab.close"]);

    const stubFake = fakeHerdrClient(HERDR_PROTOCOL);
    await ensureSessionStubWorkspace({
      workflowId: "workflow",
      runId: "run-1",
      sessionName: "run-session",
      client: stubFake.client,
      logger: () => {},
    });
    expect(stubFake.operations.map((entry) => entry.method)).toEqual([
      "workspace.list",
      "workspace.create",
      "pane.send_text",
    ]);

    const openFake = fakeHerdrClient(HERDR_PROTOCOL);
    const opened = await openHerdrNodePane({
      label: "workflow run-1",
      runId: "run-1",
      nodeId: "node-1",
      argv: ["smithers", "tail"],
      client: openFake.client,
      logger: () => {},
    });
    expect(opened?.paneId).toBe("pane-agent");
    expect(openFake.operations.some((entry) => entry.method === "workspace.create")).toBe(true);
    expect(openFake.operations.some((entry) => entry.method === "tab.create")).toBe(true);
    expect(openFake.operations.some((entry) => entry.method === "agent.start")).toBe(true);
  });

  test("session stub shell text treats command substitutions and quotes as literal text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-herdr-stub-"));
    const substitutionMarker = join(dir, "substitution-ran");
    const backtickMarker = join(dir, "backtick-ran");
    const sessionName = `session ' \$(touch ${substitutionMarker}) \`touch ${backtickMarker}\``;
    const fake = fakeHerdrClient(HERDR_PROTOCOL);
    try {
      await ensureSessionStubWorkspace({
        workflowId: "workflow",
        runId: "run-$HOME",
        sessionName,
        client: fake.client,
        logger: () => {},
      });
      const command = fake.operations.find((entry) => entry.method === "pane.send_text")?.params?.text;
      expect(typeof command).toBe("string");

      const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`\$(touch ${substitutionMarker})`);
      expect(result.stdout).toContain(`\`touch ${backtickMarker}\``);
      expect(result.stdout).toContain("run-$HOME");
      expect(existsSync(substitutionMarker)).toBe(false);
      expect(existsSync(backtickMarker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("passive steer and top probes treat mismatch as unavailable without reads", async () => {
    const steerFake = fakeHerdrClient(HERDR_PROTOCOL + 1);
    const detection = await detectHerdrMirrorForRun({
      runId: "run-1",
      label: "workflow run-1",
      client: steerFake.client,
    });
    expect(detection).toEqual({ mirrored: false, socketPath: steerFake.client.socketPath });
    expect(steerFake.operations).toEqual([]);

    const topFake = fakeHerdrClient(HERDR_PROTOCOL + 1);
    expect(await probeHerdr(topFake.client)).toBe(false);
    expect(topFake.operations).toEqual([]);

    const compatible = fakeHerdrClient(HERDR_PROTOCOL);
    expect(await probeHerdr(compatible.client)).toBe(true);
    const mirrored = await detectHerdrMirrorForRun({
      runId: "run-1",
      label: "workflow run-1",
      client: compatible.client,
    });
    expect(mirrored.mirrored).toBe(false);
    expect(compatible.operations.map((entry) => entry.method)).toEqual(["workspace.list"]);
  });

  test("top detail opening re-checks compatibility immediately before tab mutation", async () => {
    const previousWorkspaceId = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "ops-workspace";
    try {
      const mismatch = fakeHerdrClient(HERDR_PROTOCOL + 1);
      const refused = await openNodeDetail({
        runId: "run-1",
        nodeId: "node-1",
        dbPath: "/tmp/smithers.db",
        cwd: "/tmp",
        herdrAvailable: true,
        herdrClient: mismatch.client,
      });
      expect(refused.mode).toBe("hint");
      expect(refused.message).toContain("protocol mismatch");
      expect(mismatch.operations).toEqual([]);

      const compatible = fakeHerdrClient(HERDR_PROTOCOL);
      const opened = await openNodeDetail({
        runId: "run-1",
        nodeId: "node-1",
        dbPath: "/tmp/smithers.db",
        cwd: "/tmp",
        herdrAvailable: true,
        herdrClient: compatible.client,
      });
      expect(opened.mode).toBe("herdr");
      expect(compatible.operations.some((entry) => entry.method === "tab.create")).toBe(true);
      expect(compatible.operations.some((entry) => entry.method === "agent.start")).toBe(true);
    } finally {
      if (previousWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
      else process.env.HERDR_WORKSPACE_ID = previousWorkspaceId;
    }
  });

  test("herdr status reports an inspectable mismatch as a structured nonzero failure", async () => {
    const server = await startProtocolServer(HERDR_PROTOCOL + 1);
    try {
      const result = runSmithers(["herdr", "status"], {
        cwd: resolve(import.meta.dir, "../../.."),
        env: { ...process.env, HERDR_SOCKET_PATH: server.socketPath },
        format: "json",
        timeoutMs: 10_000,
      });
      expect(result.exitCode).toBe(4);
      expect(result.stderr).toContain("MISMATCH");
      expect(result.json?.code).toBe("HERDR_PROTOCOL_MISMATCH");
      expect(result.json?.message).toContain(`client expects ${HERDR_PROTOCOL}`);
      expect(result.json?.message).toContain(`server reports ${HERDR_PROTOCOL + 1}`);

      const calls = readFileSync(server.callsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(calls.map((call) => call.method)).toEqual(["ping"]);
    } finally {
      await server.dispose();
    }
  });
});
