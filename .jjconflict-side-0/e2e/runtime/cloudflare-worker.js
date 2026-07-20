import { runSharedRuntimeFixture } from "./fixture.js";

export default {
  /**
   * @param {Request} request
   * @param {{ RUNTIME_CONFORMANCE?: string }} env
   */
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/conformance") return new Response("not found", { status: 404 });
    const proof = await runSharedRuntimeFixture({ fetchLifecycle: true, binding: env.RUNTIME_CONFORMANCE === "ready" });
    return Response.json(proof);
  },
};
