import { defineSandbox } from "@smthrs/create-app/app"

// Root sandbox layer: the QuickJS realm every cell of every flow runs in.
export const Sandbox = defineSandbox({
  limits: { heapBytes: 128 * 1024 * 1024, interruptChecks: 1000, wallClockMs: 30_000 }
})
