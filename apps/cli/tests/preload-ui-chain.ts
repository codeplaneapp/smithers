// Bun 1.3.13's dual CJS/ESM loader can reject with "Requested module is
// already fetched" when react-dom's or react-remove-scroll's lazy CJS
// require("react")/require("scheduler") races another test file's in-flight
// ESM import of the same module. monitorModel no longer causes that race
// (issue #1381), but the shared shard still mixes unrelated React and non-React
// tests; CI reproduced the same loader failure at review-verdict.test.js after
// the model-only fix. Loading the family once serializes those remaining edges.
//
// This preload is passed only to the shared test process. The isolated
// monitor-shell-controls process registers its own happy-dom window before
// dynamically importing radix, preserving radix's module-load-time DOM check.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const nativeFetch = globalThis.fetch;
GlobalRegistrator.register({ url: "http://localhost/preload" });
globalThis.fetch = nativeFetch;
try {
  await import("react");
  await import("smthrs/ui");
  await import("smthrs/gateway-ui");
  // react-dom/client is its own module record; the loader race resurfaced
  // through react-dom-client.development.js once everything else was settled.
  // gateway-react's createGatewayReactRoot imports it statically.
  await import("smthrs/gateway-react");
} finally {
  await GlobalRegistrator.unregister();
  globalThis.fetch = nativeFetch;
}
