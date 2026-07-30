import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
  writeFileSync(join(tempDir, "workspace", "src", "index.ts"), "export const value = 1;\n");
  server = await startLocalUiServer({
    distDir: join(tempDir, "dist"),
    gatewayBase: "http://127.0.0.1:1",
    port: 0,
    workspaceRoot: join(tempDir, "workspace"),
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
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
  async function getWithHost(path, host) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { host } });
    return { response };
  }

  test("loads a lazy directory tree rooted at the workspace", async () => {
    const { response, body } = await get("/api/files/tree?path=");
    expect(response.status).toBe(200);
    expect(body.entries.map((entry) => [entry.name, entry.type])).toEqual([
      ["src", "directory"],
      ["README.md", "file"],
    ]);
    expect(body.entries.find((entry) => entry.name === "README.md")).toMatchObject({
      path: "README.md",
      previewable: true,
      editable: true,
    });
  });

  test("sorts large directory trees before truncating them", async () => {
    const largeDir = join(tempDir, "workspace", "large");
    mkdirSync(largeDir);
    for (let index = 1001; index >= 0; index -= 1) {
      writeFileSync(join(largeDir, `file-${String(index).padStart(4, "0")}.txt`), "");
    }
    mkdirSync(join(largeDir, "z-directory"));
    mkdirSync(join(largeDir, "a-directory"));

    const { response, body } = await get("/api/files/tree?path=large");

    expect(response.status).toBe(200);
    expect(body.truncated).toBe(true);
    expect(body.entries).toHaveLength(1000);
    expect(body.entries.map((entry) => entry.name)).toEqual([
      "a-directory",
      "z-directory",
      ...Array.from({ length: 998 }, (_, index) => `file-${String(index).padStart(4, "0")}.txt`),
    ]);
  });

  test("rejects file reads with a non-loopback (DNS-rebinding) Host header", async () => {
    const { response } = await getWithHost("/api/files/read?path=README.md", "attacker.example:80");
    expect(response.status).toBe(403);
  });

  test("rejects file tree with a non-loopback Host header", async () => {
    const { response } = await getWithHost("/api/files/tree?path=", "attacker.example:80");
    expect(response.status).toBe(403);
  });

  test("rejects file reads carrying a cross-origin Origin header", async () => {
    const response = await fetch(`${baseUrl}/api/files/read?path=README.md`, {
      headers: { origin: "http://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  test("still serves same-origin reads (loopback Host, no Origin)", async () => {
    const { response, body } = await get("/api/files/read?path=README.md");
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
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
      symlinkSync(join(tempDir, "outside.txt"), join(tempDir, "workspace", "escape.txt"));
    } catch {
      return;
    }

    const { response, body } = await get("/api/files/read?path=escape.txt");
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("PATH_OUTSIDE_ROOT");
  });

  test("saves valid nested workspace files and returns the new revision", async () => {
    const read = await get("/api/files/read?path=src/index.ts");
    expect(read.body.file.revision).toMatch(/^sha256-[0-9a-f]{64}$/);

    const { response, body } = await postFileWrite({
      path: "src/index.ts",
      content: "export const value = 2;\n",
      revision: read.body.file.revision,
    });
    expect(response.status).toBe(200);
    expect(body.file).toMatchObject({
      path: "src/index.ts",
      editable: true,
      content: "export const value = 2;\n",
    });
    expect(body.file.revision).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(body.file.revision).not.toBe(read.body.file.revision);

    // The returned revision is immediately usable for the next save.
    const next = await postFileWrite({
      path: "src/index.ts",
      content: "export const value = 3;\n",
      revision: body.file.revision,
    });
    expect(next.response.status).toBe(200);
  });

  test("rejects a stale reader's save with 409 and leaves the newer file alone", async () => {
    const read = await get("/api/files/read?path=src/index.ts");
    // Someone else (an agent, another editor) writes the file after the read.
    writeFileSync(join(tempDir, "workspace", "src", "index.ts"), "export const value = 99;\n");

    const { response, body } = await postFileWrite({
      path: "src/index.ts",
      content: "export const value = 2;\n",
      revision: read.body.file.revision,
    });
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("STALE_REVISION");
    expect(readFileSync(join(tempDir, "workspace", "src", "index.ts"), "utf8")).toBe("export const value = 99;\n");
  });

  test("leaves the original file intact when the save cannot be written", async () => {
    const dir = join(tempDir, "workspace", "src");
    const read = await get("/api/files/read?path=src/index.ts");

    // Simulate a failing write: the file itself stays readable and writable,
    // but its directory refuses the temp file the atomic save needs.
    chmodSync(dir, 0o555);
    try {
      // Root ignores directory permissions, so the failure cannot be staged.
      try {
        writeFileSync(join(dir, ".probe"), "x");
        rmSync(join(dir, ".probe"), { force: true });
        return;
      } catch {
        // Expected: the directory is genuinely read-only for this process.
      }

      const { response, body } = await postFileWrite({
        path: "src/index.ts",
        content: "export const value = 2;\n",
        revision: read.body.file.revision,
      });
      expect(response.status).toBe(500);
      expect(body.error.code).toBe("WRITE_FAILED");
      expect(readFileSync(join(dir, "index.ts"), "utf8")).toBe("export const value = 1;\n");
      // No temp debris left behind.
      expect(readdirSync(dir)).toEqual(["index.ts"]);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("preserves the target's mode bits across a save", async () => {
    const target = join(tempDir, "workspace", "src", "index.ts");
    chmodSync(target, 0o640);
    const read = await get("/api/files/read?path=src/index.ts");

    const { response } = await postFileWrite({
      path: "src/index.ts",
      content: "export const value = 2;\n",
      revision: read.body.file.revision,
    });
    expect(response.status).toBe(200);
    expect(statSync(target).mode & 0o777).toBe(0o640);
    expect(readFileSync(target, "utf8")).toBe("export const value = 2;\n");
  });

  test("rejects a save that omits the revision", async () => {
    const { response, body } = await postFileWrite({
      path: "src/index.ts",
      content: "export const value = 4;\n",
    });
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("MISSING_REVISION");
    expect(readFileSync(join(tempDir, "workspace", "src", "index.ts"), "utf8")).toBe("export const value = 1;\n");
  });

  test("rejects file writes from a cross-origin browser request", async () => {
    const read = await get("/api/files/read?path=src/index.ts");
    const { response, body } = await postFileWrite(
      {
        path: "src/index.ts",
        content: "export const value = 3;\n",
        revision: read.body.file.revision,
      },
      "https://evil.example",
    );
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN_ORIGIN");
  });

  test("does not load binary files into editable content", async () => {
    writeFileSync(join(tempDir, "workspace", "blob.bin"), Buffer.from([0, 1, 2, 3, 4]));
    const { response, body } = await get("/api/files/read?path=blob.bin");
    expect(response.status).toBe(200);
    expect(body.file).toMatchObject({
      kind: "binary",
      editable: false,
      content: null,
      previewText: null,
      revision: null,
    });
  });

  test("opens large text files as truncated read-only previews", async () => {
    writeFileSync(join(tempDir, "workspace", "large.txt"), "a".repeat(600 * 1024));
    const { response, body } = await get("/api/files/read?path=large.txt");
    expect(response.status).toBe(200);
    expect(body.file.kind).toBe("text");
    expect(body.file.editable).toBe(false);
    expect(body.file.content).toBeNull();
    expect(body.file.revision).toBeNull();
    expect(body.file.truncated).toBe(true);
    expect(body.file.previewText.length).toBeLessThan(600 * 1024);
  });
});
