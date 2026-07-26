import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { createHerdrClient } from "../src/createHerdrClient.js";
import { HerdrError } from "../src/HerdrError.js";
import { isHerdrInstalled, startHerdrServer } from "./herdr-server.js";

/**
 * Count open file descriptors of the current process (Linux `/proc`), or `-1`
 * where unavailable. Used to prove per-call sockets are released (no fd leak).
 *
 * @returns {number}
 */
function openFdCount() {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return -1;
  }
}

const herdrInstalled = isHerdrInstalled();

/**
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

/**
 * @param {import("../src/HerdrClientOptions.ts").HerdrEvent} event
 * @param {string} workspaceId
 */
function isWorkspaceCreated(event, workspaceId) {
  const ws = /** @type {{ workspace?: { workspace_id?: string } }} */ (event.data).workspace;
  return event.type === "workspace.created" && ws?.workspace_id === workspaceId;
}

describe.skipIf(!herdrInstalled)("createHerdrClient against a real herdr server", () => {
  /** @type {Awaited<ReturnType<typeof startHerdrServer>>} */
  let server;
  /** @type {import("../src/HerdrClientOptions.ts").HerdrClient} */
  let client;

  beforeAll(async () => {
    server = await startHerdrServer();
    client = createHerdrClient({ socketPath: server.socketPath, callTimeoutMs: 4000, logger: () => {} });
  });

  afterAll(async () => {
    await server?.dispose();
  });

  test("ping resolves a protocol-16 pong", async () => {
    const pong = await client.ping();
    expect(pong?.type).toBe("pong");
    expect(pong?.protocol).toBe(16);
    expect(typeof pong?.version).toBe("string");
  });

  test("call: workspace.create then workspace.close (one connection each)", async () => {
    const created = /** @type {any} */ (
      await client.call("workspace.create", { label: "smithers-test-happy", focus: false })
    );
    expect(created.type).toBe("workspace_created");
    const workspaceId = created.workspace.workspace_id;
    expect(typeof workspaceId).toBe("string");

    const closed = /** @type {any} */ (await client.call("workspace.close", { workspace_id: workspaceId }));
    expect(closed.type).toBe("ok");
  });

  test("call: the per-call timeout fires while herdr is still waiting", async () => {
    const created = /** @type {any} */ (
      await client.call("workspace.create", { label: "smithers-test-timeout", focus: false })
    );
    const workspaceId = created.workspace.workspace_id;
    const paneId = created.root_pane.pane_id;

    // pane.wait_for_output blocks on the connection until it matches or its
    // own timeout_ms elapses; with a never-matching sentinel and a long herdr
    // timeout, our short per-call timeout must fire first.
    const impatient = createHerdrClient({ socketPath: server.socketPath, callTimeoutMs: 400, logger: () => {} });
    const started = Date.now();
    const err = await impatient
      .call("pane.wait_for_output", {
        pane_id: paneId,
        source: "visible",
        match: { type: "substring", value: "SMITHERS_NEVER_MATCH_SENTINEL_zzz" },
        timeout_ms: 30000,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(4000);

    await client.call("workspace.close", { workspace_id: workspaceId }).catch(() => {});
  });

  test("call: rejects with ENOENT when the socket is absent", async () => {
    const absent = createHerdrClient({
      socketPath: `${server.socketPath}.absent`,
      callTimeoutMs: 1000,
      logger: () => {},
    });
    const err = await absent.call("ping").catch((e) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe("ENOENT");
  });

  test("call: an error frame (empty-id malformed request) surfaces as a call failure", async () => {
    const err = await client.call("nope.not_a_real_method").catch((e) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe("invalid_request");
    expect(err.method).toBe("nope.not_a_real_method");
  });

  test("tryCall: soft-fails to undefined and warns instead of throwing", async () => {
    let warned = false;
    const soft = createHerdrClient({
      socketPath: server.socketPath,
      logger: (level) => {
        if (level === "warn") {
          warned = true;
        }
      },
    });
    const result = await soft.tryCall("nope.not_a_real_method");
    expect(result).toBeUndefined();
    expect(warned).toBe(true);
  });

  test("subscribe: replays existing state and then streams live events", async () => {
    // Created BEFORE subscribing -> must arrive via replay.
    const pre = /** @type {any} */ (await client.call("workspace.create", { label: "sub-pre", focus: false }));
    const preId = pre.workspace.workspace_id;

    /** @type {import("../src/HerdrClientOptions.ts").HerdrEvent[]} */
    const seen = [];
    const handle = client.subscribe([{ type: "workspace.created" }], (e) => seen.push(e));

    try {
      expect(await waitFor(() => seen.some((e) => isWorkspaceCreated(e, preId)), 5000)).toBe(true);

      // Created AFTER subscribing -> must arrive as a live event.
      const live = /** @type {any} */ (await client.call("workspace.create", { label: "sub-live", focus: false }));
      const liveId = live.workspace.workspace_id;
      expect(await waitFor(() => seen.some((e) => isWorkspaceCreated(e, liveId)), 5000)).toBe(true);

      // Names are normalized to the dotted form for every delivered event.
      expect(seen.every((e) => e.type === "workspace.created")).toBe(true);

      await client.call("workspace.close", { workspace_id: liveId }).catch(() => {});
      await client.call("workspace.close", { workspace_id: preId }).catch(() => {});
    } finally {
      handle.close();
    }
  });

  test("subscribe: auto-reconnects and resubscribes after the server restarts", async () => {
    /** @type {import("../src/HerdrClientOptions.ts").HerdrEvent[]} */
    const seen = [];
    const handle = client.subscribe([{ type: "workspace.created" }], (e) => seen.push(e));

    try {
      // Let the subscription establish against the original server.
      await new Promise((r) => setTimeout(r, 400));

      // Kill the server (drops the subscribe socket) then bring a fresh one
      // up on the SAME session name / socket path.
      await server.stopServer();
      await server.restart();

      // The reconnected + resubscribed connection must observe a workspace
      // created on the fresh server (whether via replay or as a live event).
      /** @type {string | null} */
      let workspaceId = null;
      const ok = await waitFor(
        async () => {
          if (!workspaceId) {
            try {
              const created = /** @type {any} */ (
                await client.call("workspace.create", { label: "after-restart", focus: false })
              );
              workspaceId = created.workspace.workspace_id;
            } catch {
              return false;
            }
          }
          return seen.some((e) => isWorkspaceCreated(e, /** @type {string} */ (workspaceId)));
        },
        15000,
        250,
      );

      expect(ok).toBe(true);
      expect(workspaceId).toBeTruthy();
      await client.call("workspace.close", { workspace_id: /** @type {string} */ (workspaceId) }).catch(() => {});
    } finally {
      handle.close();
    }
  }, 30000);

  test("subscribe: handle.close() is idempotent and stops reconnection + delivery", async () => {
    /** @type {import("../src/HerdrClientOptions.ts").HerdrEvent[]} */
    const seen = [];
    const handle = client.subscribe([{ type: "workspace.created" }], (e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 400));

    handle.close();
    handle.close(); // second call must be a harmless no-op

    const countAtClose = seen.length;
    const created = /** @type {any} */ (await client.call("workspace.create", { label: "after-close", focus: false }));
    // A closed subscription must not receive further events.
    await new Promise((r) => setTimeout(r, 800));
    expect(seen.length).toBe(countAtClose);

    await client.call("workspace.close", { workspace_id: created.workspace.workspace_id }).catch(() => {});
  });

  test("call: no fd leak across 50 sequential + 20 concurrent calls (incl. timeouts)", async () => {
    // Warm up so lazy internals (DNS-less unix socket, decoders) are settled.
    await client.ping();
    await new Promise((r) => setTimeout(r, 150));
    const before = openFdCount();

    // 50 sequential short-lived connections.
    for (let i = 0; i < 50; i++) {
      await client.ping();
    }
    // 20 concurrent short-lived connections.
    await Promise.all(Array.from({ length: 20 }, () => client.ping()));

    // 10 concurrent per-call timeouts: each must destroy its socket even
    // though herdr is still blocked waiting on a never-matching sentinel.
    const created = /** @type {any} */ (
      await client.call("workspace.create", { label: "smithers-test-fd", focus: false })
    );
    const paneId = created.root_pane.pane_id;
    const impatient = createHerdrClient({ socketPath: server.socketPath, callTimeoutMs: 150, logger: () => {} });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        impatient
          .call("pane.wait_for_output", {
            pane_id: paneId,
            source: "visible",
            match: { type: "substring", value: "SMITHERS_NEVER_MATCH_zzz" },
            timeout_ms: 30000,
          })
          .catch(() => {}),
      ),
    );
    await client.call("workspace.close", { workspace_id: created.workspace.workspace_id }).catch(() => {});

    // Give destroyed sockets a beat to release their descriptors.
    await new Promise((r) => setTimeout(r, 300));
    const after = openFdCount();
    if (before >= 0 && after >= 0) {
      // A leak would grow this by ~80 (one per un-destroyed socket); a small
      // margin absorbs unrelated churn.
      expect(after).toBeLessThanOrEqual(before + 8);
    }
  });

  test("call: unicode payloads round-trip through the socket in both directions", async () => {
    const label = "smithers-✨-λ-日本語-🚀";
    const created = /** @type {any} */ (await client.call("workspace.create", { label, focus: false }));
    expect(created.workspace.label).toBe(label);
    const workspaceId = created.workspace.workspace_id;

    const list = /** @type {any} */ (await client.call("workspace.list", {}));
    expect(list.workspaces.some((/** @type {any} */ w) => w.label === label)).toBe(true);

    await client.call("workspace.close", { workspace_id: workspaceId }).catch(() => {});
  });

  test("subscribe: a rejected subscription backs off instead of busy-looping", async () => {
    // A per-pane filter with no pane_id is rejected by herdr, which closes the
    // connection each time. With correct capped backoff the reconnect loop
    // yields only a handful of attempts across the window; a floor-interval
    // busy loop would produce far more.
    let rejects = 0;
    const c = createHerdrClient({
      socketPath: server.socketPath,
      logger: (level, message) => {
        if (level === "warn" && message.includes("subscription rejected")) {
          rejects += 1;
        }
      },
    });
    const handle = c.subscribe([{ type: "pane.agent_status_changed" }], () => {});
    try {
      await new Promise((r) => setTimeout(r, 2500));
      expect(rejects).toBeGreaterThanOrEqual(1);
      expect(rejects).toBeLessThanOrEqual(6);
    } finally {
      handle.close();
    }
  }, 10000);
});

describe("createHerdrClient error mapping + lifecycle (no server needed)", () => {
  test("call: rejects ENOENT when the socket path's directory does not exist", async () => {
    const c = createHerdrClient({
      socketPath: "/smithers-herdr-nonexistent-dir-xyz/deeper/herdr.sock",
      callTimeoutMs: 1000,
      logger: () => {},
    });
    const err = await c.call("ping").catch((e) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe("ENOENT");
  });

  test("tryCall: soft-fails to undefined against a nonexistent directory", async () => {
    let warned = false;
    const c = createHerdrClient({
      socketPath: "/smithers-herdr-nonexistent-dir-xyz/deeper/herdr.sock",
      callTimeoutMs: 1000,
      logger: (level) => {
        if (level === "warn") {
          warned = true;
        }
      },
    });
    expect(await c.tryCall("ping")).toBeUndefined();
    expect(warned).toBe(true);
  });

  test("subscribe: close() during a reconnect wait is safe, idempotent, and stops reconnection", async () => {
    // Never-connectable socket -> the subscription is perpetually in the
    // backoff/reconnect wait, exercising close() while a reconnect timer (not a
    // live socket) is pending.
    let delivered = 0;
    const c = createHerdrClient({
      socketPath: "/smithers-herdr-nonexistent-dir-xyz/deeper/herdr.sock",
      logger: () => {},
    });
    const handle = c.subscribe([{ type: "workspace.created" }], () => {
      delivered += 1;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(() => {
      handle.close();
      handle.close();
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 400));
    expect(delivered).toBe(0);
  });
});
