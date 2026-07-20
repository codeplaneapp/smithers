import { runSharedRuntimeFixture } from "./fixture.js";

export default async function handler(request, response) {
  if (request.url !== "/api/conformance") return response.status(404).send("not found");
  // A real marker set only by @vercel/node's own request bridge
  // (createServerlessEventHandler), not something this fixture asserts
  // about itself -- proves the handler actually ran inside the Vercel
  // Node.js function runtime.
  const vercelRuntime = typeof globalThis[Symbol.for("@vercel/request-context")]?.get === "function";
  const proof = await runSharedRuntimeFixture({ fetchLifecycle: true, vercelRuntime });
  response.status(200).json(proof);
}
