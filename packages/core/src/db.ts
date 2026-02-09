import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
} from "@smithers/shared";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type AppDbOptions = {
  path?: string;
};

export class AppDb {
  private db: Database;

  constructor(options: AppDbOptions = {}) {
    const path = options.path ?? "./smithers-desktop.db";
    const dir = dirname(path);
    if (dir && dir !== ".") {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // ignore mkdir errors; Database will throw if path is unusable
      }
    }
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
      CREATE TABLE IF NOT EXISTS workspace_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        session_id TEXT,
        message_seq INTEGER,
        fork_point TEXT,
        workspace_root TEXT,
        snapshot_type TEXT,
        ref TEXT,
        created_at_ms INTEGER NOT NULL,
        metadata_json TEXT
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS workspace_snapshots_session_seq
      ON workspace_snapshots(session_id, message_seq);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS workspace_forks (
        fork_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        message_seq INTEGER NOT NULL,
        fork_point TEXT NOT NULL,
        code_mode TEXT NOT NULL,
        snapshot_id TEXT,
        sandbox_root TEXT,
        source_root TEXT,
        created_at_ms INTEGER NOT NULL
      );
    `);

    try {
      this.db.run("ALTER TABLE workspace_forks ADD COLUMN source_root TEXT");
    } catch {
      // ignore if column already exists
    }

    this.db.run(`
      CREATE INDEX IF NOT EXISTS workspace_forks_source
      ON workspace_forks(source_session_id);
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

