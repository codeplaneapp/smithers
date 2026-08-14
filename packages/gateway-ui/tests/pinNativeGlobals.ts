// Test preload (see bunfig.toml): runs before any test file, so every suite
// sees one identical environment regardless of bun's readdir file order.
//
// The dom suites used to register happy-dom at module scope, which made the
// whole suite file-order dependent: ESM import hoisting means a suite's own
// imports (react-dom, gateway-react, the component library, the in-memory
// gateway) evaluate BEFORE its body registers happy-dom — so whenever a dom
// suite ran first, the shared module graph was evaluated against Bun's native
// globals and everything passed. But when a file that registers happy-dom
// WITHOUT importing that graph ran first (Linux readdir order does this), the
// graph evaluated under happy-dom globals and 100+ tests failed
// (Bun.serve rejecting happy-dom Responses, dead SSE streams, act() overlap
// cascades) — CI red while macOS stayed green.
//
// This preload reproduces the green path deterministically: the import block
// below evaluates the whole shared graph first (hoisted, pre-DOM), then the
// body pins Bun's natives, registers happy-dom once, and restores Bun's fetch
// (happy-dom's node:http fetch cannot read the gateway's streaming SSE
// responses). Per-file `GlobalRegistrator.register()` calls remain as no-ops.
import "react";
import "react-dom/client";
import "react-dom/server";
import "@xyflow/react";
import "@smthrs/gateway-react";
import "../src/index.ts";
import "./inMemoryGateway.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

declare global {
  var __smithersNativeResponse: typeof Response | undefined;
  var __smithersNativeReadableStream: typeof ReadableStream | undefined;
  var __smithersNativeFetch: typeof fetch | undefined;
}

globalThis.__smithersNativeResponse ??= globalThis.Response;
globalThis.__smithersNativeReadableStream ??= globalThis.ReadableStream;
globalThis.__smithersNativeFetch ??= globalThis.fetch;

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
globalThis.fetch = globalThis.__smithersNativeFetch;

export {};
