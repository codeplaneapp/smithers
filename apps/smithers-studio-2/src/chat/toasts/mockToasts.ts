import type { Toast } from "./Toast";

/**
 * SEAM: seeded run toasts in each of the three run states so the upper-right
 * stack renders fully without a backend. The real Monitor agent writes these
 * (one cheap model pass per frame). Replace with a subscription over run frames.
 */
export const mockToasts: Toast[] = [
  {
    kind: "run",
    id: "toast-triage",
    workflow: "triage",
    status: "Reproducing the Safari 500 across browsers…",
    state: "running",
    overlay: { kind: "dashboard", title: "Triage dashboard", dashboard: "triage" },
  },
  {
    kind: "run",
    id: "toast-tests",
    workflow: "fix-flaky-tests",
    status: "All 142 tests green — landed on main.",
    state: "succeeded",
    overlay: { kind: "dashboard", title: "Runs", dashboard: "runs" },
  },
  {
    kind: "run",
    id: "toast-deploy",
    workflow: "deploy-preview",
    status: "Build failed: type error in checkout.ts.",
    state: "failed",
    overlay: { kind: "dashboard", title: "Runs", dashboard: "runs" },
  },
];
