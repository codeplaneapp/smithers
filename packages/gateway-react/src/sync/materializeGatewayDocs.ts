import { emitSyncTelemetry, gatewayKeys, syncKeyFingerprint, type GatewayDocRow } from "@smithers-orchestrator/gateway-client";

export type GatewayDocMaterializerFs = {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, content: string, encoding: "utf8"): Promise<unknown>;
  rm(path: string, options: { force: true }): Promise<unknown>;
  /**
   * Optional: read the on-disk file so the materializer can compare against the
   * row before overwriting. When provided, a write whose content already matches
   * disk is skipped (counted as `unchanged`) rather than clobbering it; when
   * absent the materializer always writes (last-write-wins from the row).
   */
  readFile?(path: string, encoding: "utf8"): Promise<string>;
};

export type MaterializeGatewayDocsResult = {
  written: number;
  deleted: number;
  skipped: number;
  unchanged: number;
};

async function readExisting(fs: GatewayDocMaterializerFs, path: string): Promise<string | undefined> {
  if (typeof fs.readFile !== "function") return undefined;
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function normalizeDocPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/").replace(/^\.smithers\/+/, "").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2 || parts.some((part) => part === "." || part === ".." || part === ".git" || part === ".jj")) {
    return undefined;
  }
  if (!["tickets", "plans", "specs", "proposals", "conflicts"].includes(parts[0])) {
    return undefined;
  }
  if (parts[0] !== "conflicts" && !parts[parts.length - 1].endsWith(".md")) {
    return undefined;
  }
  return parts.join("/");
}

function joinPath(...parts: string[]): string {
  return parts
    .map((part, index) => index === 0 ? part.replace(/\/+$/g, "") : part.replace(/^\/+|\/+$/g, ""))
    .filter((part) => part.length > 0)
    .join("/");
}

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function emitMaterializeTelemetry(type: "docs.materialize.write" | "docs.materialize.delete", row: GatewayDocRow): void {
  emitSyncTelemetry({
    type,
    collectionId: syncKeyFingerprint(gatewayKeys.tickets({})),
    key: gatewayKeys.tickets({}),
    count: 1,
    method: "materializeDocs",
    scope: row.kind,
    path: row.path,
    kind: row.kind,
    hash: row.contentHash,
  });
}

export async function materializeGatewayDocs(options: {
  rows: readonly GatewayDocRow[];
  rootDir: string;
  fs: GatewayDocMaterializerFs;
}): Promise<MaterializeGatewayDocsResult> {
  const root = joinPath(options.rootDir, ".smithers");
  let written = 0;
  let deleted = 0;
  let skipped = 0;
  let unchanged = 0;
  for (const row of options.rows) {
    const docPath = normalizeDocPath(row.path);
    if (!docPath) {
      skipped += 1;
      continue;
    }
    const target = joinPath(root, docPath);
    if (row.deletedAtMs != null) {
      const existing = await readExisting(options.fs, target);
      // Nothing on disk to delete: skip the rm + telemetry so a tombstone for an
      // already-absent file is a no-op rather than a phantom delete.
      if (typeof options.fs.readFile === "function" && existing === undefined) {
        unchanged += 1;
        continue;
      }
      await options.fs.rm(target, { force: true });
      emitMaterializeTelemetry("docs.materialize.delete", row);
      deleted += 1;
      continue;
    }
    // Compare against disk before overwriting: an identical file is left alone
    // (no churn, no clobber of a byte-identical local copy).
    const existing = await readExisting(options.fs, target);
    if (existing === row.content) {
      unchanged += 1;
      continue;
    }
    await options.fs.mkdir(parentDir(target), { recursive: true });
    await options.fs.writeFile(target, row.content, "utf8");
    emitMaterializeTelemetry("docs.materialize.write", row);
    written += 1;
  }
  return { written, deleted, skipped, unchanged };
}
