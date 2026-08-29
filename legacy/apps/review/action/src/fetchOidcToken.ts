/**
 * Request a GitHub Actions OIDC token for the `smithers-review` audience. The
 * workflow must declare `permissions: id-token: write` for the runner to
 * populate `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`.
 *
 * Resolves to the raw JWT; identity (repository, ref, pull request) lives in
 * its claims and is verified by the service.
 */
export interface FetchOidcTokenInput {
  audience?: string;
  env?: {
    ACTIONS_ID_TOKEN_REQUEST_URL?: string;
    ACTIONS_ID_TOKEN_REQUEST_TOKEN?: string;
  };
  fetchImpl?: typeof fetch;
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
  const audience = input.audience ?? "smithers-review";
  const url = `${requestUrl}${requestUrl.includes("?") ? "&" : "?"}audience=${encodeURIComponent(audience)}`;
  const f = input.fetchImpl ?? fetch;
  const res = await f(url, { headers: { authorization: `Bearer ${requestToken}` } });
  if (!res.ok) {
    throw new Error(`OIDC token request failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { value?: string };
  if (typeof body.value !== "string" || body.value.length === 0) {
    throw new Error("OIDC token response missing `value`");
  }
  return body.value;
}
