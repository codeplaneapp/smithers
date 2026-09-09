/**
 * Exercises CLI credentials against a local HTTP fixture, without a provider.
 *
 * @since 0.1.0
 */
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"

const requests: Array<{ authorization: string | undefined; body: string }> = []
const server = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  requests.push({ authorization: request.headers.authorization, body })
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end('data: {"choices":[{"index":0,"delta":{"content":"Paris"},"finish_reason":null}]}\n\ndata: [DONE]\n\n')
})
let baseUrl: string

beforeEach(async () => {
  requests.length = 0
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener")
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

const runCli = (key: string | undefined, extraArgs: Array<string> = []) => {
  const env = { ...process.env }
  delete env.SMITHERS_EXAMPLE_API_KEY
  if (key !== undefined) env.SMITHERS_EXAMPLE_API_KEY = key
  return new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [
      fileURLToPath(new URL("../src/15-model-layer-smoke.ts", import.meta.url)),
      "fixture-model",
      baseUrl,
      ...extraArgs
    ], { env, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr })
    })
  })
}

it("reads the provider key from SMITHERS_EXAMPLE_API_KEY", async () => {
  const result = await runCli("env-only-test-key")
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("ANSWER: Paris")
  expect(requests).toHaveLength(1)
  expect(requests[0]?.authorization).toBe("Bearer env-only-test-key")
  expect(JSON.parse(requests[0]!.body).model).toBe("fixture-model")
  expect(result.stdout + result.stderr).not.toContain("env-only-test-key")
})

it("uses the non-secret local key when the environment variable is unset", async () => {
  const result = await runCli(undefined)
  expect(result.code).toBe(0)
  expect(result.stdout).toContain("ANSWER: Paris")
  expect(requests).toHaveLength(1)
  expect(requests[0]?.authorization).toBe("Bearer local")
})

it("rejects a positional key without echoing it or contacting the endpoint", async () => {
  const result = await runCli("env-only-test-key", ["positional-test-key"])
  expect(result.code).toBe(1)
  expect(requests).toHaveLength(0)
  expect(result.stderr).toContain("API keys must not be passed as positional arguments")
  expect(result.stderr).toContain("SMITHERS_EXAMPLE_API_KEY")
  expect(result.stderr).toContain("[modelId] [baseUrl]")
  expect(result.stdout + result.stderr).not.toContain("positional-test-key")
  expect(result.stdout + result.stderr).not.toContain("env-only-test-key")
})
