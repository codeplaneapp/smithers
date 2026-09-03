import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/** One request a fixture server received, with its body already read. */
export interface Recorded {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: string
}

/** A real HTTP server the clients talk to over a real socket. No mocks. */
export interface Fixture {
  readonly origin: string
  readonly requests: ReadonlyArray<Recorded>
  readonly close: () => Promise<void>
}

export type Handler = (
  request: Recorded,
  response: ServerResponse
) => void | Promise<void>

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })

/** Starts a fixture server on an ephemeral port and records what it receives. */
export const startFixture = async (handler: Handler): Promise<Fixture> => {
  const requests: Array<Recorded> = []
  const server: Server = createServer((request, response) => {
    void readBody(request).then(async (body) => {
      const recorded: Recorded = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers as Record<string, string | undefined>,
        body
      }
      requests.push(recorded)
      await handler(recorded, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
  }
}

/** Replies with `status` and a JSON body. */
export const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers })
  response.end(JSON.stringify(body))
}
