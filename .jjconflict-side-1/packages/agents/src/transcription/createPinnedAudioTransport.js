import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { Readable } from "node:stream";
import { buildPinnedAudioRequestOptions } from "./buildPinnedAudioRequestOptions.js";

/**
 * @typedef {(options: import("node:https").RequestOptions, callback: (response: import("node:http").IncomingMessage) => void) => import("node:http").ClientRequest} NodeRequest
 * @typedef {{ httpRequest?: NodeRequest, httpsRequest?: NodeRequest }} PinnedAudioTransportDependencies
 */

/**
 * Create the trusted transport used after every address for a URL hop has been
 * resolved and validated. Each request disables pooling and connects to the
 * selected numeric address. Redirects are returned untouched to the caller.
 *
 * Request-function injection exists for deterministic request-option tests.
 * Production callers should use the defaults.
 *
 * @param {PinnedAudioTransportDependencies} [dependencies]
 * @returns {import("./createTranscriptionTool.ts").PinnedAudioTransport}
 */
export function createPinnedAudioTransport(dependencies = {}) {
  const httpRequest = dependencies.httpRequest ?? /** @type {NodeRequest} */ (requestHttp);
  const httpsRequest = dependencies.httpsRequest ?? /** @type {NodeRequest} */ (requestHttps);

  return async function pinnedAudioTransport(request) {
    request.signal?.throwIfAborted();
    const requestOptions = buildPinnedAudioRequestOptions(request);
    const makeRequest = request.url.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      let settled = false;
      /** @param {unknown} error */
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      let clientRequest;
      try {
        clientRequest = makeRequest(requestOptions, (incoming) => {
          if (settled) {
            incoming.destroy();
            return;
          }
          const status = incoming.statusCode ?? 500;
          const headers = headersFromIncomingMessage(incoming);
          const bodyless = status === 204 || status === 205 || status === 304;
          if (bodyless) incoming.resume();

          try {
            const body = bodyless ? null : /** @type {BodyInit} */ (Readable.toWeb(incoming));
            const response = new Response(body, {
              status,
              statusText: incoming.statusMessage ?? "",
              headers,
            });
            settled = true;
            resolve(response);
          } catch (error) {
            incoming.destroy();
            fail(error);
          }
        });
      } catch (error) {
        fail(error);
        return;
      }

      clientRequest.once("error", fail);
      clientRequest.end();
    });
  };
}

/** @param {import("node:http").IncomingMessage} response */
function headersFromIncomingMessage(response) {
  const headers = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
  }
  return headers;
}
