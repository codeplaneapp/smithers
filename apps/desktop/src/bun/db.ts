import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type {
  AppMessageDTO,
  ChatSessionDTO,
  ChatSessionSummary,
  ApprovalDTO,
  FrameSnapshotDTO,
  RunDetailDTO,
  RunSummaryDTO,
  RunStatus,
  SettingsDTO,
  SmithersEventDTO,
  WorkflowNodeDTO,
} from "../shared/rpc";

export type AppDbOptions = {
  path?: string;
};

export class AppDb {
  private db: Database;

  constructor(options: AppDbOptions = {}) {
    const path = options.path ?? "./smithers-desktop.db";
    this.db = new Database(path);
    this.ensureTables();
  }

  private ensureTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        session_id TEXT PRIMARY KEY,
        title TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        run_id TEXT NULL
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS chat_messages_session_seq
      ON chat_messages(session_id, seq);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS chat_tool_calls (
        tool_call_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        message_id TEXT,
        tool_name TEXT NOT NULL,
        input_json TEXT,
        output_json TEXT,
        status TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        run_id TEXT PRIMARY KEY,
        workspace_root TEXT,
        workflow_path TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        finished_at_ms INTEGER,
        input_json TEXT,
        attached_session_id TEXT,
        workflow_db_path TEXT
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS workflow_events_run_seq
      ON workflow_events(run_id, seq);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflow_nodes (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        last_attempt INTEGER,
        needs_approval INTEGER,
        last_error_json TEXT,
        PRIMARY KEY (run_id, node_id, iteration)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflow_frames (
        run_id TEXT NOT NULL,
        frame_no INTEGER NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        xml_hash TEXT,
        xml_text TEXT,
        graph_json TEXT NOT NULL,
        PRIMARY KEY (run_id, frame_no)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflow_approvals (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        decision TEXT,
        note TEXT,
        requested_at_ms INTEGER,
        decided_at_ms INTEGER,
        PRIMARY KEY (run_id, node_id, iteration)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT
      );
    `);
  }

  createSession(title?: string): string {
    const sessionId = randomUUID();
    const now = Date.now();
    this.db.run(
      "INSERT INTO chat_sessions (session_id, title, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)",
      [sessionId, title ?? null, now, now],
    );
    return sessionId;
  }

  listSessions(): ChatSessionSummary[] {
    const rows = this.db
      .query(
        `
        SELECT s.session_id AS sessionId,
               s.title AS title,
               s.created_at_ms AS createdAtMs,
               s.updated_at_ms AS updatedAtMs,
               (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.session_id) AS messageCount
        FROM chat_sessions s
        ORDER BY s.updated_at_ms DESC
      `,
      )
      .all() as ChatSessionSummary[];
    return rows;
  }

  getSession(sessionId: string): ChatSessionDTO | null {
    const session = this.db
      .query(
        "SELECT session_id AS sessionId, title, created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs FROM chat_sessions WHERE session_id = ?",
      )
      .get(sessionId) as ChatSessionDTO | null;

    if (!session) return null;

    const rows = this.db
      .query(
        "SELECT content_json FROM chat_messages WHERE session_id = ? ORDER BY seq ASC",
      )
      .all(sessionId) as { content_json: string }[];

    const messages = rows.map((row) => JSON.parse(row.content_json) as AppMessageDTO);
    return { ...session, messages };
  }

  insertMessage(params: {
    sessionId: string;
    role: string;
    content: AppMessageDTO;
    runId?: string | null;
  }): string {
    const messageId = randomUUID();
    const createdAtMs = Date.now();
    const seqRow = this.db
      .query("SELECT COALESCE(MAX(seq), -1) + 1 AS nextSeq FROM chat_messages WHERE session_id = ?")
      .get(params.sessionId) as { nextSeq: number };
    const seq = seqRow?.nextSeq ?? 0;
    this.db.run(
      `
      INSERT INTO chat_messages (message_id, session_id, seq, role, content_json, created_at_ms, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        messageId,
        params.sessionId,
        seq,
        params.role,
        JSON.stringify(params.content ?? null),
        createdAtMs,
        params.runId ?? null,
      ],
    );
    this.db.run("UPDATE chat_sessions SET updated_at_ms = ? WHERE session_id = ?", [
      createdAtMs,
      params.sessionId,
    ]);
    return messageId;
  }

  insertToolCall(params: {
    toolCallId: string;
    sessionId: string;
    runId: string;
    messageId?: string | null;
    toolName: string;
    input: unknown;
    output: unknown;
    status: "success" | "error";
    startedAtMs: number;
    finishedAtMs: number;
  }) {
    this.db.run(
      `
      INSERT INTO chat_tool_calls (tool_call_id, session_id, run_id, message_id, tool_name, input_json, output_json, status, started_at_ms, finished_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        params.toolCallId,
        params.sessionId,
        params.runId,
        params.messageId ?? null,
        params.toolName,
        JSON.stringify(params.input ?? null),
        JSON.stringify(params.output ?? null),
        params.status,
        params.startedAtMs,
        params.finishedAtMs,
      ],
    );
  }

  upsertWorkflowRun(run: RunSummaryDTO & { inputJson?: string; workspaceRoot?: string | null; workflowDbPath?: string | null }) {
    this.db.run(
      `
      INSERT INTO workflow_runs (run_id, workspace_root, workflow_path, workflow_name, status, started_at_ms, finished_at_ms, input_json, attached_session_id, workflow_db_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        workflow_path=excluded.workflow_path,
        workflow_name=excluded.workflow_name,
        status=excluded.status,
        started_at_ms=excluded.started_at_ms,
        finished_at_ms=excluded.finished_at_ms,
        input_json=excluded.input_json,
        attached_session_id=excluded.attached_session_id,
        workflow_db_path=excluded.workflow_db_path
    `,
      [
        run.runId,
        run.workspaceRoot ?? null,
        run.workflowPath,
        run.workflowName,
        run.status,
        run.startedAtMs,
        run.finishedAtMs ?? null,
        run.inputJson ?? null,
        run.attachedSessionId ?? null,
        run.workflowDbPath ?? null,
      ],
    );
  }

  updateWorkflowRun(runId: string, patch: Partial<RunSummaryDTO> & { finishedAtMs?: number | null }) {
    const fields: string[] = [];
    const values: unknown[] = [];
    const mapping: Record<string, string> = {
      workflowPath: "workflow_path",
      workflowName: "workflow_name",
      status: "status",
      startedAtMs: "started_at_ms",
      finishedAtMs: "finished_at_ms",
      attachedSessionId: "attached_session_id",
    };
    for (const [key, col] of Object.entries(mapping)) {
      if (key in patch) {
        fields.push(`${col} = ?`);
        values.push((patch as any)[key]);
      }
    }
    if (!fields.length) return;
    values.push(runId);
    this.db.run(`UPDATE workflow_runs SET ${fields.join(", ")} WHERE run_id = ?`, values);
  }

  listWorkflowRuns(status?: "active" | "finished" | "failed" | "all"): RunSummaryDTO[] {
    let where = "";
    if (status === "active") {
      where = "WHERE status IN ('running','waiting-approval')";
    } else if (status === "finished") {
      where = "WHERE status = 'finished'";
    } else if (status === "failed") {
      where = "WHERE status = 'failed'";
    }
    const rows = this.db
      .query(
        `
        SELECT run_id AS runId,
               workflow_path AS workflowPath,
               workflow_name AS workflowName,
               status,
               started_at_ms AS startedAtMs,
               finished_at_ms AS finishedAtMs,
               attached_session_id AS attachedSessionId,
               workspace_root AS workspaceRoot,
               (SELECT GROUP_CONCAT(node_id) FROM workflow_nodes WHERE run_id = workflow_runs.run_id AND state = 'in-progress') AS activeNodesCsv,
               (SELECT COUNT(*) FROM workflow_nodes WHERE run_id = workflow_runs.run_id AND state = 'waiting-approval') AS waitingApprovals
        FROM workflow_runs
        ${where}
        ORDER BY started_at_ms DESC
      `,
      )
      .all() as Array<RunSummaryDTO & { activeNodesCsv?: string | null; waitingApprovals?: number }>;
    return rows.map((row) => ({
      ...row,
      activeNodes: row.activeNodesCsv ? row.activeNodesCsv.split(",") : [],
      waitingApprovals: Number(row.waitingApprovals ?? 0),
    }));
  }

  getWorkflowRun(runId: string): RunSummaryDTO | null {
    const row = this.db
      .query(
        `SELECT run_id AS runId,
                workflow_path AS workflowPath,
                workflow_name AS workflowName,
                status,
                started_at_ms AS startedAtMs,
                finished_at_ms AS finishedAtMs,
                attached_session_id AS attachedSessionId,
                workspace_root AS workspaceRoot,
                (SELECT GROUP_CONCAT(node_id) FROM workflow_nodes WHERE run_id = workflow_runs.run_id AND state = 'in-progress') AS activeNodesCsv,
                (SELECT COUNT(*) FROM workflow_nodes WHERE run_id = workflow_runs.run_id AND state = 'waiting-approval') AS waitingApprovals
         FROM workflow_runs WHERE run_id = ? LIMIT 1`,
      )
      .get(runId) as (RunSummaryDTO & { activeNodesCsv?: string | null; waitingApprovals?: number }) | null;
    if (!row) return null;
    return {
      ...row,
      activeNodes: row.activeNodesCsv ? row.activeNodesCsv.split(",") : [],
      waitingApprovals: Number(row.waitingApprovals ?? 0),
    };
  }

  insertWorkflowEvent(runId: string, event: SmithersEventDTO): number {
    const seqRow = this.db
      .query("SELECT COALESCE(MAX(seq), -1) + 1 AS nextSeq FROM workflow_events WHERE run_id = ?")
      .get(runId) as { nextSeq: number };
    const seq = seqRow?.nextSeq ?? 0;
    this.db.run(
      `INSERT INTO workflow_events (run_id, seq, timestamp_ms, type, payload_json) VALUES (?, ?, ?, ?, ?)`,
      [runId, seq, (event as any).timestampMs ?? Date.now(), event.type, JSON.stringify(event)],
    );
    return seq;
  }

  listWorkflowEvents(runId: string, afterSeq = -1): { events: SmithersEventDTO[]; lastSeq: number } {
    const rows = this.db
      .query(
        `SELECT seq, payload_json FROM workflow_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(runId, afterSeq) as { seq: number; payload_json: string }[];
    const events = rows.map((row) => JSON.parse(row.payload_json) as SmithersEventDTO);
    const lastSeq = rows.length ? rows[rows.length - 1]!.seq : afterSeq;
    return { events, lastSeq };
  }

  upsertWorkflowNode(node: WorkflowNodeDTO) {
    this.db.run(
      `INSERT INTO workflow_nodes (run_id, node_id, iteration, state, last_attempt, needs_approval, last_error_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, node_id, iteration) DO UPDATE SET
         state=excluded.state,
         last_attempt=excluded.last_attempt,
         needs_approval=excluded.needs_approval,
         last_error_json=excluded.last_error_json`,
      [
        node.runId,
        node.nodeId,
        node.iteration,
        node.state,
        node.lastAttempt ?? null,
        node.needsApproval ? 1 : 0,
        node.lastError ? JSON.stringify(node.lastError) : null,
      ],
    );
  }

  listWorkflowNodes(runId: string): WorkflowNodeDTO[] {
    const rows = this.db
      .query(
        `SELECT run_id AS runId,
                node_id AS nodeId,
                iteration,
                state,
                last_attempt AS lastAttempt,
                needs_approval AS needsApproval,
                last_error_json AS lastErrorJson
         FROM workflow_nodes WHERE run_id = ?`,
      )
      .all(runId) as Array<WorkflowNodeDTO & { lastErrorJson?: string | null }>;
    return rows.map((row) => ({
      ...row,
      needsApproval: Boolean((row as any).needsApproval),
      lastError: row.lastErrorJson ? JSON.parse(row.lastErrorJson) : undefined,
    }));
  }

  insertWorkflowFrame(frame: FrameSnapshotDTO) {
    this.db.run(
      `INSERT INTO workflow_frames (run_id, frame_no, timestamp_ms, xml_hash, xml_text, graph_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, frame_no) DO UPDATE SET
         timestamp_ms=excluded.timestamp_ms,
         xml_hash=excluded.xml_hash,
         xml_text=excluded.xml_text,
         graph_json=excluded.graph_json`,
      [
        frame.runId,
        frame.frameNo,
        frame.timestampMs,
        frame.xmlHash ?? null,
        frame.xml ?? null,
        JSON.stringify(frame.graph),
      ],
    );
  }

  getWorkflowFrame(runId: string, frameNo?: number): FrameSnapshotDTO | null {
    const row = frameNo === undefined
      ? (this.db
          .query(
            `SELECT run_id AS runId,
                    frame_no AS frameNo,
                    timestamp_ms AS timestampMs,
                    xml_hash AS xmlHash,
                    xml_text AS xml,
                    graph_json AS graphJson
             FROM workflow_frames WHERE run_id = ? ORDER BY frame_no DESC LIMIT 1`,
          )
          .get(runId) as any)
      : (this.db
          .query(
            `SELECT run_id AS runId,
                    frame_no AS frameNo,
                    timestamp_ms AS timestampMs,
                    xml_hash AS xmlHash,
                    xml_text AS xml,
                    graph_json AS graphJson
             FROM workflow_frames WHERE run_id = ? AND frame_no = ? LIMIT 1`,
          )
          .get(runId, frameNo) as any);
    if (!row) return null;
    return {
      runId: row.runId,
      frameNo: row.frameNo,
      timestampMs: row.timestampMs,
      xmlHash: row.xmlHash ?? undefined,
      xml: row.xml ?? undefined,
      graph: JSON.parse(row.graphJson ?? "{}"),
    } as FrameSnapshotDTO;
  }

  upsertWorkflowApproval(approval: ApprovalDTO) {
    this.db.run(
      `INSERT INTO workflow_approvals (run_id, node_id, iteration, decision, note, requested_at_ms, decided_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, node_id, iteration) DO UPDATE SET
         decision=excluded.decision,
         note=excluded.note,
         requested_at_ms=excluded.requested_at_ms,
         decided_at_ms=excluded.decided_at_ms`,
      [
        approval.runId,
        approval.nodeId,
        approval.iteration,
        approval.decision ?? null,
        approval.note ?? null,
        approval.requestedAtMs ?? null,
        approval.decidedAtMs ?? null,
      ],
    );
  }

  listWorkflowApprovals(runId: string): ApprovalDTO[] {
    const rows = this.db
      .query(
        `SELECT run_id AS runId,
                node_id AS nodeId,
                iteration,
                decision,
                note,
                requested_at_ms AS requestedAtMs,
                decided_at_ms AS decidedAtMs
         FROM workflow_approvals WHERE run_id = ?`,
      )
      .all(runId) as ApprovalDTO[];
    return rows;
  }

  getRunDetail(runId: string): RunDetailDTO | null {
    const run = this.getWorkflowRun(runId);
    if (!run) return null;
    const nodes = this.listWorkflowNodes(runId);
    const approvals = this.listWorkflowApprovals(runId);
    const lastSeqRow = this.db
      .query("SELECT COALESCE(MAX(seq), -1) AS lastSeq FROM workflow_events WHERE run_id = ?")
      .get(runId) as { lastSeq: number };
    return {
      run,
      nodes,
      approvals,
      lastSeq: lastSeqRow?.lastSeq ?? -1,
    };
  }

  getSettings(): SettingsDTO {
    const settings = cloneSettings(DEFAULT_SETTINGS);
    const rows = this.db.query("SELECT key, value_json FROM settings").all() as {
      key: string;
      value_json: string;
    }[];
    for (const row of rows) {
      try {
        const value = JSON.parse(row.value_json);
        setByPath(settings, row.key, value);
      } catch {
        // ignore invalid settings rows
      }
    }
    return settings;
  }

  setSettings(patch: Partial<SettingsDTO>): SettingsDTO {
    const current = this.getSettings();
    const merged = mergeDeep(current, patch);
    const entries = flattenSettings(merged);
    for (const [key, value] of entries) {
      this.db.run(
        `INSERT INTO settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
        [key, JSON.stringify(value)],
      );
    }
    return merged;
  }
}

const DEFAULT_SETTINGS: SettingsDTO = {
  ui: {
    workflowPanel: { isOpen: true, width: 380 },
    artifactsPanelOpen: true,
    lastWorkspaceRoot: null,
  },
  agent: {},
  smithers: {},
};

function cloneSettings(settings: SettingsDTO): SettingsDTO {
  return JSON.parse(JSON.stringify(settings));
}

function setByPath(obj: any, path: string, value: unknown) {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    if (!current[key] || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key];
  }
  current[parts[parts.length - 1]!] = value;
}

function mergeDeep<T>(target: T, source: Partial<T>): T {
  if (!source || typeof source !== "object") return target;
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      (target as any)[key] = mergeDeep((target as any)[key] ?? {}, value as any);
    } else if (value !== undefined) {
      (target as any)[key] = value;
    }
  }
  return target;
}

function flattenSettings(obj: any, prefix = ""): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      entries.push(...flattenSettings(value, path));
    } else {
      entries.push([path, value]);
    }
  }
  return entries;
}
