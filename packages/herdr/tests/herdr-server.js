import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// Surfaces read process.env for dock mode. Isolate the test runner process from
// a parent herdr TUI (HERDR_ENV=1) so labeled workspaces are created instead of
// docking into the operator pane. Opt out with SMITHERS_HERDR_TEST_INHERIT_ENV=1.
if (process.env.SMITHERS_HERDR_TEST_INHERIT_ENV !== "1") {
  process.env.HERDR_ENV = "0";
  process.env.SMITHERS_HERDR_DOCK = "0";
  delete process.env.HERDR_WORKSPACE_ID;
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_TAB_ID;
}

/**
 * Whether the `herdr` binary is on PATH. Tests that need a real server gate on
 * this via `describe.skipIf(!isHerdrInstalled())` so CI (no herdr) stays green.
 *
 * @returns {boolean}
 */
export function isHerdrInstalled() {
  try {
    execSync("which herdr", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * A throwaway session name. Always prefixed `smithers-test-` so it can never be
 * confused with the `smithers-dev` or default sessions.
 *
 * @returns {string}
 */
export function randomSessionName() {
  return `smithers-test-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {string} name
 * @returns {string}
 */
function sessionSocket(name) {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config");
  return join(base, "herdr", "sessions", name, "herdr.sock");
}

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @param {number} intervalMs
 * @returns {Promise<boolean>}
 */
async function waitUntil(predicate, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

/**
 * Resolve true if a `ping` over the socket gets any response frame within
 * `timeoutMs` - i.e. a server is actually listening and answering (not just a
 * stale socket file left behind by a stopped server).
 *
 * @param {string} socketPath
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function pingOnce(socketPath, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let done = false;
    const finish = (ok) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    socket.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    socket.on("data", () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: "ready-probe", method: "ping", params: {} })}\n`);
    });
  });
}

/**
 * @param {string} socketPath
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForServerReady(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath) && (await pingOnce(socketPath))) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Spawn a throwaway headless herdr server bound to a fresh named session.
 *
 * The returned handle NEVER touches the `smithers-dev` or default sessions. The
 * caller MUST `dispose()` it in `afterAll`/`finally` - that stops the session,
 * hard-kills the spawned process, and deletes the session directory so no
 * sockets or processes leak. `stopServer()`/`restart()` support the reconnect
 * test (stop the process but keep the session name reusable).
 *
 * @param {string} [session]
 */
export async function startHerdrServer(session = randomSessionName()) {
  const socketPath = sessionSocket(session);
  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;

  async function spawnServer() {
    // Prefer explicit --session (herdr 0.7+); HERDR_SESSION alone may attach to
    // the default session and exit "already running" when another server is up.
    const proc = spawn("herdr", ["server", "--session", session], {
      env: {
        ...process.env,
        HERDR_SESSION: session,
        // Isolate from a parent herdr TUI: HERDR_ENV=1 would make surfaces
        // dock into the operator pane instead of creating labeled workspaces.
        HERDR_ENV: "0",
        SMITHERS_HERDR_DOCK: "0",
        HERDR_WORKSPACE_ID: "",
        HERDR_PANE_ID: "",
        HERDR_TAB_ID: "",
      },
      stdio: "ignore",
    });
    child = proc;
    proc.unref();
    const up = await waitForServerReady(socketPath, 10000);
    if (!up) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      throw new Error(`herdr server for session ${session} never became ready at ${socketPath}`);
    }
    return proc;
  }

  async function killChild() {
    const proc = child;
    child = null;
    if (!proc) {
      return;
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 200));
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  }

  async function stopServer() {
    try {
      execSync(`herdr session stop ${session}`, { stdio: "pipe" });
    } catch {
      // server may already be down
    }
    await killChild();
    await waitUntil(() => !existsSync(socketPath), 3000);
  }

  await spawnServer();

  return {
    session,
    socketPath,
    get pid() {
      return child?.pid;
    },
    /** Stop the server process but keep the session name reusable via `restart()`. */
    stopServer,
    /** Start a fresh server for the SAME session name (same socket path). */
    async restart() {
      await spawnServer();
    },
    /** Stop the server, kill the process, and delete the session directory. */
    async dispose() {
      await stopServer();
      try {
        execSync(`herdr session delete ${session}`, { stdio: "pipe" });
      } catch {
        // ignore
      }
    },
  };
}
