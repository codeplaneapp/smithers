// bun 1.3.13's dual CJS/ESM loader can reject with "Requested module is
// already fetched" when react-dom's or react-remove-scroll's lazy CJS
// require("react")/require("scheduler") races another test file's in-flight
// ESM import of the same module (the chains are pulled lazily by
// UI-importing tests such as monitor-shell-controls). The rejection is
// unhandled and kills the whole `bun test` process "between tests" on CI's
// Linux shards and coverage job. Loading the family exactly once here, before
// any test file, removes the race. bun reads bunfig.toml only from the
// package cwd, so this must be a package-local preload.
//
// react-dom captures its environment at first evaluation, and the DOM tests
// in this package deliberately register happy-dom BEFORE importing it, so the
// preload mirrors that: register a throwaway happy-dom window, settle the
// modules, then unregister to leave the globals exactly as tests expect.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const nativeFetch = globalThis.fetch;
GlobalRegistrator.register({ url: "http://localhost/preload" });
globalThis.fetch = nativeFetch;
try {
  await import("react");
  await import("smithers-orchestrator/ui");
  await import("smithers-orchestrator/gateway-ui");
} finally {
  await GlobalRegistrator.unregister();
  globalThis.fetch = nativeFetch;
}
