// Per-attempt Unix-domain-socket server the engine owns so a CLI agent's
// PostToolUse hook (running `smithers snapshot-hook`) can request a strict Tier 1
// snapshot at a real tool boundary. One request per connection: client writes a
// JSON line then half-closes; the server runs onHook and writes a JSON ack.
//
// Only created when durability is active (flag on + jj repo), so it adds nothing
// to the default spawn path. Best-effort: socket/server errors are swallowed.

import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let counter = 0;

/**
 * Windows has no filesystem Unix-domain sockets; `net` there speaks named pipes,
 * which live in the `\\.\pipe\` namespace rather than on disk. Detecting this
 * lets the path generator and the (un)link cleanup branch correctly.
 */
const IS_WINDOWS = process.platform === "win32";

/**
 * A short, collision-free local-IPC endpoint for the engine ↔ snapshot-hook
 * channel. On POSIX this is a Unix-domain socket file under tmpdir (kept well
 * under the ~104-char limit by not embedding the run/node ids). On Windows it
 * is a named pipe under `\\.\pipe\`, which `net.listen`/`net.connect` accept in
 * place of a path.
 * @returns {string}
 */
export function nextSnapshotSocketPath() {
  counter += 1;
  const name = `sm-snap-${process.pid.toString(36)}-${counter.toString(36)}`;
  if (IS_WINDOWS) {
    return `\\\\.\\pipe\\${name}`;
  }
  return path.join(os.tmpdir(), `${name}.sock`);
}

/**
 * @param {{ socketPath: string, onHook: (payload: Record<string, any>) => Promise<{ ok: boolean, seq?: number, error?: string }> }} opts
 * @returns {Promise<{ socketPath: string, close: () => void }>}
 */
export function createSnapshotServer(opts) {
  const { socketPath, onHook } = opts;
  // Named pipes are not filesystem entries, so unlink is meaningless there.
  if (!IS_WINDOWS) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* not there yet */
    }
  }

  // Newline-framed request/response (no half-close): client writes one JSON
  // line, server replies with one JSON line, client closes. Avoids the
  // half-open handshake races entirely.
  const server = net.createServer((socket) => {
    let buf = "";
    let done = false;
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      if (done) return;
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      done = true;
      const line = buf.slice(0, nl);
      let payload = {};
      try {
        payload = JSON.parse(line || "{}");
      } catch {
        payload = {};
      }
      let result;
      try {
        result = await onHook(payload);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      try {
        socket.write(`${JSON.stringify(result ?? { ok: true })}\n`);
      } catch {
        /* client already gone */
      }
    });
  });
  server.on("error", () => {});

  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        close() {
          try {
            server.close();
          } catch {
            /* already closed */
          }
          if (!IS_WINDOWS) {
            try {
              fs.unlinkSync(socketPath);
            } catch {
              /* already gone */
            }
          }
        },
      });
    });
    server.on("error", () => resolve({ socketPath, close() {} }));
  });
}
