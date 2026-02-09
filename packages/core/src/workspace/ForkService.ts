import { promises as fs } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createHash, randomUUID } from "crypto";
import type { ForkCodeMode, ForkDiffDTO, ForkPoint, WorkspaceStatusDTO } from "@smithers/shared";
import { AppDb } from "../db";
import type { WorkspaceService } from "./WorkspaceService";
import type { AgentService } from "../agent/AgentService";
import type { SmithersService } from "../smithers/SmithersService";

const DEFAULT_IGNORE = new Set([".git", ".jj", ".smithers", "node_modules", "dist", "build", "views"]);

export type ForkServiceOptions = {
  db: AppDb;
  workspace: WorkspaceService;
  agent: AgentService;
  smithers: SmithersService;
  emitStatus?: (status: WorkspaceStatusDTO) => void;
  emitMergeProgress?: (payload: { mergeId: string; status: string; conflicts?: string[] }) => void;
};

type SnapshotRecord = {
  snapshotId: string;
  sessionId?: string | null;
  messageSeq?: number | null;
  forkPoint?: string | null;
  workspaceRoot?: string | null;
  snapshotType: string;
  ref: string;
  createdAtMs: number;
  metadataJson?: string | null;
};

type ForkRecord = {
  forkId: string;
  sessionId: string;
  sourceSessionId: string;
  messageSeq: number;
  forkPoint: ForkPoint;
  codeMode: ForkCodeMode;
  snapshotId?: string | null;
  sandboxRoot?: string | null;
  sourceRoot?: string | null;
  createdAtMs: number;
};

export class ForkService {
  private db: AppDb;
  private workspace: WorkspaceService;
  private agent: AgentService;
  private smithers: SmithersService;
  private emitStatus?: ForkServiceOptions["emitStatus"];
  private emitMergeProgress?: ForkServiceOptions["emitMergeProgress"];
  private dirty = false;
  private status: WorkspaceStatusDTO = { activeRoot: null };
  private primaryRoot: string | null;

  constructor(opts: ForkServiceOptions) {
    this.db = opts.db;
    this.workspace = opts.workspace;
    this.agent = opts.agent;
    this.smithers = opts.smithers;
    this.emitStatus = opts.emitStatus;
    this.emitMergeProgress = opts.emitMergeProgress;
    this.primaryRoot = this.workspace.getRoot();
    this.status.activeRoot = this.primaryRoot;
  }

  markDirty() {
    this.dirty = true;
    this.emit();
  }

  clearDirty() {
    this.dirty = false;
    this.emit();
  }

  getStatus(): WorkspaceStatusDTO {
    return { ...this.status, isDirty: this.dirty };
  }

  setActiveRoot(root: string | null) {
    this.status.activeRoot = root;
    this.emit();
  }

  resetStatus(root: string | null) {
    this.primaryRoot = root;
    this.status = {
      activeForkId: null,
      activeRoot: root,
      codeStateRef: null,
      codeStateType: null,
    };
    this.clearDirty();
    this.emit();
  }

  private emit() {
    this.emitStatus?.(this.getStatus());
  }

  listForks(sessionId: string): ForkRecord[] {
    return this.db.listForksForSession(sessionId) as ForkRecord[];
  }

  getForkForSession(sessionId: string): ForkRecord | null {
    const fork = this.db.getForkForSession(sessionId) as ForkRecord | null;
    return fork ?? null;
  }

