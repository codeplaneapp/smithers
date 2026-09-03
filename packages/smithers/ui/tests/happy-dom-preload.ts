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
  // Mutate the live settings object so happy-dom's defaults merge instead of
  // being replaced (passing `settings` to register() wholesale replaces them,
  // which breaks default window/document behavior some tests rely on).
  // WebPreview tests render iframes pointing at real URLs; happy-dom would
  // otherwise perform genuine network fetches, which hang in networkless
  // CI sandboxes and fail the packages/smithers/ui gate.
  (globalThis as { happyDOM?: { settings: Record<string, unknown> } }).happyDOM!.settings.disableIframePageLoading =
    true;
} catch {
  /* already registered in this bun process */
}
