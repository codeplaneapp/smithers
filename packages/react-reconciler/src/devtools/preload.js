/**
 * Preload script that installs the React DevTools global hook before
 * any React code runs. Use this as a Bun preload:
 *
 *   bun --preload ./src/devtools/preload.js run myworkflow.tsx
 *
 * Or in bunfig.toml:
 *   preload = ["./src/devtools/preload.js"]
 */
import { installRDTHook } from "bippy";
// Reinstalling over a live hook orphans renderers that already injected into
// it (react-reconciler dispatches commits to the hook captured at inject
// time), so a mid-process import must be a no-op.
if (!("__REACT_DEVTOOLS_GLOBAL_HOOK__" in globalThis)) {
  installRDTHook();
}
