import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Gateway } from "smithers-orchestrator/gateway";

function readTokens() {
  const tokenStore = process.env.SMITHERS_TOKEN_STORE ?? "/data/tokens.json";
  if (!existsSync(tokenStore)) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(tokenStore, "utf8"));
  } catch (err) {
    // Fail secure: a corrupt/malformed token store must not crash the gateway
    // at boot, and must NOT grant access. Return an empty token set instead.
    console.warn(
      `[reference-gateway] failed to parse token store at ${tokenStore}; ` +
        `denying all token auth (empty token set): ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
  return parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : {};
}

const gateway = new Gateway({
  heartbeatMs: Number(process.env.SMITHERS_GATEWAY_HEARTBEAT_MS ?? 15_000),
  eventWindowSize: Number(process.env.SMITHERS_GATEWAY_EVENT_WINDOW ?? 10_000),
  headersTimeout: Number(process.env.SMITHERS_GATEWAY_HEADERS_TIMEOUT_MS ?? 30_000),
  requestTimeout: Number(process.env.SMITHERS_GATEWAY_REQUEST_TIMEOUT_MS ?? 60_000),
  auth: {
    mode: "token",
    tokens: readTokens(),
  },
});

const modulePath = process.env.SMITHERS_GATEWAY_MODULE
  ? resolve(process.env.SMITHERS_GATEWAY_MODULE)
  : "/workspace/gateway.mjs";

if (existsSync(modulePath)) {
  const mod = await import(pathToFileURL(modulePath).href);
  if (typeof mod.register === "function") {
    await mod.register(gateway);
  } else if (typeof mod.default === "function") {
    await mod.default(gateway);
  }
}

await gateway.listen({
  host: "0.0.0.0",
  port: Number(process.env.PORT ?? 7331),
});

console.log("Smithers Gateway listening on 0.0.0.0:7331");
