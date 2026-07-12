/** Bounded client for the short-lived hosted review session. */
export interface CreateSessionInput {
  serviceUrl: string;
  oidcToken: string;
  pr?: number;
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
}

export interface SessionPayload {
  token: string;
  expiresAt: number;
  mode: "auto" | "comment";
  plan: { prsPerMonth: number; used: number };
  anthropicBaseUrl: string;
  publishUrl: string;
  quiz?: "off" | "auto" | "on";
  quota?: { remaining?: number; limit?: number; resetsAt?: string };
}

export type SessionOutcome =
  | ({ status: "ok" } & SessionPayload)
  | { status: "quota-exhausted"; message: string }
  | { status: "not-registered"; message: string }
  | { status: "error"; message: string };

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_DEADLINE_MS = 10_000;

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]");
}

function endpoint(value: string): URL {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) throw new Error("review service URL is invalid");
  const url = new URL(value);
  if ((url.protocol !== "https:" && !isLoopback(url)) || url.username || url.password || url.search || url.hash) {
    throw new Error("review service URL must be credential-free HTTPS (or loopback HTTP)");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/sessions`;
  return url;
}

function safeMessage(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/@(?!\u200b)/g, "@\u200b")
    .slice(0, 240);
}

function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("review service request timed out"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("review service request timed out"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

async function responseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new Error("review service response is oversized");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("review service response is oversized");
      chunks.push(next.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* a hostile adapter may retain a pending read */ }
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function decode(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("review service response is not valid UTF-8"); }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseSessionPayload(value: unknown): SessionPayload {
  const payload = object(value);
  const plan = object(payload?.plan);
  const quota = payload?.quota === undefined ? undefined : object(payload.quota);
  const allowed = new Set(["token", "expiresAt", "mode", "plan", "anthropicBaseUrl", "publishUrl", "quiz", "quota"]);
  const planKeys = new Set(["prsPerMonth", "used"]);
  const quotaKeys = new Set(["remaining", "limit", "resetsAt"]);
  if (!payload || Object.keys(payload).some((key) => !allowed.has(key))
    || typeof payload.token !== "string" || payload.token.length < 1 || payload.token.length > 8_192 || /[\u0000-\u0020\u007f]/.test(payload.token)
    || !nonnegative(payload.expiresAt)
    || (payload.mode !== "auto" && payload.mode !== "comment")
    || !plan || Object.keys(plan).length !== 2 || Object.keys(plan).some((key) => !planKeys.has(key))
    || !nonnegative(plan.prsPerMonth) || !nonnegative(plan.used)
    || typeof payload.anthropicBaseUrl !== "string" || payload.anthropicBaseUrl.length < 1 || payload.anthropicBaseUrl.length > 2_048
    || typeof payload.publishUrl !== "string" || payload.publishUrl.length < 1 || payload.publishUrl.length > 2_048
    || (payload.quiz !== undefined && payload.quiz !== "off" && payload.quiz !== "auto" && payload.quiz !== "on")
    || (payload.quota !== undefined && (!quota || Object.keys(quota).some((key) => !quotaKeys.has(key))))
    || (quota?.remaining !== undefined && !nonnegative(quota.remaining))
    || (quota?.limit !== undefined && !nonnegative(quota.limit))
    || (quota?.resetsAt !== undefined && (typeof quota.resetsAt !== "string" || quota.resetsAt.length > 128))) {
    throw new Error("review service returned an invalid session payload");
  }
  const sessionQuota = quota ?? undefined;
  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    mode: payload.mode,
    plan: { prsPerMonth: plan.prsPerMonth, used: plan.used },
    anthropicBaseUrl: payload.anthropicBaseUrl,
    publishUrl: payload.publishUrl,
    ...(payload.quiz === undefined ? {} : { quiz: payload.quiz }),
    ...(sessionQuota === undefined ? {} : { quota: {
      ...(sessionQuota.remaining === undefined ? {} : { remaining: sessionQuota.remaining as number }),
      ...(sessionQuota.limit === undefined ? {} : { limit: sessionQuota.limit as number }),
      ...(sessionQuota.resetsAt === undefined ? {} : { resetsAt: sessionQuota.resetsAt as string }),
    } }),
  };
}

export async function createSession(input: CreateSessionInput): Promise<SessionOutcome> {
  try {
    const url = endpoint(input.serviceUrl);
    if (typeof input.oidcToken !== "string" || input.oidcToken.length < 1 || input.oidcToken.length > 32 * 1024
      || /[^\x21-\x7e]/.test(input.oidcToken)) throw new Error("OIDC token is invalid or oversized");
    if (input.pr !== undefined && (!Number.isSafeInteger(input.pr) || input.pr < 1)) throw new Error("pull request number is invalid");
    const deadline = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 30_000) throw new Error("review service deadline is invalid");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("review service request timed out")), deadline);
    try {
      const response = await abortable((input.fetchImpl ?? fetch)(url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidcToken: input.oidcToken, ...(input.pr === undefined ? {} : { pr: input.pr }) }),
        signal: controller.signal,
      }), controller.signal);
      const text = decode(await responseBytes(response, controller.signal)).trim();
      if (response.status === 402) return { status: "quota-exhausted", message: safeMessage(text || "monthly PR quota exhausted") };
      if (response.status === 403) return { status: "not-registered", message: safeMessage(text || "repository not registered") };
      if (!response.ok) {
        return { status: "error", message: `service returned HTTP ${response.status}${text ? ` — ${safeMessage(text)}` : ""}` };
      }
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { throw new Error("review service returned invalid JSON"); }
      return { status: "ok", ...parseSessionPayload(raw) };
    } finally { clearTimeout(timer); }
  } catch (error) {
    return { status: "error", message: `request failed: ${safeMessage(error)}` };
  }
}
