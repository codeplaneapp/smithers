import { Database } from "bun:sqlite"

import { DATABASE_PATH } from "@/config/paths"

export const db = new Database(DATABASE_PATH, { create: true })

db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    branch TEXT,
    repo_url TEXT,
    default_agent TEXT,
    health_status TEXT NOT NULL,
    source_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS run_events (
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    node_id TEXT,
    message TEXT,
    PRIMARY KEY (workspace_id, run_id, seq)
  );
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL,
    wait_minutes INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, run_id, node_id)
  );
`)
