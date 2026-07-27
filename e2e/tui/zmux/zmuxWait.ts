import { connect } from "node:net";
import type { ZmuxClient } from "./zmuxClient.ts";
import { capture } from "./zmuxRpc.ts";

export class CaptureTimeoutError extends Error {
  constructor(paneId: string, needle: string, tail: string) {
    super(`zmux pane ${paneId} did not show ${JSON.stringify(needle)} within the deadline.\n--- capture tail ---\n${tail}`);
    this.name = "CaptureTimeoutError";
  }
}

/** Poll `session.capture` every ~50ms until its text contains `needle` (substring or RegExp test). */
export async function waitForCaptureContains(
  client: ZmuxClient,
  paneId: string,
  needle: string | RegExp,
  timeoutMs = 8000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() < deadline) {
    lastText = await capture(client, paneId);
    const matched = typeof needle === "string" ? lastText.includes(needle) : needle.test(lastText);
    if (matched) return lastText;
    await Bun.sleep(50);
  }
  throw new CaptureTimeoutError(paneId, String(needle), lastText);
}

export type SessionExitedNotification = {
  session_id: string;
  pid: number;
  exit_code: number | null;
  signal: number | null;
};

/** Wait for a `session_exited` notification whose `session_id` matches `paneId`. */
export async function waitForSessionExited(
  client: ZmuxClient,
  paneId: string,
  options: { expectExitCode?: number; timeoutMs?: number } = {},
): Promise<SessionExitedNotification> {
  const timeoutMs = options.timeoutMs ?? 8000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`zmux pane ${paneId} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = client.onNotification((notification) => {
      const params = (notification.params ?? {}) as Partial<SessionExitedNotification>;
      if (params.session_id !== paneId) return;
      clearTimeout(timer);
      unsubscribe();
      if (options.expectExitCode !== undefined && params.exit_code !== options.expectExitCode) {
        reject(
          new Error(`zmux pane ${paneId} exited with code ${params.exit_code}, expected ${options.expectExitCode}`),
        );
        return;
      }
      resolve(params as SessionExitedNotification);
    }, "session_exited");
  });
}

/** Poll-connect until a unix socket accepts connections (used after spawning zmuxd). */
export async function waitForSocket(socketPath: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connect({ path: socketPath });
      const done = (ok: boolean, error?: unknown) => {
        lastError = error;
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => done(true));
      socket.once("error", (error) => done(false, error));
    });
    if (connected) return;
    await Bun.sleep(10);
  }
  throw new Error(`zmux socket ${socketPath} did not accept connections within ${timeoutMs}ms: ${String(lastError)}`);
}
