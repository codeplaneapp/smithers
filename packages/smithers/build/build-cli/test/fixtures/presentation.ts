import type { Policy } from "../../src/Audience.ts"

/** Execution assertions inspect plain progress regardless of the test runner's host terminal. */
export const executionPresentation: Policy = {
  audience: "agent",
  source: "override",
  harnesses: [],
  structured: true,
  progress: "plain",
  interactive: false
}
