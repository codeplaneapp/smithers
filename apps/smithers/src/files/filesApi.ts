export type FileTreeEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number;
  mtimeMs: number;
  symlink: boolean;
  safe: boolean;
  binary?: boolean;
  previewable: boolean;
  editable: boolean;
  truncated?: boolean;
  maxPreviewBytes?: number;
  maxEditBytes?: number;
};

export type FileTreeResponse = {
  ok: true;
  root: string;
  path: string;
  entries: FileTreeEntry[];
  truncated: boolean;
};

export type FileReadResult = {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  /** Optimistic-concurrency token; echo it back on save. Null when not editable. */
  revision: string | null;
  kind: "text" | "binary";
  editable: boolean;
  previewText: string | null;
  content: string | null;
  truncated: boolean;
  reason: string | null;
};

export type FileReadResponse = {
  ok: true;
  file: FileReadResult;
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body?.error?.message === "string" ? body.error.message : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export async function fetchFileTree(path: string): Promise<FileTreeResponse> {
  const params = new URLSearchParams({ path });
  const response = await fetch(`/api/files/tree?${params.toString()}`);
  return readJson<FileTreeResponse>(response);
}

export async function fetchFile(path: string): Promise<FileReadResponse> {
  const params = new URLSearchParams({ path });
  const response = await fetch(`/api/files/read?${params.toString()}`);
  return readJson<FileReadResponse>(response);
}

export async function saveFile(path: string, content: string, revision: string): Promise<FileReadResponse> {
  const response = await fetch("/api/files/write", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content, revision }),
  });
  return readJson<FileReadResponse>(response);
}
