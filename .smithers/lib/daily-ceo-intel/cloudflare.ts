export type CloudflareCreds = {
  accountId: string;
  apiToken: string;
  kvNamespaceId: string;
  r2Bucket: string;
};

type CloudflareApiResponse = { success: boolean; errors?: Array<{ code: number; message: string }> };

function joinErrors(errors: CloudflareApiResponse["errors"]): string {
  return (errors ?? []).map((error) => `${error.code}: ${error.message}`).join("; ") || "unknown error";
}

export async function putR2Object(creds: CloudflareCreds, key: string, body: string, contentType: string): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/r2/buckets/${creds.r2Bucket}/objects/${key}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${creds.apiToken}`, "content-type": contentType },
    body,
  });
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as CloudflareApiResponse | null;
    throw new Error(`R2 PUT ${key} failed: HTTP ${response.status} ${parsed ? joinErrors(parsed.errors) : ""}`);
  }
}

export async function putKvValue(creds: CloudflareCreds, key: string, value: string): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/storage/kv/namespaces/${creds.kvNamespaceId}/values/${encodeURIComponent(key)}`;
  const form = new FormData();
  form.set("value", value);
  form.set("metadata", JSON.stringify({ contentType: "application/json" }));
  const response = await fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${creds.apiToken}` },
    body: form,
  });
  const parsed = (await response.json().catch(() => null)) as CloudflareApiResponse | null;
  if (!response.ok || (parsed && parsed.success === false)) {
    throw new Error(`KV PUT ${key} failed: HTTP ${response.status} ${parsed ? joinErrors(parsed.errors) : ""}`);
  }
}

export async function getKvValue(creds: CloudflareCreds, key: string): Promise<string | null> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/storage/kv/namespaces/${creds.kvNamespaceId}/values/${encodeURIComponent(key)}`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${creds.apiToken}` } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`KV GET ${key} failed: HTTP ${response.status}`);
  return response.text();
}
