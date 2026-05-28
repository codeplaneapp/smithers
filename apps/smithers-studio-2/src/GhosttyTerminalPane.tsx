import { GhosttyCore } from "@wterm/ghostty";
import { Terminal, useTerminal } from "@wterm/react";
import { use, useCallback, useEffect, useRef, useState } from "react";

type TerminalTab = { id: string; title: string; createdAt: Date };

type CoreResult =
  | { ok: true; core: Awaited<ReturnType<typeof GhosttyCore.load>> }
  | { ok: false; error: string };

const corePromise: Promise<CoreResult> = GhosttyCore.load({
  scrollbackLimit: 4_000,
})
  .then((core): CoreResult => ({ ok: true, core }))
  .catch(
    (error): CoreResult => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

let rpcIdCounter = 0;

type RpcCallbacks = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

function usePtySession(tabId: string, write: (data: string) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pendingRef = useRef<Map<number, RpcCallbacks>>(new Map());
  const [status, setStatus] = useState<
    "connecting" | "creating" | "attached" | "exited" | "error"
  >("connecting");

  const rpcCall = useCallback(
    (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("not connected"));
      }
      const id = ++rpcIdCounter;
      return new Promise((resolve, reject) => {
        pendingRef.current.set(id, { resolve, reject });
        ws.send(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        );
      });
    },
    [],
  );

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${protocol}//${location.host}/terminal/ws`,
    );
    wsRef.current = ws;

    ws.onopen = async () => {
      setStatus("creating");
      try {
        const result = (await rpcCall("session.create", {
          cols: 80,
          rows: 24,
        })) as { sessionId: string; scrollback?: string };
        sessionIdRef.current = result.sessionId;
        if (result.scrollback) write(result.scrollback);
        setStatus("attached");
      } catch {
        setStatus("error");
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if ("id" in msg && msg.id != null) {
          const cb = pendingRef.current.get(msg.id);
          if (cb) {
            pendingRef.current.delete(msg.id);
            if (msg.error) {
              cb.reject(new Error(msg.error.message));
            } else {
              cb.resolve(msg.result);
            }
          }
          return;
        }

        if (msg.method === "pane_output") {
          if (msg.params.sessionId === sessionIdRef.current) {
            write(msg.params.data);
          }
        } else if (msg.method === "session_exited") {
          if (msg.params.sessionId === sessionIdRef.current) {
            const code = msg.params.exitCode ?? "unknown";
            write(
              `\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`,
            );
            setStatus("exited");
          }
        }
      } catch {}
    };

    ws.onclose = () => {
      for (const cb of pendingRef.current.values()) {
        cb.reject(new Error("connection closed"));
      }
      pendingRef.current.clear();
    };

    ws.onerror = () => setStatus("error");

    return () => {
      const sid = sessionIdRef.current;
      if (sid && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "session.close",
            params: { sessionId: sid },
          }),
        );
      }
      ws.close();
      wsRef.current = null;
      sessionIdRef.current = null;
      for (const cb of pendingRef.current.values()) {
        cb.reject(new Error("terminal unmounted"));
      }
      pendingRef.current.clear();
    };
  }, [tabId, write, rpcCall]);

  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current;
    const sid = sessionIdRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !sid) return;
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session.input",
        params: { sessionId: sid, data },
      }),
    );
  }, []);

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      rpcCall("session.resize", { sessionId: sid, cols, rows }).catch(
        () => {},
      );
    },
    [rpcCall],
  );

  return { status, sendInput, sendResize };
}

export function GhosttyTerminalPane({
  active,
  tab,
}: {
  active: boolean;
  tab: TerminalTab;
}) {
  const { ref, write } = useTerminal();
  const result = use(corePromise);
  const { status, sendInput, sendResize } = usePtySession(tab.id, write);

  const handleData = useCallback(
    (data: string) => {
      if (!active) return;
      sendInput(data);
    },
    [active, sendInput],
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      sendResize(cols, rows);
    },
    [sendResize],
  );

  if (!result.ok) {
    return (
      <div
        aria-hidden={!active}
        className={`terminal-pane ${active ? "active" : ""}`}
      >
        <div className="terminal-loading">
          Ghostty unavailable: {result.error}
        </div>
      </div>
    );
  }

  return (
    <div
      aria-hidden={!active}
      className={`terminal-pane ${active ? "active" : ""}`}
    >
      {status === "error" && (
        <div className="terminal-status" data-testid="terminal-status">
          PTY server unavailable — start with: bun scripts/dev.ts
        </div>
      )}
      {status === "exited" && (
        <div className="terminal-status" data-testid="terminal-status">Session ended</div>
      )}
      <Terminal
        autoResize
        className="ghostty-terminal"
        core={result.core}
        cursorBlink={active}
        onData={handleData}
        onResize={handleResize}
        ref={ref}
        rows={24}
        theme="monokai"
      />
    </div>
  );
}
