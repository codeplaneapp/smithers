import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect } from "effect"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as CodexAuth from "../../src/CodexAuth.ts"

const [file, endpoint] = process.argv.slice(2)
if (file === undefined || endpoint === undefined) throw new Error("expected auth file and endpoint")

const executor = RequestExecutor.RequestExecutor.of({
  execute: (request) =>
    Effect.promise(async () => {
      const body = request.body._tag === "Uint8Array" ? request.body.body : undefined
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: new Uint8Array(body).buffer })
      })
      return HttpClientResponse.fromWeb(request, response)
    })
})

const headers = await Effect.runPromise(
  CodexAuth.make({ file, executor }).auth({ modelId: "test-model" }).sign({})
)
process.stdout.write(`${JSON.stringify(headers)}\n`)
