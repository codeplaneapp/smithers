// Test-only preload (wired via bunfig.toml `[test] preload`).
//
// Radix resolves its SSR-safe `useLayoutEffect` shim at MODULE LOAD time:
// `globalThis.document` absent means every Radix layout effect becomes a
// no-op, which silently breaks Portal mounting (content never appears) even
// if happy-dom is registered later. Since ESM imports are hoisted above any
// in-file register() call, the registration must happen in a preload that
// runs before any test file imports radix-ui.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered in this bun process */
}