    this.db.run(`
      CREATE TABLE IF NOT EXISTS secrets (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
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
               (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.session_id) AS messageCount,
               f.fork_id AS forkId,
               f.source_session_id AS forkSourceSessionId,
               f.code_mode AS forkCodeMode
        FROM chat_sessions s
        LEFT JOIN workspace_forks f ON f.session_id = s.session_id
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

    const fork = this.db
      .query(
        `SELECT fork_id AS forkId,
                session_id AS sessionId,
                source_session_id AS sourceSessionId,
                message_seq AS messageSeq,
                fork_point AS forkPoint,
                code_mode AS codeMode,
                snapshot_id AS snapshotId,
                sandbox_root AS sandboxRoot,
                source_root AS sourceRoot,
                created_at_ms AS createdAtMs
         FROM workspace_forks WHERE session_id = ? LIMIT 1`,
      )
      .get(sessionId) as ChatSessionDTO["fork"] | null;

    return { ...session, messages, fork: fork ?? null };
  }

  listSessionMessages(sessionId: string, limit = 50): AppMessageDTO[] {
    const rows = this.db
      .query(
        "SELECT content_json FROM chat_messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?",
      )
      .all(sessionId, limit) as { content_json: string }[];
    const messages = rows
      .map((row) => {
        try {
          return JSON.parse(row.content_json) as AppMessageDTO;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as AppMessageDTO[];
    return messages.reverse();
  }

  insertMessage(params: {
    sessionId: string;
    role: string;
    content: AppMessageDTO;
    runId?: string | null;
  }): { messageId: string; seq: number } {
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
    return { messageId, seq };
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

  forkSession(params: {
    sourceSessionId: string;
    messageSeq: number;
    forkPoint: "before" | "after";
    title?: string;
  }): string {
    const sessionId = this.createSession(params.title);
    const includeSeq = params.forkPoint === "after";
    const maxSeq = includeSeq ? params.messageSeq : params.messageSeq - 1;
    if (maxSeq >= 0) {
      const rows = this.db
        .query(
          `SELECT role, content_json, run_id
           FROM chat_messages
           WHERE session_id = ? AND seq <= ?
           ORDER BY seq ASC`,
        )
        .all(params.sourceSessionId, maxSeq) as { role: string; content_json: string; run_id: string | null }[];
      for (const row of rows) {
        this.insertMessage({
          sessionId,
          role: row.role,
          content: JSON.parse(row.content_json) as AppMessageDTO,
          runId: row.run_id ?? null,
        });
      }
    }
    return sessionId;
  }

  insertWorkspaceSnapshot(params: {
    snapshotId: string;
    sessionId?: string | null;
    messageSeq?: number | null;
    forkPoint?: string | null;
    workspaceRoot?: string | null;
    snapshotType: string;
    ref: string;
    createdAtMs: number;
    metadataJson?: string | null;
  }) {
    this.db.run(
      `INSERT INTO workspace_snapshots
       (snapshot_id, session_id, message_seq, fork_point, workspace_root, snapshot_type, ref, created_at_ms, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.snapshotId,
        params.sessionId ?? null,
        params.messageSeq ?? null,
        params.forkPoint ?? null,
        params.workspaceRoot ?? null,
        params.snapshotType,
        params.ref,
        params.createdAtMs,
        params.metadataJson ?? null,
      ],
    );
  }

  getSnapshotForMessage(params: {
    sessionId: string;
    messageSeq: number;
    forkPoint?: string;
  }) {
    const rows = this.db
      .query(
        `SELECT snapshot_id AS snapshotId,
                session_id AS sessionId,
                message_seq AS messageSeq,
                fork_point AS forkPoint,
                workspace_root AS workspaceRoot,
                snapshot_type AS snapshotType,
                ref,
                created_at_ms AS createdAtMs,
                metadata_json AS metadataJson
         FROM workspace_snapshots
         WHERE session_id = ? AND message_seq = ?
         ${params.forkPoint ? "AND fork_point = ?" : ""}
         ORDER BY created_at_ms DESC
         LIMIT 1`,
      )
      .all(
        params.sessionId,
        params.messageSeq,
        ...(params.forkPoint ? [params.forkPoint] : []),
      ) as any[];
    return rows[0] ?? null;
  }

  getNearestSnapshot(params: { sessionId: string; messageSeq: number }) {
    const row = this.db
      .query(
        `SELECT snapshot_id AS snapshotId,
                session_id AS sessionId,
                message_seq AS messageSeq,
                fork_point AS forkPoint,
                workspace_root AS workspaceRoot,
                snapshot_type AS snapshotType,
                ref,
                created_at_ms AS createdAtMs,
                metadata_json AS metadataJson
         FROM workspace_snapshots
         WHERE session_id = ? AND message_seq <= ?
         ORDER BY message_seq DESC, created_at_ms DESC
         LIMIT 1`,
      )
      .get(params.sessionId, params.messageSeq) as any;
    return row ?? null;
  }

  insertWorkspaceFork(params: {
    forkId: string;
    sessionId: string;
    sourceSessionId: string;
    messageSeq: number;
    forkPoint: string;
    codeMode: string;
    snapshotId?: string | null;
    sandboxRoot?: string | null;
    sourceRoot?: string | null;
    createdAtMs: number;
  }) {
    this.db.run(
      `INSERT INTO workspace_forks
       (fork_id, session_id, source_session_id, message_seq, fork_point, code_mode, snapshot_id, sandbox_root, source_root, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.forkId,
        params.sessionId,
        params.sourceSessionId,
        params.messageSeq,
        params.forkPoint,
        params.codeMode,
        params.snapshotId ?? null,
        params.sandboxRoot ?? null,
        params.sourceRoot ?? null,
        params.createdAtMs,
      ],
    );
  }

  getForkForSession(sessionId: string) {
    return this.db
      .query(
        `SELECT fork_id AS forkId,
                session_id AS sessionId,
                source_session_id AS sourceSessionId,
                message_seq AS messageSeq,
                fork_point AS forkPoint,
                code_mode AS codeMode,
                snapshot_id AS snapshotId,
                sandbox_root AS sandboxRoot,
                source_root AS sourceRoot,
                created_at_ms AS createdAtMs
         FROM workspace_forks
         WHERE session_id = ?
         LIMIT 1`,
      )
      .get(sessionId) as any;
  }

  listForksForSession(sourceSessionId: string) {
    return this.db
      .query(
        `SELECT fork_id AS forkId,
                session_id AS sessionId,
                source_session_id AS sourceSessionId,
                message_seq AS messageSeq,
                fork_point AS forkPoint,
                code_mode AS codeMode,
                snapshot_id AS snapshotId,
                sandbox_root AS sandboxRoot,
                source_root AS sourceRoot,
                created_at_ms AS createdAtMs
         FROM workspace_forks
         WHERE source_session_id = ?
         ORDER BY created_at_ms DESC`,
      )
      .all(sourceSessionId) as any[];
  }

  getForkById(forkId: string) {
    return this.db
      .query(
        `SELECT fork_id AS forkId,
                session_id AS sessionId,
                source_session_id AS sourceSessionId,
                message_seq AS messageSeq,
                fork_point AS forkPoint,
                code_mode AS codeMode,
                snapshot_id AS snapshotId,
                sandbox_root AS sandboxRoot,
                source_root AS sourceRoot,
                created_at_ms AS createdAtMs
         FROM workspace_forks WHERE fork_id = ? LIMIT 1`,
      )
      .get(forkId) as any;
  }

  getSnapshotById(snapshotId: string) {
    return this.db
      .query(
        `SELECT snapshot_id AS snapshotId,
                session_id AS sessionId,
                message_seq AS messageSeq,
                fork_point AS forkPoint,
                workspace_root AS workspaceRoot,
                snapshot_type AS snapshotType,
                ref,
                created_at_ms AS createdAtMs,
                metadata_json AS metadataJson
         FROM workspace_snapshots WHERE snapshot_id = ? LIMIT 1`,
      )
      .get(snapshotId) as any;
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
    const values: any[] = [];
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

  setSettings(patch: DeepPartial<SettingsDTO>): SettingsDTO {
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

  getSecret(key: string): { key: string; value: string } | null {
    const row = this.db
      .query("SELECT key, value_json AS value FROM secrets WHERE key = ? LIMIT 1")
      .get(key) as { key: string; value: string } | null;
    return row ?? null;
  }

  setSecret(key: string, value: string) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO secrets (key, value_json, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms`,
      [key, value, now],
    );
  }

  deleteSecret(key: string) {
    this.db.run("DELETE FROM secrets WHERE key = ?", [key]);
  }

  listSecretKeys(): string[] {
    const rows = this.db.query("SELECT key FROM secrets").all() as { key: string }[];
    return rows.map((row) => row.key);
  }
}

