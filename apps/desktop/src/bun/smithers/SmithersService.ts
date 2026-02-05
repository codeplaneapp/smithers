import { randomUUID } from "crypto";
import { resolve, relative, basename } from "node:path";
import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type {
  ApprovalDTO,
  FrameSnapshotDTO,
  RunAttemptsDTO,
  RunDetailDTO,
  RunOutputsDTO,
  RunToolCallsDTO,
  RunStatus,
  RunSummaryDTO,
  SmithersEventDTO,
  WorkflowNodeDTO,
  WorkflowRef,
  WorkflowCardMessage,
} from "../../shared/rpc";
import { AppDb } from "../db";
import { approveNode as approveNodeEngine, denyNode as denyNodeEngine } from "../../../../../src/engine/approvals";
import { runWorkflow as runWorkflowEngine } from "../../../../../src/index";
import { ensureSmithersTables } from "../../../../../src/db/ensure";
import { SmithersDb } from "../../../../../src/db/adapter";
import type { SmithersEvent, SmithersWorkflow } from "../../../../../src/types";
import { loadOutputs } from "../../../../../src/db/snapshot";
import type { XmlNode } from "../../../../../src/types";

export type SmithersServiceOptions = {
  db: AppDb;
  workspaceRoot: string;
  emitWorkflowEvent: (event: SmithersEventDTO & { seq: number }) => void;
  emitWorkflowFrame: (frame: FrameSnapshotDTO) => void;
  emitChatMessage: (sessionId: string, message: WorkflowCardMessage) => void;
};

type WorkflowModule = {
  default: SmithersWorkflow<any>;
  schema?: Record<string, any>;
};

type RunHandle = {
  runId: string;
  workflowPath: string;
  workflowName: string;
  workflow: SmithersWorkflow<any>;
  schema?: Record<string, any>;
  adapter: SmithersDb;
  db: BunSQLiteDatabase<any>;
  status: RunStatus;
  startedAtMs: number;
  attachedSessionId?: string | null;
  abort: AbortController;
};

const DEFAULT_IGNORE = new Set(["node_modules", ".git", ".smithers", "dist", "build", "views"]);

export class SmithersService {
  private db: AppDb;
  private workspaceRoot: string;
  private emitWorkflowEvent: SmithersServiceOptions["emitWorkflowEvent"];
  private emitWorkflowFrame: SmithersServiceOptions["emitWorkflowFrame"];
  private emitChatMessage: SmithersServiceOptions["emitChatMessage"];
  private runHandles = new Map<string, RunHandle>();
  private workflowCache = new Map<string, WorkflowModule>();

  constructor(opts: SmithersServiceOptions) {
    this.db = opts.db;
    this.workspaceRoot = opts.workspaceRoot;
    this.emitWorkflowEvent = opts.emitWorkflowEvent;
    this.emitWorkflowFrame = opts.emitWorkflowFrame;
    this.emitChatMessage = opts.emitChatMessage;
  }

  setWorkspaceRoot(root: string) {
    this.workspaceRoot = root;
    this.workflowCache.clear();
  }

