/** @jsxImportSource react */
import { useCallback, useRef, type CSSProperties } from "react";
import { useSmithersGateway } from "@smithers-orchestrator/gateway-react";
import { Terminal, type TerminalInstance, type TerminalStream } from "@smithers-orchestrator/ui/adapters/terminal";
import { ptyHijackUrl, type HijackStatus } from "./hijack";

const WEBSOCKET_OPEN = 1;

export type HijackTerminalProps = {
  runId: string;
  nodeId?: string;
  onStatus?: (status: HijackStatus) => void;
  style?: CSSProperties;
};

/**
 * One interactive PTY hand-off. The websocket is owned by the terminal's
 * `stream` seam, so it is created after the emulator opens (real cols/rows) and
 * torn down with it. Remount on a target change is driven by the caller's key.
 */
export function HijackTerminal({ runId, nodeId, onStatus, style }: HijackTerminalProps) {
  const gateway = useSmithersGateway();
  const terminalRef = useRef<TerminalInstance | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const sendResize = useCallback((cols: number, rows: number) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) return;
    socket.send(JSON.stringify({ type: "resize", cols, rows }));
  }, []);

  const stream = useCallback<TerminalStream>(
    (write) => {
      const term = terminalRef.current;
      const cols = term?.cols ?? 80;
      const rows = term?.rows ?? 24;
      onStatusRef.current?.("connecting");
      const WebSocketImpl = gateway.WebSocketImpl;
      if (!WebSocketImpl) {
        onStatusRef.current?.("error");
        write("\r\n\x1b[1;31mWebSocket is unavailable in this browser.\x1b[0m\r\n");
        return;
      }
      const socket = new WebSocketImpl(ptyHijackUrl(gateway.baseUrl, runId, nodeId, { cols, rows }, gateway.token));
      let terminalEnded = false;
      socketRef.current = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        onStatusRef.current?.("connected");
        sendResize(terminalRef.current?.cols ?? cols, terminalRef.current?.rows ?? rows);
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          // JSON control frames; unknown types are ignored for forward compat.
          try {
            const message = JSON.parse(event.data) as { type?: unknown; code?: unknown; message?: unknown };
            if (message.type === "exit") {
              terminalEnded = true;
              onStatusRef.current?.("exited");
              write(
                `\r\n\x1b[2m[session ended${typeof message.code === "number" ? ` · exit ${message.code}` : ""}]\x1b[0m\r\n`,
              );
            } else if (message.type === "error") {
              terminalEnded = true;
              onStatusRef.current?.("error");
              write(`\r\n\x1b[1;31m${String(message.message ?? "PTY error")}\x1b[0m\r\n`);
            }
          } catch {
            // Not JSON: drop, PTY bytes only travel on binary frames.
          }
          return;
        }
        write(new Uint8Array(event.data as ArrayBuffer));
      };
      socket.onerror = () => {
        terminalEnded = true;
        onStatusRef.current?.("error");
        write("\r\n\x1b[1;31mTerminal socket error — the connection to the gateway failed.\x1b[0m\r\n");
      };
      socket.onclose = () => {
        if (!terminalEnded) onStatusRef.current?.("closed");
      };
      return () => {
        socketRef.current = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
          socket.close(1000, "terminal closed");
        } catch {
          // Closing a CONNECTING socket can throw in some environments.
        }
      };
    },
    [gateway, runId, nodeId, sendResize],
  );

  return (
    <Terminal
      data-testid="oneshot-hijack-terminal"
      style={{ height: "100%", minHeight: 320, ...style }}
      onReady={(instance) => {
        terminalRef.current = instance;
        instance.focus();
      }}
      onData={(data) => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WEBSOCKET_OPEN) return;
        const bytes = new TextEncoder().encode(data);
        socket.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      }}
      onResize={({ cols, rows }) => sendResize(cols, rows)}
      stream={stream}
    />
  );
}