  async forkChat(params: {
    sessionId: string;
    messageSeq: number;
    forkPoint: ForkPoint;
    includeCode: boolean;
    codeMode: ForkCodeMode;
    fanout?: number;
    snapshotStrategy?: "nearest" | "capture";
  }): Promise<{ sessionIds: string[]; forkIds: string[] }> {
    const fanout = Math.max(1, params.fanout ?? 1);
    const messageSeq = Math.max(0, params.messageSeq);
    const codeMode = params.includeCode ? params.codeMode : "context_only";
    const forkIds: string[] = [];
    const sessionIds: string[] = [];

    if (params.includeCode && !this.workspace.getRoot()) {
      throw new Error("Open a workspace before forking code state.");
    }

    for (let i = 0; i < fanout; i += 1) {
      const forkId = randomUUID();
      const titleSuffix = fanout > 1 ? ` (Fork ${i + 1})` : " (Fork)";
      const sessionId = this.db.forkSession({
        sourceSessionId: params.sessionId,
        messageSeq,
        forkPoint: params.forkPoint,
        title: `Fork${titleSuffix}`,
      });

      let snapshotId: string | null = null;
      let sandboxRoot: string | null = null;

      if (params.includeCode) {
        const snapshot = await this.resolveSnapshot({
          sessionId: params.sessionId,
          messageSeq,
          forkPoint: params.forkPoint,
          strategy: params.snapshotStrategy ?? "capture",
        });
        snapshotId = snapshot?.snapshotId ?? null;

        if (codeMode === "sandboxed") {
          sandboxRoot = await this.createSandboxRoot({
            forkId,
            snapshot,
          });
        }
      }

      this.db.insertWorkspaceFork({
        forkId,
        sessionId,
        sourceSessionId: params.sessionId,
        messageSeq,
        forkPoint: params.forkPoint,
        codeMode,
        snapshotId,
        sandboxRoot,
        sourceRoot: this.workspace.getRoot(),
        createdAtMs: Date.now(),
      });

      forkIds.push(forkId);
      sessionIds.push(sessionId);
    }

    return { forkIds, sessionIds };
  }

  async activateCodeState(params: { sessionId: string; force?: boolean }): Promise<WorkspaceStatusDTO> {
    const fork = this.getForkForSession(params.sessionId);

    if (this.dirty && !params.force) {
      throw new Error("Workspace has uncommitted changes.");
    }

    if (!fork) {
      this.status = {
        activeForkId: null,
        activeRoot: this.workspace.getRoot(),
        codeStateRef: null,
        codeStateType: null,
      };
      this.emit();
      return this.getStatus();
    }

    if (fork.codeMode === "sandboxed") {
      if (!fork.sandboxRoot) {
        throw new Error("Sandbox root is missing for this fork.");
      }
      await this.switchWorkspaceRoot(fork.sandboxRoot);
      this.status = {
        activeForkId: fork.forkId,
        activeRoot: fork.sandboxRoot,
        codeStateRef: fork.snapshotId ?? null,
        codeStateType: fork.snapshotId ? "fs" : null,
      };
    } else if (fork.codeMode === "shared") {
      if (!fork.snapshotId) {
        throw new Error("No snapshot recorded for this fork.");
      }
      const snapshot = await this.getSnapshotById(fork.snapshotId);
      if (!snapshot) {
        throw new Error("Snapshot not found.");
      }
      await this.restoreSnapshot(snapshot);
      this.status = {
        activeForkId: fork.forkId,
        activeRoot: this.workspace.getRoot(),
        codeStateRef: snapshot.snapshotId,
        codeStateType: snapshot.snapshotType as any,
      };
      this.clearDirty();
    } else {
      this.status = {
        activeForkId: fork.forkId,
        activeRoot: this.workspace.getRoot(),
        codeStateRef: null,
        codeStateType: null,
      };
    }

    this.emit();
    return this.getStatus();
  }

  async previewForkMerge(params: { forkId: string; targetSessionId?: string }): Promise<ForkDiffDTO[]> {
    const fork = await this.getForkById(params.forkId);
    if (!fork) {
      throw new Error("Fork not found.");
    }
    const sourceRoot = fork.sandboxRoot ?? this.workspace.getRoot();
    const targetRoot = params.targetSessionId
      ? await this.resolveTargetRoot(params.targetSessionId)
      : fork.sourceRoot ?? this.primaryRoot ?? this.workspace.getRoot();
    if (!sourceRoot || !targetRoot) return [];
    return await diffDirs(sourceRoot, targetRoot, DEFAULT_IGNORE);
  }

