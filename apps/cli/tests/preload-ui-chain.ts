// Bun 1.3.13's dual CJS/ESM loader can reject with "Requested module is
// already fetched" when react-dom's or react-remove-scroll's lazy CJS
// require("react")/require("scheduler") races another test file's in-flight
// ESM import of the same module. monitorModel no longer causes that race
// (issue #1381), but the shared shard still mixes unrelated React and non-React
// tests; CI reproduced the same loader failure at review-verdict.test.js after
// the model-only fix. Loading the family once serializes those remaining edges.
//
// Registered through apps/cli/bunfig.toml for both CLI test commands. Radix
// decides whether to use layout effects at module load, so happy-dom must
// exist before any test module imports the shared UI. The rendered monitor
// suite keeps the DOM for its assertions; non-DOM shards only use it to
// serialize the React module family, then unregister it.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const nativeFetch = globalThis.fetch;
const monitorShellProcess = process.argv.some((arg) => arg.includes("monitor-shell-controls.test.tsx"));
GlobalRegistrator.register({ url: "http://localhost/preload" });
globalThis.fetch = nativeFetch;
// The rendered monitor shard uses React act(); enable its environment before
// the component family loads without changing the non-DOM CLI shards.
if (monitorShellProcess) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
try {
  await import("react");
  await import("smthrs/ui");
  await import("smthrs/gateway-ui");
  // react-dom/client is its own module record; the loader race resurfaced
  // through react-dom-client.development.js once everything else was settled.
  // gateway-react's createGatewayReactRoot imports it statically.
  await import("smthrs/gateway-react");
} finally {
  if (!monitorShellProcess) await GlobalRegistrator.unregister();
  globalThis.fetch = nativeFetch;
}
