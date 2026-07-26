import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalUiServer } from "../../cli/src/localUiServer.js";
import { useFilesStore } from "../src/files/filesStore";

let tempDir: string;
let server: Awaited<ReturnType<typeof startLocalUiServer>>;
let baseUrl: string;
let originalFetch: typeof fetch;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "smithers-ui-files-"));
  mkdirSync(join(tempDir, "dist"));
  writeFileSync(join(tempDir, "dist", "index.html"), "<main>ui</main>");
  mkdirSync(join(tempDir, "workspace", "src"), { recursive: true });
  writeFileSync(join(tempDir, "workspace", "src", "note.txt"), "first\n");
  writeFileSync(join(tempDir, "workspace", "README.md"), "# readme\n");

  server = await startLocalUiServer({
    distDir: join(tempDir, "dist"),
    gatewayBase: "http://127.0.0.1:1",
    port: 0,
    workspaceRoot: join(tempDir, "workspace"),
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" && input.startsWith("/") ? `${baseUrl}${input}` : input;
    const headers = new Headers(init?.headers);
    if (!headers.has("origin")) headers.set("origin", baseUrl);
    return originalFetch(url, { ...init, headers });
  }) as typeof fetch;
  useFilesStore.getState().reset();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  useFilesStore.getState().reset();
  if (server) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  rmSync(tempDir, { recursive: true, force: true });
});

describe("files store", () => {
  test("loads the workspace root tree", async () => {
    await useFilesStore.getState().loadTree("");
    const state = useFilesStore.getState();
    expect(state.treeByPath[""].map((entry) => [entry.name, entry.type])).toEqual([
      ["src", "directory"],
      ["README.md", "file"],
    ]);
  });

  test("selects, edits, and saves a text file through the local API", async () => {
    await useFilesStore.getState().selectFile("src/note.txt");
    expect(useFilesStore.getState().draft).toBe("first\n");

    useFilesStore.getState().editDraft("second\n");
    expect(useFilesStore.getState().draft).toBe("second\n");

    await useFilesStore.getState().saveSelected();
    const state = useFilesStore.getState();
    expect(state.saveError).toBeNull();
    expect(state.saved).toBe("second\n");
    expect(state.file?.revision).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(readFileSync(join(tempDir, "workspace", "src", "note.txt"), "utf8")).toBe("second\n");
  });

  test("reports a conflict instead of clobbering a file changed since the read", async () => {
    await useFilesStore.getState().selectFile("src/note.txt");
    useFilesStore.getState().editDraft("mine\n");
    writeFileSync(join(tempDir, "workspace", "src", "note.txt"), "theirs\n");

    await useFilesStore.getState().saveSelected();
    const state = useFilesStore.getState();
    expect(state.saveError).toContain("changed on disk");
    expect(readFileSync(join(tempDir, "workspace", "src", "note.txt"), "utf8")).toBe("theirs\n");
  });
});