  async mergeFork(params: {
    forkId: string;
    targetSessionId?: string;
    mode: "diff_apply" | "vcs";
    files?: string[];
  }): Promise<{ ok: true; appliedFiles?: string[]; conflicts?: string[] }> {
    if (params.mode === "vcs") {
      throw new Error("VCS merge is not implemented yet.");
    }

    const mergeId = randomUUID();
    this.emitMergeProgress?.({ mergeId, status: "computing" });

    const changes = await this.previewForkMerge({
      forkId: params.forkId,
      targetSessionId: params.targetSessionId,
    });

    const filtered = params.files && params.files.length
      ? changes.filter((c) => params.files!.includes(c.path))
      : changes;

    this.emitMergeProgress?.({ mergeId, status: "applying" });

    const fork = await this.getForkById(params.forkId);
    if (!fork) {
      throw new Error("Fork not found.");
    }
    const sourceRoot = fork.sandboxRoot ?? this.workspace.getRoot();
    const targetRoot = params.targetSessionId
      ? await this.resolveTargetRoot(params.targetSessionId)
      : fork.sourceRoot ?? this.primaryRoot ?? this.workspace.getRoot();
    if (!sourceRoot || !targetRoot) {
      return { ok: true, appliedFiles: [] };
    }

    const applied: string[] = [];
    for (const change of filtered) {
      const srcPath = join(sourceRoot, change.path);
      const dstPath = join(targetRoot, change.path);
      if (change.status === "deleted") {
        await safeRemove(dstPath);
        applied.push(change.path);
        continue;
      }
      await fs.mkdir(dirname(dstPath), { recursive: true });
      await fs.copyFile(srcPath, dstPath);
      applied.push(change.path);
    }

    if (targetRoot === this.workspace.getRoot()) {
      this.markDirty();
    }
    this.emitMergeProgress?.({ mergeId, status: "done" });
    return { ok: true, appliedFiles: applied };
  }

  private async resolveSnapshot(params: {
    sessionId: string;
    messageSeq: number;
    forkPoint: ForkPoint;
    strategy: "nearest" | "capture";
  }): Promise<SnapshotRecord | null> {
    const exact = this.db.getSnapshotForMessage({
      sessionId: params.sessionId,
      messageSeq: params.messageSeq,
      forkPoint: params.forkPoint,
    }) as SnapshotRecord | null;
    if (exact) return exact;

    if (params.strategy === "nearest") {
      const nearest = this.db.getNearestSnapshot({
        sessionId: params.sessionId,
        messageSeq: params.messageSeq,
      }) as SnapshotRecord | null;
      if (nearest) return nearest;
    }

    return await this.createSnapshot({
      sessionId: params.sessionId,
      messageSeq: params.messageSeq,
      forkPoint: params.forkPoint,
      metadata: {
        strategy: params.strategy,
        approximate: true,
      },
    });
  }

  private async createSnapshot(params: {
    sessionId: string;
    messageSeq: number;
    forkPoint: ForkPoint;
    metadata?: Record<string, unknown>;
  }): Promise<SnapshotRecord | null> {
    const root = this.workspace.getRoot();
    if (!root) return null;

    const snapshotId = randomUUID();
    const snapshotDir = join(root, ".smithers", "snapshots", snapshotId);
    await fs.mkdir(snapshotDir, { recursive: true });
    await copyDir(root, snapshotDir, DEFAULT_IGNORE);

    const record: SnapshotRecord = {
      snapshotId,
      sessionId: params.sessionId,
      messageSeq: params.messageSeq,
      forkPoint: params.forkPoint,
      workspaceRoot: root,
      snapshotType: "fs",
      ref: snapshotDir,
      createdAtMs: Date.now(),
      metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
    };

    this.db.insertWorkspaceSnapshot(record);
    return record;
  }

