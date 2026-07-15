import { isIP } from "node:net";

/**
 * Build a one-off Node request that connects to an already-validated numeric
 * address while retaining the original URL authority for HTTP and TLS.
 *
 * @param {import("./createTranscriptionTool.ts").PinnedAudioTransportRequest} request
 * @returns {import("node:https").RequestOptions}
 */
export function buildPinnedAudioRequestOptions(request) {
  const originalHostname = request.url.hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.+$/, "");
  const options = {
    protocol: request.url.protocol,
    hostname: request.address,
    family: request.family,
    ...(request.url.port ? { port: Number(request.url.port) } : {}),
    method: "GET",
    path: `${request.url.pathname}${request.url.search}`,
    headers: {
      Host: request.url.host,
      Connection: "close",
    },
    agent: false,
    ...(request.signal ? { signal: request.signal } : {}),
  };

  if (request.url.protocol === "https:" && isIP(originalHostname) === 0) {
    return { ...options, servername: originalHostname };
  }
  return options;
}
