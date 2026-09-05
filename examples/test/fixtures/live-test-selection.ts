/**
 * Collects the real provider tests without executing model calls.
 *
 * @since 0.1.0
 */
import { createVitest } from "vitest/node"

// Bypass the suite's credential masking to prove each test owns its gate.
const runner = await createVitest("test", { config: false, watch: false, maxWorkers: 1, reporters: [] })
try {
  const { testModules, unhandledErrors } = await runner.collect([
    "test/12-agent-live-smoke.test.ts",
    "test/13-agent-live-smoke-local.test.ts"
  ])
  if (unhandledErrors.length > 0) throw new AggregateError(unhandledErrors)
  const tests = testModules.flatMap((module) =>
    [...module.children.allTests()].map((test) => ({
      file: module.relativeModuleId,
      name: test.fullName,
      mode: test.options.mode,
      timeout: test.options.timeout
    }))
  )
  process.stdout.write(JSON.stringify(tests))
} finally {
  await runner.close()
}