  private async createSandboxRoot(params: { forkId: string; snapshot: SnapshotRecord | null }): Promise<string | null> {
    const root = this.workspace.getRoot();
    if (!root) return null;
    const sandboxRoot = join(root, ".smithers", "forks", params.forkId);
    await fs.mkdir(sandboxRoot, { recursive: true });

    const sourceDir = params.snapshot?.snapshotType === "fs" ? params.snapshot.ref : root;
    await copyDir(sourceDir, sandboxRoot, DEFAULT_IGNORE);
    return sandboxRoot;
  }

  private async restoreSnapshot(snapshot: SnapshotRecord) {
    const root = this.workspace.getRoot();
    if (!root) return;
    if (snapshot.snapshotType !== "fs") return;
    await clearDir(root, DEFAULT_IGNORE);
    await copyDir(snapshot.ref, root, DEFAULT_IGNORE);
  }

  private async getSnapshotById(snapshotId: string): Promise<SnapshotRecord | null> {
    const record = this.db.getSnapshotById(snapshotId) as SnapshotRecord | null;
    return record ?? null;
  }

  private async getForkById(forkId: string): Promise<ForkRecord | null> {
    const record = this.db.getForkById(forkId) as ForkRecord | null;
    return record ?? null;
  }

  private async resolveTargetRoot(targetSessionId: string | null): Promise<string | null> {
    if (!targetSessionId) return this.primaryRoot ?? this.workspace.getRoot();
    const fork = this.getForkForSession(targetSessionId);
    if (fork?.sandboxRoot) return fork.sandboxRoot;
    if (fork?.sourceRoot) return fork.sourceRoot;
    return this.primaryRoot ?? this.workspace.getRoot();
  }

  private async switchWorkspaceRoot(root: string) {
    await this.workspace.setRoot(root);
    this.agent.setWorkspaceRoot(root ?? process.cwd());
    this.smithers.setWorkspaceRoot(root ?? process.cwd());
    this.status.activeRoot = root;
    this.clearDirty();
  }
}

async function copyDir(src: string, dest: string, ignore: Set<string>) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  await fs.mkdir(dest, { recursive: true });
  for (const entry of entries) {
    if (ignore.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to, ignore);
    } else if (entry.isSymbolicLink()) {
      const link = await fs.readlink(from);
      await fs.symlink(link, to);
    } else if (entry.isFile()) {
      await fs.mkdir(dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
  }
}

async function clearDir(root: string, ignore: Set<string>) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (ignore.has(entry.name)) continue;
    const target = join(root, entry.name);
    if (entry.isDirectory()) {
      await fs.rm(target, { recursive: true, force: true });
    } else {
      await fs.rm(target, { force: true });
    }
  }
}

async function safeRemove(path: string) {
  try {
    await fs.rm(path, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function diffDirs(sourceRoot: string, targetRoot: string, ignore: Set<string>): Promise<ForkDiffDTO[]> {
  const sourceFiles = await listFiles(sourceRoot, ignore);
  const targetFiles = await listFiles(targetRoot, ignore);
  const changes: ForkDiffDTO[] = [];

  const allPaths = new Set<string>([...sourceFiles.keys(), ...targetFiles.keys()]);
  for (const p of allPaths) {
    const sourceHash = sourceFiles.get(p);
    const targetHash = targetFiles.get(p);
    if (sourceHash && !targetHash) {
      changes.push({ path: p, status: "added" });
      continue;
    }
    if (!sourceHash && targetHash) {
      changes.push({ path: p, status: "deleted" });
      continue;
    }
    if (sourceHash && targetHash && sourceHash !== targetHash) {
      changes.push({ path: p, status: "modified" });
    }
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function listFiles(root: string, ignore: Set<string>): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const stack: string[] = [root];

  while (stack.length) {
    const dir = stack.pop()!;
    let entries: Array<import("node:fs").Dirent> = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relPath = relative(root, full);
      const hash = await hashFile(full);
      results.set(relPath, hash);
    }
  }

  return results;
}

async function hashFile(path: string): Promise<string> {
  const data = await fs.readFile(path);
  return createHash("sha1").update(data).digest("hex");
}