  async listWorkflows(root?: string): Promise<WorkflowRef[]> {
    const base = root ? resolve(root) : this.workspaceRoot;
    if (!base) return [];
    const files = await walkDir(base);
    return files
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => ({
        path: relative(base, file),
        name: basename(file, ".tsx"),
      }));
  }

  listRuns(status?: "active" | "finished" | "failed" | "all") {
    return this.db.listWorkflowRuns(status);
  }

  getRun(runId: string): RunDetailDTO {
    const detail = this.db.getRunDetail(runId);
    if (!detail) {
      throw new Error(`Run not found: ${runId}`);
    }
    return detail;
  }

  getRunEvents(runId: string, afterSeq?: number) {
    return this.db.listWorkflowEvents(runId, afterSeq ?? -1);
  }

  getFrame(runId: string, frameNo?: number): FrameSnapshotDTO {
    const frame = this.db.getWorkflowFrame(runId, frameNo);
    if (!frame) {
      throw new Error(`Frame not found for run ${runId}`);
    }
    return frame;
  }

  async runWorkflow(params: { workflowPath: string; input: any; attachToSessionId?: string }): Promise<string> {
    if (!this.workspaceRoot) {
      throw new Error("Workspace root not set");
    }
    const workflowPath = resolve(this.workspaceRoot, params.workflowPath);
    const module = await this.loadWorkflow(workflowPath);
    const workflow = module.default;
    const schema = module.schema;
    const runId = randomUUID();

    const workflowName = basename(workflowPath, ".tsx");
    const startedAtMs = Date.now();
    const adapter = new SmithersDb(workflow.db as any);
    ensureSmithersTables(workflow.db as any);

    const abort = new AbortController();
    const handle: RunHandle = {
      runId,
      workflowPath,
      workflowName,
      workflow,
      schema,
      adapter,
      db: workflow.db as any,
      status: "running",
      startedAtMs,
      attachedSessionId: params.attachToSessionId ?? null,
      abort,
    };
    this.runHandles.set(runId, handle);

    this.db.upsertWorkflowRun({
      runId,
      workflowPath: params.workflowPath,
      workflowName,
      status: "running",
      startedAtMs,
      finishedAtMs: null,
      attachedSessionId: params.attachToSessionId ?? null,
      inputJson: JSON.stringify(params.input ?? {}),
      workspaceRoot: this.workspaceRoot,
    });

    if (handle.attachedSessionId) {
      const message: WorkflowCardMessage = {
        role: "workflow",
        type: "smithers.workflow.card",
        runId,
        workflowName,
        status: "running",
        timestamp: Date.now(),
      };
      this.emitChatMessage(handle.attachedSessionId, message);
    }

    void this.executeRun(handle, { input: params.input, resume: false });

    return runId;
  }

  async resumeRun(runId: string) {
    const handle = await this.getOrLoadRunHandle(runId);
    if (!handle) throw new Error(`Run not found: ${runId}`);
    handle.status = "running";
    this.db.updateWorkflowRun(runId, { status: "running" });
    void this.executeRun(handle, { input: {}, resume: true });
  }

  async cancelRun(runId: string) {
    const handle = this.runHandles.get(runId);
    if (handle) {
      handle.abort.abort();
      handle.status = "cancelled";
      this.db.updateWorkflowRun(runId, { status: "cancelled", finishedAtMs: Date.now() });
    }
  }

  async approveNode(runId: string, nodeId: string, iteration = 0, note?: string) {
    const handle = await this.getOrLoadRunHandle(runId);
    if (!handle) throw new Error(`Run not found: ${runId}`);
    await approveNodeEngine(handle.adapter, runId, nodeId, iteration, note ?? undefined);
    const event: SmithersEventDTO = {
      type: "ApprovalGranted",
      runId,
      nodeId,
      iteration,
      timestampMs: Date.now(),
    };
    this.applyEvent(runId, event);
    await this.resumeRun(runId);
  }

  async denyNode(runId: string, nodeId: string, iteration = 0, note?: string) {
    const handle = await this.getOrLoadRunHandle(runId);
    if (!handle) throw new Error(`Run not found: ${runId}`);
    await denyNodeEngine(handle.adapter, runId, nodeId, iteration, note ?? undefined);
    const event: SmithersEventDTO = {
      type: "ApprovalDenied",
      runId,
      nodeId,
      iteration,
      timestampMs: Date.now(),
    };
    this.applyEvent(runId, event);
  }

  async getRunOutputs(runId: string): Promise<RunOutputsDTO> {
    const handle = await this.getOrLoadRunHandle(runId);
    if (!handle || !handle.schema) {
      return { runId, tables: [] };
    }
    const outputs = await loadOutputs(handle.db as any, handle.schema, runId);
    const tables = Object.entries(outputs).map(([name, rows]) => ({
      name,
      rows: rows as unknown[],
    }));
    return { runId, tables };
  }

  async getRunAttempts(runId: string): Promise<RunAttemptsDTO> {
    const handle = await this.getOrLoadRunHandle(runId);
    if (!handle) return { runId, attempts: [] };
    const client: any = (handle.db as any).$client;
    if (!client) return { runId, attempts: [] };
    const rows = client
      .query(
        `SELECT node_id AS nodeId,
                iteration,
                attempt,
                state,
                started_at_ms AS startedAtMs,
                finished_at_ms AS finishedAtMs,
                error_json AS errorJson,
                jj_pointer AS jjPointer,
                meta_json AS metaJson
         FROM _smithers_attempts WHERE run_id = ? ORDER BY started_at_ms DESC`,
      )
      .all(runId) as any[];
    return { runId, attempts: rows };
  }

  async getRunToolCalls(runId: string): Promise<RunToolCallsDTO> {
    const handle = await this.getOrLoadRunHandle(runId);
    if (!handle) return { runId, toolCalls: [] };
    const client: any = (handle.db as any).$client;
    if (!client) return { runId, toolCalls: [] };
    const rows = client
      .query(
        `SELECT run_id AS runId,
                node_id AS nodeId,
                iteration,
                attempt,
                seq,
                tool_name AS toolName,
                input_json AS inputJson,
                output_json AS outputJson,
                started_at_ms AS startedAtMs,
                finished_at_ms AS finishedAtMs,
                status,
                error_json AS errorJson
         FROM _smithers_tool_calls WHERE run_id = ? ORDER BY started_at_ms ASC`,
      )
      .all(runId) as any[];
    return { runId, toolCalls: rows };
  }

  private async executeRun(handle: RunHandle, opts: { input: any; resume: boolean }) {
    try {
      const result = await runWorkflowEngine(handle.workflow, {
        runId: handle.runId,
        input: opts.input ?? {},
        resume: opts.resume,
        workflowPath: handle.workflowPath,
        signal: handle.abort.signal,
        rootDir: this.workspaceRoot,
        onProgress: (event) => this.handleProgress(handle, event),
      });

      handle.status = result.status as RunStatus;
      this.db.updateWorkflowRun(handle.runId, { status: handle.status, finishedAtMs: Date.now() });
    } catch (err) {
      handle.status = "failed";
      this.db.updateWorkflowRun(handle.runId, { status: "failed", finishedAtMs: Date.now() });
    }
  }

  private handleProgress(handle: RunHandle, event: SmithersEvent) {
    this.applyEvent(handle.runId, event as SmithersEventDTO);

    if (event.type === "ApprovalRequested") {
      this.db.upsertWorkflowApproval({
        runId: event.runId,
        nodeId: event.nodeId,
        iteration: event.iteration,
        requestedAtMs: event.timestampMs,
      });

      if (handle.attachedSessionId) {
        const message: WorkflowCardMessage = {
          role: "workflow",
          type: "smithers.workflow.card",
          runId: event.runId,
          workflowName: handle.workflowName,
          status: "waiting-approval",
          approvals: [{ nodeId: event.nodeId, iteration: event.iteration }],
          timestamp: Date.now(),
        };
        this.emitChatMessage(handle.attachedSessionId, message);
      }
    }

    if (event.type === "FrameCommitted") {
      void this.captureFrame(handle, event.frameNo, event.timestampMs, event.xmlHash);
    }
  }

  private applyEvent(runId: string, event: SmithersEventDTO) {
    const seq = this.db.insertWorkflowEvent(runId, event);
    this.emitWorkflowEvent({ ...event, seq });

    switch (event.type) {
      case "RunStarted":
        this.db.updateWorkflowRun(runId, { status: "running" });
        break;
      case "RunStatusChanged":
        this.db.updateWorkflowRun(runId, { status: event.status });
        break;
      case "RunFinished":
        this.db.updateWorkflowRun(runId, { status: "finished", finishedAtMs: event.timestampMs });
        break;
      case "RunFailed":
        this.db.updateWorkflowRun(runId, { status: "failed", finishedAtMs: event.timestampMs });
        break;
      case "RunCancelled":
        this.db.updateWorkflowRun(runId, { status: "cancelled", finishedAtMs: event.timestampMs });
        break;
      case "NodePending":
        this.db.upsertWorkflowNode({
          runId: event.runId,
          nodeId: event.nodeId,
          iteration: event.iteration,
          state: "pending",
        });
        break;
      case "NodeWaitingApproval":
        this.db.upsertWorkflowNode({
          runId: event.runId,
          nodeId: event.nodeId,
          iteration: event.iteration,
          state: "waiting-approval",
          needsApproval: true,
        });
        break;
      case "NodeStarted":
        this.db.upsertWorkflowNode({
          runId: event.runId,
          nodeId: event.nodeId,
          iteration: event.iteration,
          state: "in-progress",
          lastAttempt: event.attempt,
        });
        break;
      case "NodeFinished":
        this.db.upsertWorkflowNode({
          runId: event.runId,
          nodeId: event.nodeId,
          iteration: event.iteration,
          state: "finished",
          lastAttempt: event.attempt,
        });
        break;
      case "NodeFailed":
        this.db.upsertWorkflowNode({
          runId: event.runId,
          nodeId: event.nodeId,
          iteration: event.iteration,
          state: "failed",
          lastAttempt: event.attempt,
          lastError: event.error,
        });
        break;
      case "NodeCancelled":
        this.db.upsertWorkflowNode({
          runId: event.runId,
          nodeId: event.nodeId,
          iteration: event.iteration,
          state: "cancelled",
          lastAttempt: event.attempt,
        });
        break;
      case "NodeSkipped":
        this.db.upsertWorkflowNode({
          runId: event.runId,
          nodeId: event.nodeId,
          iteration: event.iteration,
          state: "skipped",
        });
        break;
      case "NodeRetrying":
        this.db.upsertWorkflowNode({
          runId: event.runId,
          nodeId: event.nodeId,
          iteration: event.iteration,
          state: "in-progress",
          lastAttempt: event.attempt,
        });
        break;
      case "ApprovalGranted":
        this.db.upsertWorkflowApproval({
          runId: event.runId,
          nodeId: event.nodeId,
          iteration: event.iteration,
          decision: "approved",
          decidedAtMs: event.timestampMs,
        });
        break;
      case "ApprovalDenied":
        this.db.upsertWorkflowApproval({
          runId: event.runId,
          nodeId: event.nodeId,
          iteration: event.iteration,
          decision: "denied",
          decidedAtMs: event.timestampMs,
        });
        break;
    }
  }

  private async captureFrame(handle: RunHandle, frameNo: number, timestampMs: number, xmlHash?: string) {
    const frame = await handle.adapter.getLastFrame(handle.runId);
    if (!frame) return;
    const xml = JSON.parse(frame.xmlJson) as XmlNode;
    if (xml?.kind === "element" && xml.tag === "smithers:workflow" && xml.props?.name) {
      if (handle.workflowName !== xml.props.name) {
        handle.workflowName = xml.props.name;
        this.db.updateWorkflowRun(handle.runId, { workflowName: xml.props.name });
      }
    }
    const nodes = this.db.listWorkflowNodes(handle.runId);
    const graph = buildGraph(xml, nodes);
    const snapshot: FrameSnapshotDTO = {
      runId: handle.runId,
      frameNo: frame.frameNo,
      timestampMs,
      xmlHash: xmlHash ?? frame.xmlHash,
      xml: frame.xmlJson,
      graph,
    };
    this.db.insertWorkflowFrame(snapshot);
    this.emitWorkflowFrame(snapshot);
  }

  private async getOrLoadRunHandle(runId: string): Promise<RunHandle | null> {
    const existing = this.runHandles.get(runId);
    if (existing) return existing;
    const record = this.db.getWorkflowRun(runId);
    if (!record) return null;
    const baseRoot = record.workspaceRoot ?? this.workspaceRoot;
    if (!baseRoot) {
      throw new Error("Workspace root not available for run");
    }
    const workflowPath = resolve(baseRoot, record.workflowPath);
    const module = await this.loadWorkflow(workflowPath);
    const workflow = module.default;
    ensureSmithersTables(workflow.db as any);
    const adapter = new SmithersDb(workflow.db as any);
    const abort = new AbortController();
    const handle: RunHandle = {
      runId,
      workflowPath,
      workflowName: record.workflowName,
      workflow,
      schema: module.schema,
      adapter,
      db: workflow.db as any,
      status: record.status,
      startedAtMs: record.startedAtMs,
      attachedSessionId: record.attachedSessionId ?? null,
      abort,
    };
    this.runHandles.set(runId, handle);
    return handle;
  }

  private async loadWorkflow(workflowPath: string): Promise<WorkflowModule> {
    const cached = this.workflowCache.get(workflowPath);
    if (cached) return cached;
    const abs = resolve(workflowPath);
    const mod = (await import(pathToFileURL(abs).toString())) as WorkflowModule;
    if (!mod.default) {
      throw new Error("Workflow must export default");
    }
    this.workflowCache.set(workflowPath, mod);
    return mod;
  }
}

