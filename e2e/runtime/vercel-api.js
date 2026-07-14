import { runSharedRuntimeFixture } from "./fixture.js";

export default async function handler(request, response) {
  if (request.url !== "/api/conformance") return response.status(404).send("not found");
  const proof = await runSharedRuntimeFixture({ fetchLifecycle: true, vercelRuntime: process.env.VERCEL_RUNTIME_CONFORMANCE === "1" });
  response.status(200).json(proof);
}
