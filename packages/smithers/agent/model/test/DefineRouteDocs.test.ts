import { Redacted, Result } from "effect"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"
import * as Route from "../src/Route.ts"

it("the documented Cerebras structured-output route targets chat completions", () => {
  const guide = readFileSync(new URL("../docs/guides/define-a-route.md", import.meta.url), "utf8")
  const snippet = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)]
    .find(([, code]) => code?.includes("id: \"cerebras\""))?.[1]
  expect(snippet).toBeDefined()

  // Execute the copyable example through Route and Endpoint with a local placeholder key.
  const endpointUrl = runInNewContext(`${snippet}\nroute.endpoint.url`, {
    Route,
    Redacted,
    Result,
    process: { env: { CEREBRAS_API_KEY: "test-key" } }
  })

  expect(endpointUrl).toBe("https://api.cerebras.ai/v1/chat/completions")
})