async function walkDir(root: string, ignore = DEFAULT_IGNORE): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
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

function buildGraph(xml: XmlNode | null, nodes: WorkflowNodeDTO[]): FrameSnapshotDTO["graph"] {
  const graph = { nodes: [] as FrameSnapshotDTO["graph"]["nodes"], edges: [] as FrameSnapshotDTO["graph"]["edges"] };
  if (!xml) return graph;

  const nodeStates = new Map<string, { state: string; iteration: number }>();
  for (const node of nodes) {
    const current = nodeStates.get(node.nodeId);
    if (!current || node.iteration >= current.iteration) {
      nodeStates.set(node.nodeId, { state: node.state, iteration: node.iteration });
    }
  }

  let idx = 0;

  function walk(node: XmlNode, parentId?: string, path: number[] = []) {
    if (node.kind === "text") return;
    const tag = node.tag;
    let kind: FrameSnapshotDTO["graph"]["nodes"][number]["kind"] = "Unknown";
    if (tag === "smithers:workflow") kind = "Workflow";
    if (tag === "smithers:task") kind = "Task";
    if (tag === "smithers:sequence") kind = "Sequence";
    if (tag === "smithers:parallel") kind = "Parallel";
    if (tag === "smithers:branch") kind = "Branch";
    if (tag === "smithers:ralph") kind = "Ralph";

    const id =
      kind === "Task" && node.props.id
        ? node.props.id
        : `${kind.toLowerCase()}-${path.join(".") || idx++}`;

    if (!graph.nodes.find((n) => n.id === id)) {
      const state = kind === "Task" ? nodeStates.get(id)?.state : undefined;
      graph.nodes.push({
        id,
        label: kind === "Task" ? id : kind,
        kind,
        state,
      });
    }

    if (parentId) {
      graph.edges.push({ from: parentId, to: id });
    }

    let elementIndex = 0;
    for (const child of node.children) {
      const nextPath = child.kind === "element" ? [...path, elementIndex++] : path;
      walk(child, id, nextPath);
    }
  }

  walk(xml, undefined, []);
  return graph;
}
