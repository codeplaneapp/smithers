"""SQLite-based session storage for agentd.

This module implements persistent storage for agent sessions, following
the event sourcing pattern described in ARCHITECTURE.md.

Key features:
- Append-only event log per session
- Session metadata (workspace, created_at)
- Efficient event retrieval for rebuilding session state
- Migration-ready schema
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import aiosqlite

from agentd.protocol.events import Event, EventType


@dataclass
class SessionRecord:
    """A session record from the database."""

    id: str
    workspace_root: str
    created_at: datetime
    last_active_at: datetime


@dataclass
class SessionEventRecord:
    """A session event record from the database."""

    id: int
    session_id: str
    ts: datetime
    type: str
    payload: dict[str, Any]


@dataclass
class CheckpointRecord:
    """A checkpoint record from the database."""

    checkpoint_id: str
    session_id: str
    session_node_id: str | None
    jj_commit_id: str
    bookmark_name: str
    message: str
    created_at: datetime


@dataclass
class TodoRecord:
    """A todo item record from the database."""

    id: int
    workspace_id: str
    session_id: str | None
    text: str
    completed: bool
    attached_node_id: str | None
    created_at: datetime
    completed_at: datetime | None


# Current schema version
SCHEMA_VERSION = 1

# SQL schema for session tables
_SCHEMA = """
-- schema_version: track database schema version for migrations
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

-- sessions: metadata for each session
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_root TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL
);

-- session_events: append-only event log
CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- checkpoints: JJ checkpoint metadata
CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    session_node_id TEXT,
    jj_commit_id TEXT NOT NULL,
    bookmark_name TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- todos: task tracking per workspace/session
CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    session_id TEXT,
    text TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    attached_node_id TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- indexes for common queries
