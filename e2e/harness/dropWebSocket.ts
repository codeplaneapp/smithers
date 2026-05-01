import type { WebSocket } from "ws";

export type DropWebSocketMode = "abrupt" | "close";

export async function dropWebSocket(
  socket: WebSocket,
  mode: DropWebSocketMode = "abrupt",
): Promise<void> {
  if (socket.readyState === socket.CLOSED) {
    return;
  }

  const closed = new Promise<void>((resolve) => {
    if (socket.readyState === socket.CLOSED) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
  });

  if (mode === "close") {
    socket.close(1000);
  } else if (typeof socket.terminate === "function") {
    // terminate() drops the TCP connection without sending a close frame, so
    // the peer must detect via timeout — exercises the reconnect-with-afterSeq path.
    socket.terminate();
  } else {
    const browserish = socket as unknown as {
      onopen: ((...args: unknown[]) => void) | null;
      onmessage: ((...args: unknown[]) => void) | null;
      onerror: ((...args: unknown[]) => void) | null;
      onclose: ((...args: unknown[]) => void) | null;
    };
    browserish.onopen = null;
    browserish.onmessage = null;
    browserish.onerror = null;
    browserish.onclose = null;
    socket.close(1006);
  }

  await closed;
}
