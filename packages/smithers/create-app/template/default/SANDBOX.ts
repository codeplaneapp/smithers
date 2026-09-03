import { defineSandbox } from "@smthrs/create-app/app"

// The root sandbox layer: the QuickJS realm every cell of every flow runs in.
// `wallClockMs` is the whole-evaluation backstop, host calls included.
export const Sandbox = defineSandbox({
  limits: { heapBytes: 128 * 1024 * 1024, interruptChecks: 1000, wallClockMs: 30_000 }
})
