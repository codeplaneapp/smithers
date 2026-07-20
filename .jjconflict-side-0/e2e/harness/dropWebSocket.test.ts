import { afterEach, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { dropWebSocket } from "./dropWebSocket.ts";

type ServerHandle = {
  server: WebSocketServer;
  port: number;
  acceptedSocket: Promise<WebSocket>;
  closeEvents: Array<{ code: number; reason: string }>;
};

async function startServer(): Promise<ServerHandle> {
  const closeEvents: Array<{ code: number; reason: string }> = [];
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const acceptedSocket = new Promise<WebSocket>((resolve) => {
    server.on("connection", (ws) => {
      ws.on("close", (code, reason) => {
        closeEvents.push({ code, reason: reason.toString("utf8") });
      });
      resolve(ws);
    });
  });
  const address = server.address() as AddressInfo;
  return { server, port: address.port, acceptedSocket, closeEvents };
}

async function connectClient(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

async function waitForServerClose(handle: ServerHandle): Promise<{ code: number; reason: string }> {
  const deadline = Date.now() + 2_000;
  while (handle.closeEvents.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (handle.closeEvents.length === 0) {
    throw new Error("Server never observed close event");
  }
  return handle.closeEvents[0]!;
}

describe("dropWebSocket", () => {
  let handle: ServerHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await new Promise<void>((resolve) => handle!.server.close(() => resolve()));
      handle = undefined;
    }
  });

  test("abrupt mode terminates without close frame; server sees code 1006", async () => {
    handle = await startServer();
    const client = await connectClient(handle.port);
    await handle.acceptedSocket;

    await dropWebSocket(client, "abrupt");

    expect(client.readyState).toBe(client.CLOSED);
    const close = await waitForServerClose(handle);
    expect(close.code).toBe(1006);
  });

  test("close mode performs graceful 1000 close", async () => {
    handle = await startServer();
    const client = await connectClient(handle.port);
    await handle.acceptedSocket;

    await dropWebSocket(client, "close");

    expect(client.readyState).toBe(client.CLOSED);
    const close = await waitForServerClose(handle);
    expect(close.code).toBe(1000);
  });

  test("default mode is abrupt", async () => {
    handle = await startServer();
    const client = await connectClient(handle.port);
    await handle.acceptedSocket;

    await dropWebSocket(client);

    const close = await waitForServerClose(handle);
    expect(close.code).toBe(1006);
  });

  test("returns immediately if socket is already closed", async () => {
    handle = await startServer();
    const client = await connectClient(handle.port);
    await handle.acceptedSocket;
    await dropWebSocket(client, "close");
    await dropWebSocket(client, "close");
    expect(client.readyState).toBe(client.CLOSED);
  });
});
