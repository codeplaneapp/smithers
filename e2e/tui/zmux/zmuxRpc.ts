import type { ZmuxClient } from "./zmuxClient.ts";

export type CreateSessionOptions = {
  /** Shell string (execvpe(shell, [shell, "-l", "-c", command])), not argv. Omit for an interactive shell. */
  command?: string;
  cwd?: string;
  /** REPLACES the entire child environment (no merge); zmux never sets TERM. Pass a complete env or omit to inherit the daemon's. */
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
  /** Aliases the pane TITLE for `session.create` only; it is never a caller-supplied session id. */
  title?: string;
};

export type CreatedSession = {
  /** The `pane-N-<hex>` id returned by the daemon; route every subsequent call through this. */
  paneId: string;
  pid: number;
};

/** `session.create`: boot a pane running `command` (or an interactive shell) at a fixed geometry. */
export async function createSession(client: ZmuxClient, options: CreateSessionOptions = {}): Promise<CreatedSession> {
  const result = await client.request("session.create", {
    rows: options.rows ?? 24,
    cols: options.cols ?? 80,
    ...(options.command !== undefined ? { command: options.command } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.title !== undefined ? { id: options.title } : {}),
  });
  return { paneId: result.id as string, pid: result.pid as number };
}

/** `session.capture`: the raw PTY byte tail (ANSI intact), `lines` counted backwards from the end. No VT grid. */
export async function capture(client: ZmuxClient, paneId: string, lines = 200): Promise<string> {
  const result = await client.request("session.capture", { sessionId: paneId, lines });
  return result.text as string;
}

/** `session.send`: type `text`; `enter: true` appends `"\r"` (not `\n`). */
export async function sendText(client: ZmuxClient, paneId: string, text: string, enter = false): Promise<void> {
  await client.request("session.send", { sessionId: paneId, text, enter });
}

/** `session.sendKey`: named keys only (`C-<letter>`, Enter, Tab, Escape, arrows, ...); unknown key -> -32602. */
export async function sendKey(client: ZmuxClient, paneId: string, key: string): Promise<void> {
  await client.request("session.sendKey", { sessionId: paneId, key });
}

/** `session.resize`: always pass both explicitly (missing values default to 80x24, silently). */
export async function resize(client: ZmuxClient, paneId: string, rows: number, cols: number): Promise<void> {
  await client.request("session.resize", { sessionId: paneId, rows, cols });
}

/** `session.terminate`: kill the pane's child and free the session. */
export async function terminateSession(client: ZmuxClient, paneId: string): Promise<void> {
  await client.request("session.terminate", { sessionId: paneId });
}
