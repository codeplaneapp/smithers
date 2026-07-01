import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startLocalUiServer } from "../src/localUiServer.js";

let tempDir;
let server;
let baseUrl;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "smithers-files-"));
  mkdirSync(join(tempDir, "dist"));
  writeFileSync(join(tempDir, "dist", "index.html"), "<main>ui</main>");
  mkdirSync(join(tempDir, "workspace", "src"), { recursive: true });
  writeFileSync(join(tempDir, "workspace", "README.md"), "# hello\n");
  writeFileSync(
    join(tempDir, "workspace", "src", "index.ts"),
    "export const value = 1;\n",
  );
  server = await startLocalUiServer({
    distDir: join(tempDir, "dist"),
    gatewayBase: "http://127.0.0.1:1",
    port: 0,
    workspaceRoot: join(tempDir, "workspace"),
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (server) {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    server = undefined;
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json();
  return { response, body };
}

async function postFileWrite(payload, origin = baseUrl) {
  const response = await fetch(`${baseUrl}/api/files/write`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  return { response, body };
}

describe("local UI files API", () => {
  test("loads a lazy directory tree rooted at the workspace", async () => {
    const { response, body } = await get("/api/files/tree?path=");
    expect(response.status).toBe(200);
    expect(body.entries.map((entry) => [entry.name, entry.type])).toEqual([
      ["src", "directory"],
      ["README.md", "file"],
    ]);
    expect(
      body.entries.find((entry) => entry.name === "README.md"),
    ).toMatchObject({
      path: "README.md",
      previewable: true,
      editable: true,
    });
  });

  test("rejects traversal, encoded traversal, and outside absolute paths", async () => {
    for (const path of [
      "/api/files/read?path=../../../../etc/passwd",
      "/api/files/read?path=%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      `/api/files/read?path=${encodeURIComponent(resolve(tmpdir(), "outside.txt"))}`,
    ]) {
      const { response, body } = await get(path);
      expect(response.status).toBe(403);
      expect(body.error.code).toBe("PATH_OUTSIDE_ROOT");
    }
  });

  test("rejects symlinks that escape the workspace", async () => {
    writeFileSync(join(tempDir, "outside.txt"), "secret\n");
    try {
      symlinkSync(
        join(tempDir, "outside.txt"),
        join(tempDir, "workspace", "escape.txt"),
      );
    } catch {
      return;
    }

    const { response, body } = await get("/api/files/read?path=escape.txt");
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("PATH_OUTSIDE_ROOT");
  });

  test("saves valid nested workspace files", async () => {
    const { response, body } = await postFileWrite({
      path: "src/index.ts",
      content: "export const value = 2;\n",
    });
    expect(response.status).toBe(200);
    expect(body.file).toMatchObject({
      path: "src/index.ts",
      editable: true,
      content: "export const value = 2;\n",
    });
  });

  test("rejects file writes from a cross-origin browser request", async () => {
    const { response, body } = await postFileWrite(
      { path: "src/index.ts", content: "export const value = 3;\n" },
      "https://evil.example",
    );
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN_ORIGIN");
  });

  test("does not load binary files into editable content", async () => {
    writeFileSync(
      join(tempDir, "workspace", "blob.bin"),
      Buffer.from([0, 1, 2, 3, 4]),
    );
    const { response, body } = await get("/api/files/read?path=blob.bin");
    expect(response.status).toBe(200);
    expect(body.file).toMatchObject({
      kind: "binary",
      editable: false,
      content: null,
      previewText: null,
    });
  });

  test("opens large text files as truncated read-only previews", async () => {
    writeFileSync(
      join(tempDir, "workspace", "large.txt"),
      "a".repeat(600 * 1024),
    );
    const { response, body } = await get("/api/files/read?path=large.txt");
    expect(response.status).toBe(200);
    expect(body.file.kind).toBe("text");
    expect(body.file.editable).toBe(false);
    expect(body.file.content).toBeNull();
    expect(body.file.truncated).toBe(true);
    expect(body.file.previewText.length).toBeLessThan(600 * 1024);
  });
});
