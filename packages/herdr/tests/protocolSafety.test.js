import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrClient } from "../src/createHerdrClient.js";
import { HerdrError } from "../src/HerdrError.js";
import { DEFAULT_MAX_NDJSON_FRAME_BYTES } from "../src/ndjson.js";

/** @type {Array<() => Promise<void>>} */
const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/**
 * @param {(socket: import("node:net").Socket) => void} respond
 */
async function startFakeHerdr(respond) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-protocol-test-"));
  const socketPath = join(dir, "herdr.sock");
  /** @type {import("node:net").Socket[]} */
  const sockets = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.once("data", () => respond(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(undefined));
  });
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    rmSync(dir, { recursive: true, force: true });
  });
  return socketPath;
}

describe.skipIf(process.platform === "win32")("createHerdrClient protocol safety (fake socket server)", () => {
  test("strict ping exposes a protocol mismatch while default ping remains inspectable", async () => {
    const socketPath = await startFakeHerdr((socket) => {
      socket.end(`${JSON.stringify({ id: "fake", result: { type: "pong", version: "future", protocol: 999 } })}\n`);
    });
    /** @type {string[]} */
    const warnings = [];
    const client = createHerdrClient({
      socketPath,
      logger: (level, message) => {
        if (level === "warn") warnings.push(message);
      },
    });

    const inspectable = await client.ping();
    expect(inspectable?.protocol).toBe(999);
    expect(warnings.some((message) => message.includes("client expects 16") && message.includes("999"))).toBe(true);

    const error = await client.ping({ requireProtocolMatch: true }).catch((cause) => cause);
    expect(error).toBeInstanceOf(HerdrError);
    expect(error).toMatchObject({ method: "ping", code: "protocol_mismatch" });
    expect(error.cause).toMatchObject({ protocol: 999, version: "future" });
  });

  test("rejects and closes a newline-free response once its frame bound is exceeded", async () => {
    let peerClosed = false;
    const socketPath = await startFakeHerdr((socket) => {
      socket.on("close", () => {
        peerClosed = true;
      });
      socket.write(Buffer.alloc(DEFAULT_MAX_NDJSON_FRAME_BYTES + 1, 0x78));
    });
    const client = createHerdrClient({ socketPath, callTimeoutMs: 5000, logger: () => {} });

    const error = await client.call("ping").catch((cause) => cause);
    expect(error).toBeInstanceOf(HerdrError);
    expect(error).toMatchObject({ method: "ping", code: "frame_too_large" });
    await Bun.sleep(50);
    expect(peerClosed).toBe(true);
  });
});