const DEFAULT_SETTINGS: SettingsDTO = {
  ui: {
    workflowPanel: { isOpen: true, width: 380 },
    artifactsPanelOpen: true,
    lastWorkspaceRoot: null,
    forks: {
      defaultIncludeCode: false,
      defaultCodeMode: "shared",
    },
  },
  agent: {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.2,
    maxTokens: 1024,
    systemPrompt: `You are Smithers, the built-in assistant for the Smithers desktop app — a framework for defining deterministic AI workflow graphs with JSX and durable state in SQLite (Drizzle).

## What Smithers Is

Smithers lets users write workflow scripts as .tsx files using React JSX. A workflow defines:
- Drizzle SQLite tables for input/output schemas
- A render function that returns a JSX tree of components: <Workflow>, <Task>, <Sequence>, <Parallel>, <Branch>, <Ralph>
- Tasks can be static (return a literal object) or agent-powered (pass an AI agent + prompt)

Example workflow structure:
\`\`\`tsx
/** @jsxImportSource smithers */
import { smithers, Workflow, Task, Sequence } from "smithers";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

const input = sqliteTable("input", { runId: text("run_id").primaryKey(), name: text("name").notNull() });
const output = sqliteTable("output", {
  runId: text("run_id").notNull(), nodeId: text("node_id").notNull(),
  message: text("message").notNull(), length: integer("length").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.runId, t.nodeId] }) }));

export const schema = { input, output };
export const db = drizzle("./workflows/example.db", { schema });

export default smithers(db, (ctx) => (
  <Workflow name="example">
    <Task id="greet" output={output}>
      {{ message: \\\`Hello, \\\${ctx.input.name}!\\\`, length: ctx.input.name.length }}
    </Task>
  </Workflow>
));
\`\`\`

Key components:
- <Workflow name="..."> — root container (children run as implicit Sequence)
- <Task id="..." output={table}> — a unit of work, static or agent-powered
- <Sequence> — run children one after another
- <Parallel maxConcurrency={N}> — run children concurrently
- <Branch if={cond} then={...} else={...} /> — conditional execution
- <Ralph until={cond} maxIterations={N}> — iterative loop

Tasks access prior outputs via ctx.output(table, { nodeId }) and input via ctx.input.

## How You Can Help Users

You can help users by:
1. **Creating workflows** — when a user asks to create/make/generate a workflow, write a .tsx file in the workflows/ directory
2. **Explaining Smithers concepts** — components, execution model, output tables, approvals, retries
3. **Debugging workflows** — reading workflow files, understanding errors
4. **General coding assistance** — reading, writing, and editing files in the workspace

## Chat Tool Commands

Users (and you) can use slash commands in chat:
- /read <path> — read a file
- /write <path>\\n<content> — create/overwrite a file
- /edit <path>\\n<patch> — apply a unified diff patch
- /bash <command> — run a shell command (network disabled by default)

## Interacting with the App

Users interact with the Smithers desktop app which has:
- **Chat** — this conversation, where you help build and debug workflows
- **Workflows** — .tsx files in the workspace's workflows/ directory, listed in the sidebar
- **Runs** — workflow executions visible in the Runs tab with real-time graph visualization
- **Settings** — configure AI provider (OpenAI/Anthropic), model, temperature, max tokens, API keys, and network access for bash

Users can run workflows via:
- The "Run Workflow" button in the app (select workflow + provide JSON input)
- Chat: @workflow(path/to/workflow.tsx) input={"key":"value"}
- CLI: smithers run workflow.tsx --input '{"key":"value"}'

Be concise and precise. Help users build workflows and understand the Smithers framework.`,
  },
  smithers: {
    allowNetwork: false,
  },
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

function mergeDeep<T>(target: T, source: DeepPartial<T>): T {
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
