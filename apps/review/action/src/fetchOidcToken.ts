/** Request one bounded GitHub Actions OIDC token for the review audience. */
export interface FetchOidcTokenInput {
  audience?: string;
  env?: {
    ACTIONS_ID_TOKEN_REQUEST_URL?: string;
    ACTIONS_ID_TOKEN_REQUEST_TOKEN?: string;
  };
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
}

const MAX_RESPONSE_BYTES = 64 * 1024;

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]");
}

function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("OIDC token request timed out"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("OIDC token request timed out"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

async function boundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new Error("OIDC token response is oversized");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("OIDC token response is oversized");
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* a hostile adapter may retain a pending read */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("OIDC token response is not valid UTF-8"); }
}

export async function fetchOidcToken(input: FetchOidcTokenInput = {}): Promise<string> {
  const env = input.env ?? process.env;
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error(
      "ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN are unset; add `permissions: id-token: write` to the workflow",
    );
  }
  if (requestUrl.length > 4_096) throw new Error("ACTIONS_ID_TOKEN_REQUEST_URL is oversized");
  if (requestToken.length > 8_192 || /[^\x21-\x7e]/.test(requestToken)) {
    throw new Error("ACTIONS_ID_TOKEN_REQUEST_TOKEN is invalid or oversized");
  }
  const audience = input.audience ?? "smithers-review";
  if (typeof audience !== "string" || audience.length < 1 || audience.length > 256 || /[^\x20-\x7e]/.test(audience)) {
    throw new Error("OIDC audience is invalid or oversized");
  }
  const url = new URL(requestUrl);
  if ((url.protocol !== "https:" && !isLoopback(url)) || url.username || url.password || url.hash) {
    throw new Error("ACTIONS_ID_TOKEN_REQUEST_URL must be credential-free HTTPS (or loopback HTTP)");
  }
  url.searchParams.set("audience", audience);
  const deadline = input.deadlineMs ?? 10_000;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 30_000) throw new Error("OIDC request deadline is invalid");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("OIDC token request timed out")), deadline);
  try {
    const response = await abortable((input.fetchImpl ?? fetch)(url, {
      redirect: "error",
      headers: { authorization: `Bearer ${requestToken}` },
      signal: controller.signal,
    }), controller.signal);
    const text = await boundedResponse(response, controller.signal);
    if (!response.ok) throw new Error(`OIDC token request failed: HTTP ${response.status}`);
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new Error("OIDC token response is not valid JSON"); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || Object.keys(raw).some((key) => key !== "value")) throw new Error("OIDC token response has an invalid schema");
    const value = (raw as { value?: unknown }).value;
    if (typeof value !== "string" || value.length < 1 || value.length > 32 * 1024 || /[^\x21-\x7e]/.test(value)) {
      throw new Error("OIDC token response missing or has invalid `value`");
    }
    return value;
  } finally { clearTimeout(timer); }
}