CREATE INDEX IF NOT EXISTS idx_session_events_session_id ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_ts ON session_events(ts);
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session_id ON checkpoints(session_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_created_at ON checkpoints(created_at);
CREATE INDEX IF NOT EXISTS idx_todos_workspace_id ON todos(workspace_id);
CREATE INDEX IF NOT EXISTS idx_todos_session_id ON todos(session_id);
CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos(workspace_id, completed);

-- Full-Text Search (FTS5) tables for search functionality
-- Messages search: indexes message content for fast text search
CREATE VIRTUAL TABLE IF NOT EXISTS session_events_fts USING fts5(
    content,
    session_id UNINDEXED,
    event_id UNINDEXED,
    content='session_events',
    content_rowid='id'
);

-- Checkpoints search: indexes checkpoint messages and bookmark names
CREATE VIRTUAL TABLE IF NOT EXISTS checkpoints_fts USING fts5(
    message,
    bookmark_name,
    session_id UNINDEXED,
    checkpoint_id UNINDEXED,
    content='checkpoints',
    content_rowid='rowid'
);

-- Todos search: indexes todo text
CREATE VIRTUAL TABLE IF NOT EXISTS todos_fts USING fts5(
    text,
    workspace_id UNINDEXED,
    session_id UNINDEXED,
    todo_id UNINDEXED,
    content='todos',
    content_rowid='id'
);

-- Triggers to keep FTS indexes synchronized with base tables
-- Insert trigger for session_events
CREATE TRIGGER IF NOT EXISTS session_events_fts_insert AFTER INSERT ON session_events BEGIN
    INSERT INTO session_events_fts(rowid, content, session_id, event_id)
    VALUES (
        new.id,
        CASE
            WHEN json_extract(new.payload_json, '$.content') IS NOT NULL
            THEN json_extract(new.payload_json, '$.content')
            WHEN json_extract(new.payload_json, '$.text') IS NOT NULL
            THEN json_extract(new.payload_json, '$.text')
            WHEN json_extract(new.payload_json, '$.message') IS NOT NULL
            THEN json_extract(new.payload_json, '$.message')
            WHEN json_extract(new.payload_json, '$.preview') IS NOT NULL
            THEN json_extract(new.payload_json, '$.preview')
            ELSE ''
        END,
        new.session_id,
        new.id
    );
END;

-- Delete trigger for session_events
CREATE TRIGGER IF NOT EXISTS session_events_fts_delete AFTER DELETE ON session_events BEGIN
    INSERT INTO session_events_fts(session_events_fts, rowid, content, session_id, event_id)
    VALUES('delete', old.id, '', old.session_id, old.id);
END;

-- Update trigger for session_events
CREATE TRIGGER IF NOT EXISTS session_events_fts_update AFTER UPDATE ON session_events BEGIN
    INSERT INTO session_events_fts(session_events_fts, rowid, content, session_id, event_id)
    VALUES('delete', old.id, '', old.session_id, old.id);
    INSERT INTO session_events_fts(rowid, content, session_id, event_id)
    VALUES (
        new.id,
        CASE
            WHEN json_extract(new.payload_json, '$.content') IS NOT NULL
            THEN json_extract(new.payload_json, '$.content')
            WHEN json_extract(new.payload_json, '$.text') IS NOT NULL
            THEN json_extract(new.payload_json, '$.text')
            WHEN json_extract(new.payload_json, '$.message') IS NOT NULL
            THEN json_extract(new.payload_json, '$.message')
            WHEN json_extract(new.payload_json, '$.preview') IS NOT NULL
            THEN json_extract(new.payload_json, '$.preview')
            ELSE ''
        END,
        new.session_id,
        new.id
    );
END;

-- Insert trigger for checkpoints
CREATE TRIGGER IF NOT EXISTS checkpoints_fts_insert AFTER INSERT ON checkpoints BEGIN
    INSERT INTO checkpoints_fts(rowid, message, bookmark_name, session_id, checkpoint_id)
    VALUES (new.rowid, new.message, new.bookmark_name, new.session_id, new.checkpoint_id);
END;

-- Delete trigger for checkpoints
CREATE TRIGGER IF NOT EXISTS checkpoints_fts_delete AFTER DELETE ON checkpoints BEGIN
    INSERT INTO checkpoints_fts(checkpoints_fts, rowid, message, bookmark_name, session_id, checkpoint_id)
    VALUES('delete', old.rowid, old.message, old.bookmark_name, old.session_id, old.checkpoint_id);
END;

-- Update trigger for checkpoints
CREATE TRIGGER IF NOT EXISTS checkpoints_fts_update AFTER UPDATE ON checkpoints BEGIN
    INSERT INTO checkpoints_fts(checkpoints_fts, rowid, message, bookmark_name, session_id, checkpoint_id)
    VALUES('delete', old.rowid, old.message, old.bookmark_name, old.session_id, old.checkpoint_id);
    INSERT INTO checkpoints_fts(rowid, message, bookmark_name, session_id, checkpoint_id)
    VALUES (new.rowid, new.message, new.bookmark_name, new.session_id, new.checkpoint_id);
END;

-- Insert trigger for todos
CREATE TRIGGER IF NOT EXISTS todos_fts_insert AFTER INSERT ON todos BEGIN
    INSERT INTO todos_fts(rowid, text, workspace_id, session_id, todo_id)
    VALUES (new.id, new.text, new.workspace_id, new.session_id, new.id);
END;

-- Delete trigger for todos
CREATE TRIGGER IF NOT EXISTS todos_fts_delete AFTER DELETE ON todos BEGIN
    INSERT INTO todos_fts(todos_fts, rowid, text, workspace_id, session_id, todo_id)
    VALUES('delete', old.id, old.text, old.workspace_id, old.session_id, old.id);
END;

-- Update trigger for todos
CREATE TRIGGER IF NOT EXISTS todos_fts_update AFTER UPDATE ON todos BEGIN
    INSERT INTO todos_fts(todos_fts, rowid, text, workspace_id, session_id, todo_id)
    VALUES('delete', old.id, old.text, old.workspace_id, old.session_id, old.id);
    INSERT INTO todos_fts(rowid, text, workspace_id, session_id, todo_id)
    VALUES (new.id, new.text, new.workspace_id, new.session_id, new.id);
END;
"""


class SessionStore:
    """
    SQLite-based persistent store for agent sessions.

    This store implements event sourcing for sessions:
    - Sessions are created with metadata
    - All state changes are recorded as events
    - Session state can be reconstructed by replaying events
    - Events are append-only and immutable

    Usage:
        store = SessionStore("./agentd.db")
        await store.initialize()

        # Create a session
        session_id = await store.create_session("/path/to/workspace")

        # Append events
        await store.append_event(session_id, EventType.RUN_STARTED, {"run_id": "123"})

        # Retrieve events
        events = await store.get_events(session_id)

        # Load all sessions
        sessions = await store.list_sessions()
    """

    def __init__(self, path: str | Path) -> None:
        """Initialize the store with a path to the SQLite database."""
        self.path = Path(path)
        self._initialized = False
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        """Initialize the database schema."""
        if self._initialized:
            return

        self.path.parent.mkdir(parents=True, exist_ok=True)
        async with self._connect() as db:
            # Enable foreign key constraints
            await db.execute("PRAGMA foreign_keys = ON")
            await db.executescript(_SCHEMA)

            # Check and update schema version
            await self._ensure_schema_version(db)

            await db.commit()
        self._initialized = True

    async def _ensure_schema_version(self, db: aiosqlite.Connection) -> None:
        """Ensure the database schema is at the correct version.

        Args:
            db: Database connection
        """
        # Check current version
        async with db.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1") as cursor:
            row = await cursor.fetchone()
            current_version = row[0] if row else 0

        # If already at current version, nothing to do
        if current_version == SCHEMA_VERSION:
            return

        # If no version recorded, record the current version
        if current_version == 0:
            now = _timestamp_now()
            await db.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                (SCHEMA_VERSION, now)
            )
            return

        # Future: Add migration logic here when schema changes
        # For now, we only have version 1
        if current_version < SCHEMA_VERSION:
            # Apply migrations here
            pass

    async def _ensure_initialized(self) -> None:
        """Ensure the database is initialized."""
        if not self._initialized:
            await self.initialize()

    @asynccontextmanager
    async def _connect(self) -> AsyncIterator[aiosqlite.Connection]:
        """Create a database connection with foreign keys enabled."""
        async with aiosqlite.connect(self.path) as db:
            await db.execute("PRAGMA foreign_keys = ON")
            yield db

    # ==================== Session Operations ====================

    async def create_session(self, workspace_root: str, *, session_id: str) -> str:
        """Create a new session.

        Args:
            workspace_root: The workspace directory path
            session_id: The session ID to use

        Returns:
            The session ID
        """
        await self._ensure_initialized()
        now = _timestamp_now()

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                INSERT INTO sessions (id, workspace_root, created_at, last_active_at)
                VALUES (?, ?, ?, ?)
                """,
                (session_id, workspace_root, now, now),
            )
            await db.commit()

            # Emit SESSION_CREATED event
            await self._append_event_internal(
                db,
                session_id,
                EventType.SESSION_CREATED.value,
                {"workspace_root": workspace_root},
                now,
            )
            await db.commit()

        return session_id

    async def get_session(self, session_id: str) -> SessionRecord | None:
        """Get a session by ID.

        Args:
            session_id: The session ID

        Returns:
            SessionRecord if found, None otherwise
        """
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None

            return SessionRecord(
                id=row["id"],
                workspace_root=row["workspace_root"],
                created_at=_parse_timestamp(row["created_at"]) or datetime.now(UTC),
                last_active_at=_parse_timestamp(row["last_active_at"]) or datetime.now(UTC),
            )

    async def list_sessions(self, *, limit: int = 100) -> list[SessionRecord]:
        """List all sessions, ordered by most recently active.

        Args:
            limit: Maximum number of sessions to return

        Returns:
            List of SessionRecord objects
        """
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM sessions ORDER BY last_active_at DESC LIMIT ?",
                (limit,),
            ) as cursor:
                rows = await cursor.fetchall()

        return [
            SessionRecord(
                id=row["id"],
                workspace_root=row["workspace_root"],
                created_at=_parse_timestamp(row["created_at"]) or datetime.now(UTC),
                last_active_at=_parse_timestamp(row["last_active_at"]) or datetime.now(UTC),
            )
            for row in rows
        ]

    async def update_last_active(self, session_id: str) -> None:
        """Update the last_active_at timestamp for a session.

        Args:
            session_id: The session ID
        """
        await self._ensure_initialized()
        now = _timestamp_now()

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                "UPDATE sessions SET last_active_at = ? WHERE id = ?",
                (now, session_id),
            )
            await db.commit()

    async def delete_session(self, session_id: str) -> bool:
        """Delete a session and all its events.

        Args:
            session_id: The session ID

        Returns:
            True if the session was deleted, False if it didn't exist
        """
        await self._ensure_initialized()
        async with self._lock, self._connect() as db:
            cursor = await db.execute(
                "DELETE FROM sessions WHERE id = ?",
                (session_id,),
            )
            deleted = cursor.rowcount > 0
            await db.commit()
            return deleted

    # ==================== Event Operations ====================

    async def append_event(
        self,
        session_id: str,
        event_type: EventType | str,
        payload: dict[str, Any],
    ) -> int:
        """Append an event to the session's event log.

        Args:
            session_id: The session ID
            event_type: The event type (EventType enum or string)
            payload: Event payload data

        Returns:
            The event ID
        """
        await self._ensure_initialized()
        now = _timestamp_now()

        # Convert EventType to string
        type_str = event_type.value if isinstance(event_type, EventType) else event_type

        async with self._lock, aiosqlite.connect(self.path) as db:
            event_id = await self._append_event_internal(db, session_id, type_str, payload, now)
            # Update last_active_at
            await db.execute(
                "UPDATE sessions SET last_active_at = ? WHERE id = ?",
                (now, session_id),
            )
            await db.commit()
            return event_id

    async def _append_event_internal(
        self,
        db: aiosqlite.Connection,
        session_id: str,
        event_type: str,
        payload: dict[str, Any],
        timestamp: str,
    ) -> int:
        """Internal method to append an event (used within transactions).

        Args:
            db: Database connection
            session_id: The session ID
            event_type: The event type string
            payload: Event payload data
            timestamp: ISO timestamp string

        Returns:
            The event ID
        """
        payload_json = json.dumps(payload, default=str)
        cursor = await db.execute(
            """
            INSERT INTO session_events (session_id, ts, type, payload_json)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, timestamp, event_type, payload_json),
        )
        return cursor.lastrowid or 0

    async def get_events(
        self,
        session_id: str,
        *,
        event_type: str | None = None,
        since_id: int | None = None,
        limit: int = 10000,
    ) -> list[SessionEventRecord]:
        """Get events for a session, optionally filtered.

        Args:
            session_id: The session ID
            event_type: Optional event type filter
            since_id: Optional - only return events after this ID
            limit: Maximum number of events to return

        Returns:
            List of SessionEventRecord objects
        """
        await self._ensure_initialized()
        query = "SELECT * FROM session_events WHERE session_id = ?"
        params: list[Any] = [session_id]

        if event_type is not None:
            query += " AND type = ?"
            params.append(event_type)
        if since_id is not None:
            query += " AND id > ?"
            params.append(since_id)

        query += " ORDER BY id ASC LIMIT ?"
        params.append(limit)

        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(query, params) as cursor:
                rows = await cursor.fetchall()

        return [
            SessionEventRecord(
                id=row["id"],
                session_id=row["session_id"],
                ts=_parse_timestamp(row["ts"]) or datetime.now(UTC),
                type=row["type"],
                payload=json.loads(row["payload_json"]),
            )
            for row in rows
        ]

    async def get_events_as_protocol_events(
        self,
        session_id: str,
        *,
        event_type: str | None = None,
        since_id: int | None = None,
        limit: int = 10000,
    ) -> list[Event]:
        """Get events as protocol Event objects.

        Args:
            session_id: The session ID
            event_type: Optional event type filter
            since_id: Optional - only return events after this ID
            limit: Maximum number of events to return

        Returns:
            List of Event objects
        """
        records = await self.get_events(
            session_id,
            event_type=event_type,
            since_id=since_id,
            limit=limit,
        )
        return [
            Event(
                type=EventType(record.type)
                if record.type in EventType.__members__.values()
                else EventType.ERROR,
                data=record.payload,
                timestamp=record.ts,
            )
            for record in records
        ]

    async def get_event_count(self, session_id: str) -> int:
        """Get the total number of events for a session.

        Args:
            session_id: The session ID

        Returns:
            Number of events
        """
        await self._ensure_initialized()
        async with (
            self._lock,
            aiosqlite.connect(self.path) as db,
            db.execute(
                "SELECT COUNT(*) FROM session_events WHERE session_id = ?",
                (session_id,),
            ) as cursor,
        ):
            row = await cursor.fetchone()
            return row[0] if row else 0

    async def get_latest_event_id(self, session_id: str) -> int | None:
        """Get the ID of the most recent event for a session.

        Args:
            session_id: The session ID

        Returns:
            The latest event ID, or None if no events exist
        """
        await self._ensure_initialized()
        async with (
            self._lock,
            aiosqlite.connect(self.path) as db,
            db.execute(
                "SELECT MAX(id) FROM session_events WHERE session_id = ?",
                (session_id,),
            ) as cursor,
        ):
            row = await cursor.fetchone()
            return row[0] if row and row[0] is not None else None

    # ==================== Utility Methods ====================

    async def get_schema_version(self) -> int:
        """Get the current schema version of the database.

        Returns:
            The schema version number, or 0 if no version is set
        """
        await self._ensure_initialized()
        async with (
            self._lock,
            aiosqlite.connect(self.path) as db,
            db.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1") as cursor,
        ):
            row = await cursor.fetchone()
            return row[0] if row else 0

    async def get_session_stats(self, session_id: str) -> dict[str, Any]:
        """Get statistics for a session.

        Args:
            session_id: The session ID

        Returns:
            Dict with stats including event counts by type
        """
        session = await self.get_session(session_id)
        if session is None:
            return {}

        events = await self.get_events(session_id)

        # Count events by type
        event_counts: dict[str, int] = {}
        for event in events:
            event_counts[event.type] = event_counts.get(event.type, 0) + 1

        return {
            "session_id": session.id,
            "workspace_root": session.workspace_root,
            "created_at": session.created_at.isoformat(),
            "last_active_at": session.last_active_at.isoformat(),
            "total_events": len(events),
            "event_counts": event_counts,
        }

    # ==================== Checkpoint Operations ====================

    async def create_checkpoint(
        self,
        checkpoint_id: str,
        session_id: str,
        jj_commit_id: str,
        bookmark_name: str,
        message: str,
        *,
        session_node_id: str | None = None,
    ) -> CheckpointRecord:
        """Create a new checkpoint record.

        Args:
            checkpoint_id: Unique checkpoint identifier
            session_id: The session ID
            jj_commit_id: JJ commit ID
            bookmark_name: JJ bookmark name
            message: Checkpoint description
            session_node_id: Optional session graph node ID

        Returns:
            CheckpointRecord
        """
        await self._ensure_initialized()
        now = _timestamp_now()

        async with self._lock, self._connect() as db:
            await db.execute(
                """
                INSERT INTO checkpoints (checkpoint_id, session_id, session_node_id, jj_commit_id, bookmark_name, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (checkpoint_id, session_id, session_node_id, jj_commit_id, bookmark_name, message, now),
            )
            await db.commit()

        return CheckpointRecord(
            checkpoint_id=checkpoint_id,
            session_id=session_id,
            session_node_id=session_node_id,
            jj_commit_id=jj_commit_id,
            bookmark_name=bookmark_name,
            message=message,
            created_at=_parse_timestamp(now) or datetime.now(UTC),
        )

    async def get_checkpoint(self, checkpoint_id: str) -> CheckpointRecord | None:
        """Get a checkpoint by ID.

        Args:
            checkpoint_id: The checkpoint ID

        Returns:
            CheckpointRecord if found, None otherwise
        """
        await self._ensure_initialized()
        async with self._lock, self._connect() as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM checkpoints WHERE checkpoint_id = ?",
                (checkpoint_id,),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None

            return CheckpointRecord(
                checkpoint_id=row["checkpoint_id"],
                session_id=row["session_id"],
                session_node_id=row["session_node_id"],
                jj_commit_id=row["jj_commit_id"],
                bookmark_name=row["bookmark_name"],
                message=row["message"],
                created_at=_parse_timestamp(row["created_at"]) or datetime.now(UTC),
            )

    async def list_checkpoints(
        self, session_id: str, *, limit: int = 100
    ) -> list[CheckpointRecord]:
        """List checkpoints for a session, ordered by creation time.

        Args:
            session_id: The session ID
            limit: Maximum number of checkpoints to return

        Returns:
            List of CheckpointRecord objects
        """
        await self._ensure_initialized()
        async with self._lock, self._connect() as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
                (session_id, limit),
            ) as cursor:
                rows = await cursor.fetchall()

        return [
            CheckpointRecord(
                checkpoint_id=row["checkpoint_id"],
                session_id=row["session_id"],
                session_node_id=row["session_node_id"],
                jj_commit_id=row["jj_commit_id"],
                bookmark_name=row["bookmark_name"],
                message=row["message"],
                created_at=_parse_timestamp(row["created_at"]) or datetime.now(UTC),
            )
            for row in rows
        ]

    async def delete_checkpoint(self, checkpoint_id: str) -> bool:
        """Delete a checkpoint.

        Args:
            checkpoint_id: The checkpoint ID

        Returns:
            True if the checkpoint was deleted, False if it didn't exist
        """
        await self._ensure_initialized()
        async with self._lock, self._connect() as db:
            cursor = await db.execute(
                "DELETE FROM checkpoints WHERE checkpoint_id = ?",
                (checkpoint_id,),
            )
            deleted = cursor.rowcount > 0
            await db.commit()
            return deleted

    # ==================== Todo Operations ====================

    async def create_todo(
        self,
        workspace_id: str,
        text: str,
        *,
        session_id: str | None = None,
        attached_node_id: str | None = None,
    ) -> TodoRecord:
        """Create a new todo item.

        Args:
            workspace_id: The workspace this todo belongs to
            text: The todo text
            session_id: Optional session ID to associate with this todo
            attached_node_id: Optional graph node ID to attach this todo to

        Returns:
            TodoRecord
        """
        await self._ensure_initialized()
        now = _timestamp_now()

        async with self._lock, self._connect() as db:
            cursor = await db.execute(
                """
                INSERT INTO todos (workspace_id, session_id, text, completed, attached_node_id, created_at, completed_at)
                VALUES (?, ?, ?, 0, ?, ?, NULL)
                """,
                (workspace_id, session_id, text, attached_node_id, now),
            )
            todo_id = cursor.lastrowid or 0
            await db.commit()

        return TodoRecord(
            id=todo_id,
            workspace_id=workspace_id,
            session_id=session_id,
            text=text,
            completed=False,
            attached_node_id=attached_node_id,
            created_at=_parse_timestamp(now) or datetime.now(UTC),
            completed_at=None,
        )

    async def get_todo(self, todo_id: int) -> TodoRecord | None:
        """Get a todo by ID.

        Args:
            todo_id: The todo ID

        Returns:
            TodoRecord if found, None otherwise
        """
        await self._ensure_initialized()
        async with self._lock, self._connect() as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM todos WHERE id = ?",
                (todo_id,),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None

            return TodoRecord(
                id=row["id"],
                workspace_id=row["workspace_id"],
                session_id=row["session_id"],
                text=row["text"],
                completed=bool(row["completed"]),
                attached_node_id=row["attached_node_id"],
                created_at=_parse_timestamp(row["created_at"]) or datetime.now(UTC),
                completed_at=_parse_timestamp(row["completed_at"]),
            )

    async def list_todos(
        self,
        workspace_id: str,
        *,
        session_id: str | None = None,
        completed: bool | None = None,
        limit: int = 100,
    ) -> list[TodoRecord]:
        """List todos for a workspace, optionally filtered.

        Args:
            workspace_id: The workspace ID
            session_id: Optional session ID filter
            completed: Optional completion status filter
            limit: Maximum number of todos to return

        Returns:
            List of TodoRecord objects, ordered by creation time (newest first)
        """
        await self._ensure_initialized()
        query = "SELECT * FROM todos WHERE workspace_id = ?"
        params: list[Any] = [workspace_id]

        if session_id is not None:
            query += " AND session_id = ?"
            params.append(session_id)
        if completed is not None:
            query += " AND completed = ?"
            params.append(1 if completed else 0)

        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)

        async with self._lock, self._connect() as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(query, params) as cursor:
                rows = await cursor.fetchall()

        return [
            TodoRecord(
                id=row["id"],
                workspace_id=row["workspace_id"],
                session_id=row["session_id"],
                text=row["text"],
                completed=bool(row["completed"]),
                attached_node_id=row["attached_node_id"],
                created_at=_parse_timestamp(row["created_at"]) or datetime.now(UTC),
                completed_at=_parse_timestamp(row["completed_at"]),
            )
            for row in rows
        ]

    async def update_todo_text(self, todo_id: int, text: str) -> bool:
        """Update the text of a todo.

        Args:
            todo_id: The todo ID
            text: New todo text

        Returns:
            True if the todo was updated, False if it didn't exist
        """
        await self._ensure_initialized()
        async with self._lock, self._connect() as db:
            cursor = await db.execute(
                "UPDATE todos SET text = ? WHERE id = ?",
                (text, todo_id),
            )
            updated = cursor.rowcount > 0
            await db.commit()
            return updated

    async def complete_todo(self, todo_id: int) -> bool:
        """Mark a todo as completed.

        Args:
            todo_id: The todo ID

        Returns:
            True if the todo was updated, False if it didn't exist
        """
        await self._ensure_initialized()
        now = _timestamp_now()

        async with self._lock, self._connect() as db:
            cursor = await db.execute(
                "UPDATE todos SET completed = 1, completed_at = ? WHERE id = ?",
                (now, todo_id),
            )
            updated = cursor.rowcount > 0
            await db.commit()
            return updated

    async def uncomplete_todo(self, todo_id: int) -> bool:
        """Mark a todo as not completed.

        Args:
            todo_id: The todo ID

        Returns:
            True if the todo was updated, False if it didn't exist
        """
        await self._ensure_initialized()
        async with self._lock, self._connect() as db:
            cursor = await db.execute(
                "UPDATE todos SET completed = 0, completed_at = NULL WHERE id = ?",
                (todo_id,),
            )
            updated = cursor.rowcount > 0
            await db.commit()
            return updated

    async def delete_todo(self, todo_id: int) -> bool:
        """Delete a todo.

        Args:
            todo_id: The todo ID

        Returns:
            True if the todo was deleted, False if it didn't exist
        """
        await self._ensure_initialized()
        async with self._lock, self._connect() as db:
            cursor = await db.execute(
                "DELETE FROM todos WHERE id = ?",
                (todo_id,),
            )
            deleted = cursor.rowcount > 0
            await db.commit()
            return deleted

    # ==================== Search Operations (FTS5) ====================

    async def search_events(
        self,
        query: str,
        *,
        session_id: str | None = None,
        limit: int = 50,
    ) -> list[SessionEventRecord]:
        """Search session events using full-text search.

        Args:
            query: Search query (FTS5 syntax supported)
            session_id: Optional session ID to filter by
            limit: Maximum number of results to return

        Returns:
            List of SessionEventRecord objects matching the query
        """
        await self._ensure_initialized()

        # Build query with optional session filter
        sql = """
            SELECT se.*
            FROM session_events_fts fts
            JOIN session_events se ON se.id = fts.rowid
            WHERE session_events_fts MATCH ?
        """
        params: list[Any] = [query]

        if session_id is not None:
            sql += " AND se.session_id = ?"
            params.append(session_id)

        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)

        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(sql, params) as cursor:
                rows = await cursor.fetchall()

        return [
            SessionEventRecord(
                id=row["id"],
                session_id=row["session_id"],
                ts=_parse_timestamp(row["ts"]) or datetime.now(UTC),
                type=row["type"],
                payload=json.loads(row["payload_json"]),
            )
            for row in rows
        ]

    async def search_checkpoints(
        self,
        query: str,
        *,
        session_id: str | None = None,
        limit: int = 50,
    ) -> list[CheckpointRecord]:
        """Search checkpoints using full-text search.

        Args:
            query: Search query (FTS5 syntax supported)
            session_id: Optional session ID to filter by
            limit: Maximum number of results to return

        Returns:
            List of CheckpointRecord objects matching the query
        """
        await self._ensure_initialized()

        # Build query with optional session filter
        sql = """
            SELECT c.*
            FROM checkpoints_fts fts
            JOIN checkpoints c ON c.checkpoint_id = fts.checkpoint_id
            WHERE checkpoints_fts MATCH ?
        """
        params: list[Any] = [query]

        if session_id is not None:
            sql += " AND c.session_id = ?"
            params.append(session_id)

        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)

        async with self._lock, self._connect() as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(sql, params) as cursor:
                rows = await cursor.fetchall()

        return [
            CheckpointRecord(
                checkpoint_id=row["checkpoint_id"],
                session_id=row["session_id"],
                session_node_id=row["session_node_id"],
                jj_commit_id=row["jj_commit_id"],
                bookmark_name=row["bookmark_name"],
                message=row["message"],
                created_at=_parse_timestamp(row["created_at"]) or datetime.now(UTC),
            )
            for row in rows
        ]

    async def search_todos(
        self,
        query: str,
        *,
        workspace_id: str | None = None,
        session_id: str | None = None,
        limit: int = 50,
    ) -> list[TodoRecord]:
        """Search todos using full-text search.

        Args:
            query: Search query (FTS5 syntax supported)
            workspace_id: Optional workspace ID to filter by
            session_id: Optional session ID to filter by
            limit: Maximum number of results to return

        Returns:
            List of TodoRecord objects matching the query
        """
        await self._ensure_initialized()

        # Build query with optional filters
        sql = """
            SELECT t.*
            FROM todos_fts fts
            JOIN todos t ON t.id = fts.rowid
            WHERE todos_fts MATCH ?
        """
        params: list[Any] = [query]

        if workspace_id is not None:
            sql += " AND t.workspace_id = ?"
            params.append(workspace_id)
        if session_id is not None:
            sql += " AND t.session_id = ?"
            params.append(session_id)

        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)

        async with self._lock, self._connect() as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(sql, params) as cursor:
                rows = await cursor.fetchall()

        return [
            TodoRecord(
                id=row["id"],
                workspace_id=row["workspace_id"],
                session_id=row["session_id"],
                text=row["text"],
                completed=bool(row["completed"]),
                attached_node_id=row["attached_node_id"],
                created_at=_parse_timestamp(row["created_at"]) or datetime.now(UTC),
                completed_at=_parse_timestamp(row["completed_at"]),
            )
            for row in rows
        ]

    async def search_all(
        self,
        query: str,
        *,
        workspace_id: str | None = None,
        session_id: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        """Search across all indexed content (events, checkpoints, and todos).

        Args:
            query: Search query (FTS5 syntax supported)
            workspace_id: Optional workspace ID to filter todos by
            session_id: Optional session ID to filter by
            limit: Maximum number of results per category

        Returns:
            Dict with 'events', 'checkpoints', and 'todos' keys containing matching results
        """
        await self._ensure_initialized()

        # Search across all categories concurrently
        events_task = self.search_events(query, session_id=session_id, limit=limit)
        checkpoints_task = self.search_checkpoints(query, session_id=session_id, limit=limit)
        todos_task = self.search_todos(
            query, workspace_id=workspace_id, session_id=session_id, limit=limit
        )

        events, checkpoints, todos = await asyncio.gather(
            events_task, checkpoints_task, todos_task
        )

        return {
            "events": events,
            "checkpoints": checkpoints,
            "todos": todos,
            "total": len(events) + len(checkpoints) + len(todos),
        }


def _timestamp_now() -> str:
    """Get the current UTC timestamp as an ISO string."""
    return datetime.now(UTC).isoformat()


def _parse_timestamp(value: str | None) -> datetime | None:
    """Parse an ISO timestamp string to datetime."""
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None
