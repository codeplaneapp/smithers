import { readdir, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { basename, resolve, relative } from "node:path";
import type { WorkflowRef } from "../../shared/rpc";

const DEFAULT_IGNORE = new Set(["node_modules", ".git", ".smithers", "dist", "build", "views"]);

export type WorkspaceState = {
  root: string | null;
  workflows: WorkflowRef[];
};

export class WorkspaceService {
  private root: string | null;
  private workflows: WorkflowRef[] = [];
  private watcher: FSWatcher | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private onChange?: (state: WorkspaceState) => void;

  constructor(opts: { root?: string | null; onChange?: (state: WorkspaceState) => void } = {}) {
    this.root = opts.root ?? null;
    this.onChange = opts.onChange;
  }

  getRoot() {
    return this.root;
  }

  async setRoot(path: string | null) {
    if (!path) {
      this.root = null;
      this.workflows = [];
      this.stopWatcher();
      this.emitChange();
      return;
    }
    const resolved = resolve(path);
    const stats = await stat(resolved);
    if (!stats.isDirectory()) {
      throw new Error(`Workspace is not a directory: ${resolved}`);
    }
    if (this.root === resolved) return;
    this.root = resolved;
    await this.refreshWorkflows();
    this.startWatcher();
  }

  async getState(): Promise<WorkspaceState> {
    if (this.root && this.workflows.length === 0) {
      await this.refreshWorkflows();
    }
    return { root: this.root, workflows: this.workflows };
  }

  async listWorkflows(rootOverride?: string): Promise<WorkflowRef[]> {
    const base = rootOverride ? resolve(rootOverride) : this.root;
    if (!base) return [];
    return scanWorkflows(base);
  }

  private async refreshWorkflows() {
    if (!this.root) {
      this.workflows = [];
      this.emitChange();
      return;
    }
    const next = await scanWorkflows(this.root);
    if (!sameWorkflowList(this.workflows, next)) {
      this.workflows = next;
      this.emitChange();
    }
  }

  private scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshWorkflows();
    }, 250);
  }

  private startWatcher() {
    this.stopWatcher();
    if (!this.root) return;
    try {
      this.watcher = watch(this.root, { recursive: true }, () => {
        this.scheduleRefresh();
      });
    } catch {
      // ignore watcher failures; users can refresh manually
    }
  }

  private stopWatcher() {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore
      }
      this.watcher = null;
    }
  }

  private emitChange() {
    this.onChange?.({ root: this.root, workflows: this.workflows });
  }
}

async function scanWorkflows(root: string): Promise<WorkflowRef[]> {
  const files = await walkDir(root);
  return files
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => ({
      path: relative(root, file),
      name: basename(file, ".tsx"),
    }));
}

async function walkDir(root: string, ignore = DEFAULT_IGNORE): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    if (ignore.has(entry.name)) continue;
    const full = resolve(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkDir(full, ignore)));
    } else {
      results.push(full);
    }
  }
  return results;
}

function sameWorkflowList(a: WorkflowRef[], b: WorkflowRef[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.path !== b[i]!.path) return false;
  }
  return true;
}
