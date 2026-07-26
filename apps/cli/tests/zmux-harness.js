// Shared harness for the interactive run flow (`smithers up --interactive`)
// real-PTY e2e tests driven through zmux (github.com/smithersai/zmux). These
// tests spawn the zmux daemon (`zmuxd`), run `smithers up --interactive` inside
// a real PTY pane, drive the clack prompts with raw key bytes, and reconstruct
// the visible terminal grid with a tiny VT emulator
// so assertions run against what a human actually sees.
//
// The daemon binary is not present on the clean CI box by default, so every
// caller MUST gate on `resolveZmuxd()` returning a non-null path and skip when
// it is null (CI without the binary stays green).
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the smithers repo root (three levels up from tests/). */
export const REPO_ROOT = resolve(TEST_DIR, "../../..");

/** Raw key byte sequences for driving clack prompts over the PTY. */
export const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  enter: "\r",
  ctrlC: "\x03",
  ctrlU: "\x15",
  bs: "\x7f",
};

/** Base64-encode binary key data for the `session.send` RPC. */
export const b64 = (s) => Buffer.from(s, "binary").toString("base64");

/** Small async sleep helper. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve the absolute path to the `zmuxd` daemon binary, or `null` when it is
 * not installed. Prefers the explicit `ZMUXD` env var (set in CI after the
 * release download), then falls back to the conventional `~/zmux` checkout.
 * Returns `null` (never throws) so callers can skip cleanly.
 */
export function resolveZmuxd() {
  const fromEnv = process.env.ZMUXD;
  if (fromEnv && existsSync(fromEnv)) return resolve(fromEnv);
  const fromHome = resolve(process.env.HOME ?? "", "zmux/zig-out/bin/zmuxd");
  if (existsSync(fromHome)) return fromHome;
  return null;
}

/**
 * Connect a newline-delimited JSON-RPC client to the zmux daemon's UNIX socket.
 * Returns `{ sock, ready, rpc }`; `ready` resolves once connected and `rpc`
 * issues a request that rejects on a 5s timeout or a JSON-RPC error.
 */
export function connectRpc(path) {
  const sock = net.createConnection({ path });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  sock.setEncoding("utf8");
  sock.on("error", () => {});
  sock.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id != null && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      }
      // notifications (pane_output, etc.) are ignored
    }
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    sock.once("connect", resolveReady);
    sock.once("error", rejectReady);
  });
  return {
    sock,
    ready,
    rpc(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolveRpc, rejectRpc) => {
        const timeout = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          rejectRpc(new Error(`timeout: ${method}`));
        }, 5_000);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timeout);
            resolveRpc(value);
          },
          reject(error) {
            clearTimeout(timeout);
            rejectRpc(error);
          },
        });
        sock.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
  };
}

/**
 * Spawn `zmuxd` on a fresh per-call socket and connect an RPC client to it.
 * Returns `{ daemon, sock, rpc, sockPath, stop }`. `stop()` shuts the daemon
 * down, closes the socket, and removes the socket file — call it in `finally`.
 *
 * @param {string} zmuxd absolute path to the daemon (from `resolveZmuxd()`)
 * @param {{ prefix?: string, idleSeconds?: number }} [opts]
 */
export async function startDaemon(zmuxd, opts = {}) {
  const { prefix = "zmx-smithers-tui", idleSeconds = 120 } = opts;
  const sockPath = `/tmp/${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.sock`;
  const daemon = spawn(zmuxd, ["--socket", sockPath, "--idle-seconds", String(idleSeconds)], {
    stdio: "ignore",
    env: process.env,
  });

  for (let i = 0; i < 50 && !existsSync(sockPath); i += 1) {
    await sleep(100);
  }
  if (!existsSync(sockPath)) {
    daemon.kill("SIGTERM");
    throw new Error("zmuxd socket never appeared");
  }

  const client = connectRpc(sockPath);
  try {
    await client.ready;
  } catch (error) {
    // The socket file appeared but the connect failed (daemon died between
    // bind and accept, permissions, …): without this reap the spawned zmuxd
    // outlives the test run as a stray daemon.
    daemon.kill("SIGTERM");
    try {
      rmSync(sockPath, { force: true });
    } catch {}
    throw error;
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await client.rpc("daemon.shutdown", {});
    } catch {}
    try {
      client.sock.end();
    } catch {}
    daemon.kill("SIGTERM");
    try {
      rmSync(sockPath, { force: true });
    } catch {}
  };

  return { daemon, sock: client.sock, rpc: client.rpc, sockPath, stop };
}

