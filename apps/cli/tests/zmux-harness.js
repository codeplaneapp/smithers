// Shared harness for the `smithers tui` real-PTY e2e tests driven through zmux
// (github.com/smithersai/zmux). These tests spawn the zmux daemon (`zmuxd`),
// run `smithers tui` inside a real PTY pane, drive the clack prompts with raw
// key bytes, and reconstruct the visible terminal grid with a tiny VT emulator
// so assertions run against what a human actually sees.
//
// The daemon binary is not present on the clean CI box by default, so every
// caller MUST gate on `resolveZmuxd()` returning a non-null path and skip when
// it is null (CI without the binary stays green).
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
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
    await client.ready;

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
        if (ch === "\x1b" && bytes[i + 1] === "[") {
            let j = i + 2;
            let params = "";
            while (j < bytes.length && /[0-9;?]/.test(bytes[j])) {
                params += bytes[j];
                j += 1;
            }
            const final = bytes[j];
            const privateSeq = params.startsWith("?");
            const nums = params.replace("?", "").split(";").map((value) => (value === "" ? undefined : Number.parseInt(value, 10)));
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
                }
                // 'm' (SGR colors) and others: ignore
            }
            i = j + 1;
            continue;
        }
        if (ch === "\x1b") {
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
