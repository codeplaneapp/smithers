// Test-only preload (wired via bunfig.toml `[test] preload`).
//
// happy-dom backs its DOM `WebSocket` with the `ws` package and registers the
// raw socket's error handler with `.once('error')` (see
// happy-dom/lib/web-socket/WebSocket.js). A SECOND raw socket error — e.g. an
// ECONNREFUSED on a failed connect immediately followed by a teardown/terminate
// error — then has NO listener, so the `ws` EventEmitter rethrows it. Node/bun
// escalates that listener-less 'error' into an uncaught exception, and because
// bun runs every test file in one process it lands on whatever file is running
// at that moment — reding unrelated tests (a green-on-mac / red-on-CI flake we
// reproduced deterministically in a Linux container).
//
// We shadow `emit` on the `ws` prototype so a listener-less 'error' becomes a
// no-op instead of a throw. Every real error path keeps happy-dom's `.once`
// listener (or the gateway client's own), so `listenerCount('error') > 0` there
// and nothing real is swallowed — only the pathological late/second error that
// would otherwise crash the process.
import WS from "ws";

type EmitterProto = {
  emit?: (event: string, ...args: unknown[]) => boolean;
  listenerCount?: (event: string) => number;
  __smithersWsErrorGuard?: boolean;
};

const proto = (WS as unknown as { prototype?: EmitterProto }).prototype;
if (proto && !proto.__smithersWsErrorGuard) {
  const origEmit = proto.emit ?? (Object.getPrototypeOf(proto) as EmitterProto | null)?.emit;
  if (typeof origEmit === "function") {
    proto.__smithersWsErrorGuard = true;
    proto.emit = function patchedEmit(this: EmitterProto, event: string, ...args: unknown[]) {
      if (event === "error" && (this.listenerCount?.("error") ?? 0) === 0) {
        return false;
      }
      return origEmit.call(this, event, ...args);
    };
  }
}
