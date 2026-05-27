/**
 * PTY WebSocket server for Smithers Studio 2.
 *
 * Adapted from ~/gui/zmux architecture: JSON-RPC 2.0 protocol over
 * WebSocket instead of Unix socket, session lifecycle with scrollback
 * replay on attach, event broadcasting to connected clients.
 *
 * Protocol (JSON-RPC 2.0 over WebSocket text frames):
 *
 *   Client → Server requests:
 *     session.create  { shell?, cwd?, cols?, rows? }  → { sessionId, pid }
 *     session.input   { sessionId, data }             → { ok }
 *     session.resize  { sessionId, cols, rows }       → { ok }
 *     session.close   { sessionId }                   → { ok }
 *     session.list    {}                              → [ ...sessions ]
 *     daemon.ping     {}                              → { version, sessions }
 *
 *   Server → Client notifications:
 *     pane_output     { sessionId, data }
 *     session_exited  { sessionId, exitCode, signal }
 */

import * as pty from "node-pty";

const SCROLLBACK_LIMIT = 256 * 1024; // 256 KiB, matches zmux attach_replay_max_bytes
const VERSION = "0.1.0";

type Session = {
  id: string;
  pty: pty.IPty;
  scrollback: string;
  pid: number;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  exited: boolean;
  exitCode: number | null;
  signal: number | null;
};

const sessions = new Map<string, Session>();

type WsData = { id: string };

const host = process.env.PTY_SERVER_HOST ?? "127.0.0.1";
const port = parseInt(process.env.PTY_SERVER_PORT ?? "7342");

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}

function appendScrollback(session: Session, data: string) {
  session.scrollback += data;
  if (session.scrollback.length > SCROLLBACK_LIMIT) {
    session.scrollback = session.scrollback.slice(-SCROLLBACK_LIMIT);
  }
}

function nextSessionId() {
  return `ses-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function defaultShell() {
  return process.env.SHELL || "/bin/zsh";
}

function jsonRpcResult(id: unknown, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function jsonRpcNotification(method: string, params: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

const connectedClients = new Set<{ ws: { sendText(s: string): void; readyState: number } }>();

function broadcast(message: string) {
  for (const client of connectedClients) {
    try {
      client.ws.sendText(message);
    } catch {}
  }
}

function createSession(params: Record<string, unknown>): Session {
  const shell = typeof params.shell === "string" ? params.shell : defaultShell();
  const cwd = typeof params.cwd === "string" ? params.cwd : (process.env.HOME || process.cwd());
  const cols = clamp(typeof params.cols === "number" ? params.cols : 80, 1, 500);
  const rows = clamp(typeof params.rows === "number" ? params.rows : 24, 1, 200);
  const id = nextSessionId();

  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>,
  });

  const session: Session = {
    id,
    pty: ptyProcess,
    scrollback: "",
    pid: ptyProcess.pid,
    shell,
    cwd,
    cols,
    rows,
    createdAt: Date.now(),
    exited: false,
    exitCode: null,
    signal: null,
  };

  ptyProcess.onData((data) => {
    appendScrollback(session, data);
    broadcast(jsonRpcNotification("pane_output", { sessionId: session.id, data }));
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    session.exited = true;
    session.exitCode = exitCode;
    session.signal = signal;
    broadcast(jsonRpcNotification("session_exited", {
      sessionId: session.id,
      exitCode,
      signal,
    }));
  });

  sessions.set(id, session);
  return session;
}

function handleRequest(id: unknown, method: string, params: Record<string, unknown>) {
  if (method === "daemon.ping") {
    return jsonRpcResult(id, { version: VERSION, sessions: sessions.size });
  }

  if (method === "session.create") {
    try {
      const session = createSession(params);
      return jsonRpcResult(id, {
        sessionId: session.id,
        pid: session.pid,
        shell: session.shell,
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
      });
    } catch (e) {
      return jsonRpcError(id, -32000, String(e));
    }
  }

  if (method === "session.attach") {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session) return jsonRpcError(id, -32000, "session not found");
    if (typeof params.cols === "number" && typeof params.rows === "number") {
      const cols = clamp(params.cols, 1, 500);
      const rows = clamp(params.rows, 1, 200);
      if (cols !== session.cols || rows !== session.rows) {
        session.cols = cols;
        session.rows = rows;
        if (!session.exited) session.pty.resize(cols, rows);
      }
    }
    return jsonRpcResult(id, {
      sessionId: session.id,
      pid: session.pid,
      scrollback: session.scrollback,
      exited: session.exited,
      exitCode: session.exitCode,
    });
  }

  if (method === "session.input") {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    const data = typeof params.data === "string" ? params.data : "";
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session) return jsonRpcError(id, -32000, "session not found");
    if (session.exited) return jsonRpcError(id, -32000, "session has exited");
    session.pty.write(data);
    return jsonRpcResult(id, { ok: true });
  }

  if (method === "session.resize") {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session) return jsonRpcError(id, -32000, "session not found");
    if (session.exited) return jsonRpcError(id, -32000, "session has exited");
    const cols = clamp(typeof params.cols === "number" ? params.cols : session.cols, 1, 500);
    const rows = clamp(typeof params.rows === "number" ? params.rows : session.rows, 1, 200);
    session.cols = cols;
    session.rows = rows;
    session.pty.resize(cols, rows);
    return jsonRpcResult(id, { ok: true });
  }

  if (method === "session.close") {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session) return jsonRpcError(id, -32000, "session not found");
    if (!session.exited) {
      try { session.pty.kill(); } catch {}
    }
    sessions.delete(sessionId!);
    return jsonRpcResult(id, { ok: true });
  }

  if (method === "session.list") {
    const list = [...sessions.values()].map((s) => ({
      sessionId: s.id,
      pid: s.pid,
      shell: s.shell,
      cwd: s.cwd,
      cols: s.cols,
      rows: s.rows,
      exited: s.exited,
      exitCode: s.exitCode,
      createdAt: s.createdAt,
    }));
    return jsonRpcResult(id, list);
  }

  return jsonRpcError(id, -32601, "method not found");
}

Bun.serve<WsData>({
  hostname: host,
  port,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/terminal/ws") {
      const id = Math.random().toString(36).slice(2);
      if (server.upgrade(req, { data: { id } })) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      connectedClients.add({ ws: ws as any });
    },
    message(ws, raw) {
      try {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        const msg = JSON.parse(text);
        const id = msg.id ?? null;
        const method = typeof msg.method === "string" ? msg.method : "";
        const params = (typeof msg.params === "object" && msg.params !== null) ? msg.params : {};
        const response = handleRequest(id, method, params);
        ws.sendText(response);
      } catch {
        ws.sendText(jsonRpcError(null, -32700, "parse error"));
      }
    },
    close(ws) {
      for (const client of connectedClients) {
        if ((client.ws as any) === ws) {
          connectedClients.delete(client);
          break;
        }
      }
    },
  },
});

console.log(`[pty] Listening on http://${host}:${port}`);
