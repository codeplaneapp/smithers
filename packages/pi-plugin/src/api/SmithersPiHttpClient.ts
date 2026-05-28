import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

type RequestOptions = {
  baseUrl?: string;
  apiKey?: string;
};

type FetchOptions = {
  method?: string;
  body?: unknown;
};

const DEFAULT_BASE = "http://127.0.0.1:7331";

function buildHeaders(opts: RequestOptions, withJson: boolean) {
  const headers: Record<string, string> = {};
  if (withJson) {
    headers["Content-Type"] = "application/json";
  }
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }
  return headers;
}

export class SmithersPiHttpClient {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;

  constructor(opts: RequestOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.apiKey = opts.apiKey;
  }

  async json(path: string, opts: FetchOptions = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: opts.method ?? "GET",
      headers: buildHeaders(this, opts.body !== undefined),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SmithersError(
        "PI_HTTP_ERROR",
        `Smithers HTTP ${res.status}${text ? `: ${text}` : ""}`,
        {
          baseUrl: this.baseUrl,
          path,
          status: res.status,
        },
      );
    }
    return res.json();
  }

  async *events(path: string) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: buildHeaders(this, false),
    });
    if (!res.ok || !res.body) {
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part
            .split("\n")
            .find((item) => item.startsWith("data: "));
          if (line) {
            const payload = line.slice(6);
            try {
              yield JSON.parse(payload);
            } catch {
              // Skip malformed SSE frames instead of aborting the stream.
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