/**
 * Minimal VT emulator: replay a raw PTY byte stream into a visible character
 * grid. Faithfully reproduces line-wrap + scroll, so a clack redraw that
 * under-counts wrapped lines leaves ghost rows in the grid exactly as on a real
 * terminal. Returns the visible rows (trailing blanks trimmed).
 */
export function emulate(bytes, cols = 80, rows = 24) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let row = 0;
  let col = 0;
  const scroll = () => {
    grid.shift();
    grid.push(Array(cols).fill(" "));
  };
  const clampRow = () => {
    while (row >= rows) {
      scroll();
      row -= 1;
    }
    if (row < 0) row = 0;
  };

  for (let i = 0; i < bytes.length;) {
    const ch = bytes[i];
    // OSC (]) / DCS (P) / APC (_) / PM (^) string sequences: consumed whole
    // (terminated by BEL or ST = ESC \). opentui emits OSC for the window
    // title and kitty-keyboard APC probes; spilling their payload bytes into
    // the grid would corrupt every full-screen-monitor assertion.
    if (
      ch === "\x1b" &&
      (bytes[i + 1] === "]" || bytes[i + 1] === "P" || bytes[i + 1] === "_" || bytes[i + 1] === "^")
    ) {
      let j = i + 2;
      while (j < bytes.length) {
        if (bytes[j] === "\x07") {
          j += 1;
          break;
        }
        if (bytes[j] === "\x1b" && bytes[j + 1] === "\\") {
          j += 2;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === "\x1b" && bytes[i + 1] === "[") {
      let j = i + 2;
      let params = "";
      // CSI parameter/intermediate bytes: digits + separators, the private
      // markers (? > = <), and intermediate space..slash. opentui emits
      // sequences like CSI > 4;2 m (modifyOtherKeys) and CSI = c — without
      // accepting their prefix bytes here, the loop stopped at the prefix
      // and spilled the rest of the sequence into the visible grid.
      while (j < bytes.length && /[0-9;:?><= !"#$%&'()*+,\-./]/.test(bytes[j])) {
        params += bytes[j];
        j += 1;
      }
      const final = bytes[j];
      const privateSeq = /[?><=]/.test(params);
      const nums = params
        .replace(/[?><=]/g, "")
        .split(";")
        .map((value) => (value === "" ? undefined : Number.parseInt(value, 10)));
      const n = nums[0];
      if (!privateSeq) {
        if (final === "A") {
          row -= n || 1;
          clampRow();
        } else if (final === "B") {
          row += n || 1;
          clampRow();
        } else if (final === "C") {
          col = Math.min(cols - 1, col + (n || 1));
        } else if (final === "D") {
          col = Math.max(0, col - (n || 1));
        } else if (final === "G") {
          col = Math.max(0, (n || 1) - 1);
        } else if (final === "H" || final === "f") {
          row = (nums[0] || 1) - 1;
          col = (nums[1] || 1) - 1;
          clampRow();
          if (col < 0) col = 0;
        } else if (final === "J") {
          const mode = n || 0;
          if (mode === 0 || mode === 2) {
            for (let r = row; r < rows; r += 1) {
              for (let c = r === row ? col : 0; c < cols; c += 1) grid[r][c] = " ";
            }
          }
          if (mode === 1 || mode === 2) {
            for (let r = 0; r <= row; r += 1) {
              for (let c = 0; c < (r === row ? col + 1 : cols); c += 1) grid[r][c] = " ";
            }
          }
        } else if (final === "K") {
          const mode = n || 0;
          if (mode === 0) {
            for (let c = col; c < cols; c += 1) grid[row][c] = " ";
          } else if (mode === 1) {
            for (let c = 0; c <= col; c += 1) grid[row][c] = " ";
          } else {
            for (let c = 0; c < cols; c += 1) grid[row][c] = " ";
          }
        } else if (final === "X") {
          // ECH — erase n characters at the cursor (opentui clears
          // dismissed overlay regions this way; without it their text
          // ghosts in the grid forever).
          for (let c = col; c < Math.min(cols, col + (n || 1)); c += 1) grid[row][c] = " ";
        } else if (final === "P") {
          // DCH — delete n characters, shifting the remainder left.
          const count = Math.min(n || 1, cols - col);
          grid[row].splice(col, count);
          grid[row].push(...Array(count).fill(" "));
        } else if (final === "@") {
          // ICH — insert n blanks at the cursor, shifting right.
          const count = Math.min(n || 1, cols - col);
          grid[row].splice(col, 0, ...Array(count).fill(" "));
          grid[row].length = cols;
        }
        // 'm' (SGR colors) and others: ignore
      }
      i = j + 1;
      continue;
    }
    if (ch === "\x1b") {
      // Two-character escapes (ESC 7/8 cursor save/restore, ESC =/> keypad
      // modes, ESC M reverse index, …): consume the final byte too, or it
      // spills into the grid as a printable character.
      if (i + 1 < bytes.length && /[0-9A-Za-z=><~}|]/.test(bytes[i + 1])) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "\r") {
      col = 0;
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row += 1;
      clampRow();
      i += 1;
      continue;
    }
    if (ch === "\b") {
      if (col > 0) col -= 1;
      i += 1;
      continue;
    }
    if (ch === "\t") {
      col = Math.min(cols - 1, (Math.floor(col / 8) + 1) * 8);
      i += 1;
      continue;
    }
    if (ch < " ") {
      i += 1;
      continue;
    }
    if (col >= cols) {
      col = 0;
      row += 1;
      clampRow();
    }
    grid[row][col] = ch;
    col += 1;
    i += 1;
  }

  return grid.map((line) => line.join("").replace(/\s+$/, ""));
}

/** Rows in a rendered grid that contain the clack active-option bullet. */
export function activeRows(grid) {
  return grid.filter((line) => line.includes("●"));
}

/** The trimmed label text of the first active (highlighted) option row. */
export function activeLabel(grid) {
  return (activeRows(grid)[0] ?? "").replace(/[│●]/g, "").trim();
}

/**
 * Per-test gateway isolation. `smithers gateway` is a per-workspace SINGLETON
 * keyed by a runtime state file under SMITHERS_GATEWAY_STATE_DIR: without
 * isolation, a live singleton on the developer's machine makes every
 * test-spawned `gateway --port <freeport>` exit GATEWAY_ALREADY_RUNNING, and
 * conversely test CLI calls would spawn a real workspace singleton that leaks
 * past the test. A fresh state dir per test gives the pane (and every helper
 * CLI call) its own singleton world on the test's port.
 *
 * Returns `{ pane, env, cleanup }`: `pane` is the `env … <cmd>` prefix for the
 * zmux `session.create` command string, `env` is for helper child processes
 * (see {@link cancelRunId}), and `cleanup` removes the state dir.
 */
export function isolatedGatewayEnv(gatewayPort) {
  const stateDir = `/tmp/zmx-gwstate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return {
    stateDir,
    pane: `env SMITHERS_GATEWAY_PORT=${gatewayPort} SMITHERS_GATEWAY_STATE_DIR=${stateDir} `,
    env: {
      ...process.env,
      SMITHERS_GATEWAY_PORT: String(gatewayPort),
      SMITHERS_GATEWAY_STATE_DIR: stateDir,
    },
    cleanup: () => {
      try {
        rmSync(stateDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** Allocate a free loopback TCP port so each test gets an isolated gateway. */
export async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (typeof port === "number") resolvePort(port);
        else reject(new Error("could not allocate free port"));
      });
    });
  });
}

/** Race a promise against a timeout (rejects with a labelled error). */
export async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`zmux rpc timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** POST a gateway v1 RPC over HTTP; resolves null on any failure. */
export async function gatewayRpc(gatewayPort, method, params, timeoutMs = 1_500) {
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  }
}

/**
 * Best-effort SIGTERM of the gateway the monitor autostarted on `port` (the
 * monitor leaves it running by design so later attachments are instant; tests
 * must reap it or every run leaks a gateway process). Matches on
 * `gateway … --port <port>` rather than one exact argv spelling, verifies the
 * pids actually die, and escalates to SIGKILL for any that survive the grace
 * window.
 */
export async function stopGatewayPort(port) {
  try {
    const findPids = async () => {
      const proc = Bun.spawn(["ps", "-ef"], { stdout: "pipe", stderr: "ignore" });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      const pids = [];
      for (const line of output.split("\n")) {
        if (!/apps\/cli\/src\/index\.js\s+gateway\b/.test(line)) continue;
        if (!new RegExp(`--port\\s+${port}\\b`).test(line)) continue;
        const pid = Number(line.trim().split(/\s+/)[1]);
        if (Number.isFinite(pid) && pid > 0) pids.push(pid);
      }
      return pids;
    };
    const pids = await findPids();
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    if (pids.length === 0) return;
    for (let i = 0; i < 20; i += 1) {
      await sleep(250);
      if ((await findPids()).length === 0) return;
    }
    for (const pid of await findPids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  } catch {
    // best-effort cleanup only
  }
}

/** First `run-…` id visible in a rendered grid, or null. */
export function runIdFromGrid(grid) {
  const match = grid.join("\n").match(/\brun-[a-z0-9]+\b/i);
  return match?.[0] ?? null;
}

/**
 * Cancel a run started by a test. Tries the gateway `cancelRun` RPC first
 * (works while the detached engine is attached and live), then falls back to
 * `smithers cancel <runId>`: a PARKED run — e.g. waiting-approval after its
 * detached engine persisted state and exited — is not "active" to the gateway,
 * so the RPC alone returns RUN_NOT_ACTIVE and the run would leak forever in
 * the workspace DB as waiting-approval.
 */
export async function cancelRunId(runId, gatewayPort, env = process.env) {
  if (!runId) return;
  const frame = await gatewayRpc(gatewayPort, "cancelRun", { runId });
  if (frame && frame.type === "res" && frame.ok) return;
  await new Promise((resolveExit) => {
    // Thread the test's isolated gateway env through: with the caller's
    // SMITHERS_GATEWAY_STATE_DIR this CLI call reuses the test gateway
    // instead of spawning a REAL workspace singleton that leaks past the
    // test (and then blocks every later autostart with ALREADY_RUNNING).
    const child = spawn("bun", ["apps/cli/src/index.js", "cancel", runId], {
      cwd: REPO_ROOT,
      stdio: "ignore",
      env,
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolveExit();
    }, 15_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

/** Cancel whichever run id is visible in `grid` (see {@link cancelRunId}). */
export async function cancelVisibleRun(grid, gatewayPort) {
  await cancelRunId(runIdFromGrid(grid), gatewayPort);
}

/**
 * Authoritatively cancel the newest run of `workflowName` started at/after
 * `sinceMs`, resolved via the gateway's `listRuns` (NOT the rendered grid — if
 * the monitor never rendered, the grid has no run id and a grid-based cancel
 * silently leaks the parked run into the workspace store). For `finally`
 * blocks: never throws, and falls back to `smithers cancel` for parked runs
 * the gateway reports as not-active.
 */
export async function cancelLatestRun(workflowName, sinceMs, gatewayPort, env = process.env) {
  try {
    // Generous timeout: a workspace-scale gateway can take seconds to
    // answer listRuns, and a timed-out cleanup call silently leaks the run.
    const frame = await gatewayRpc(gatewayPort, "listRuns", { limit: 50 }, 8_000);
    if (!frame || frame.type !== "res" || !frame.ok || !Array.isArray(frame.payload)) return;
    const run = frame.payload
      .filter((r) => r.workflowName === workflowName && r.createdAtMs >= sinceMs)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
    const status = run?.status ?? "";
    if (!run || status === "finished" || status === "failed" || status === "cancelled" || status === "succeeded")
      return;
    await cancelRunId(run.runId ?? run.id, gatewayPort, env);
  } catch {
    // best-effort cleanup only
  }
}

/**
 * Pick a workflow in the TUI picker by TYPING to fuzzy-filter (the picker is a
 * fuzzy select). Far more robust under load than arrowing against a laggy grid:
 * the typed text narrows the list so the match rises to the top. Returns true
 * once the active row matches.
 */
export async function navigateToWorkflow(send, grid, filterText, matchRe) {
  let g = [];
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    g = await grid();
    if (g.some((line) => /Select a workflow/.test(line))) break;
  }
  await send(filterText);
  for (let i = 0; i < 80; i += 1) {
    g = await grid();
    if (matchRe.test(activeLabel(g))) return true;
    await sleep(200);
  }
  return false;
}

/**
 * Dead-tolerant pane driver over a zmux session. The monitor process exits
 * when its run finishes (closing the PTY), after which capture/send error with
 * InputOutput — treat that as "session ended", not a crash: `grid()` keeps
 * returning the last good frame and `send()` becomes a no-op.
 */
export function paneDriver(rpc, sessionId, { cols, rows }) {
  let dead = false;
  let last = [];
  return {
    isDead: () => dead,
    grid: async () => {
      if (dead) return last;
      try {
        const captured = await withTimeout(rpc("session.capture", { sessionId, lines: 600 }), 2_000);
        last = emulate(captured.text, cols, rows);
      } catch {
        dead = true;
      }
      return last;
    },
    send: async (keys) => {
      if (dead) return;
      try {
        await withTimeout(rpc("session.send", { sessionId, dataBase64: b64(keys) }), 1_000);
      } catch {
        dead = true;
      }
    },
  };
}
