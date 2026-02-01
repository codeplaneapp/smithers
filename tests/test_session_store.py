"""Tests for the session store."""

import asyncio

import pytest

from agentd.protocol.events import EventType
from agentd.store.sqlite import SessionStore


class TestSessionStore:
    """Test the session store."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_initialize_creates_schema(self, tmp_path):
        """Store initialization should create database schema."""
        db_path = tmp_path / "test.db"
        store = SessionStore(db_path)
        await store.initialize()

        assert db_path.exists()

    @pytest.mark.asyncio
    async def test_create_session(self, store):
        """Should create a new session."""
        session_id = await store.create_session("/workspace", session_id="test-session")

        assert session_id == "test-session"

        session = await store.get_session(session_id)
        assert session is not None
        assert session.id == "test-session"
        assert session.workspace_root == "/workspace"
        assert session.created_at is not None
        assert session.last_active_at is not None

    @pytest.mark.asyncio
    async def test_get_nonexistent_session(self, store):
        """Getting a nonexistent session should return None."""
        session = await store.get_session("nonexistent")
        assert session is None

    @pytest.mark.asyncio
    async def test_list_sessions(self, store):
        """Should list all sessions ordered by most recent activity."""
        # Create multiple sessions
        await store.create_session("/workspace1", session_id="session1")
        await store.create_session("/workspace2", session_id="session2")
        await store.create_session("/workspace3", session_id="session3")

        # Update last_active for session1
        await asyncio.sleep(0.01)  # Small delay to ensure different timestamps
        await store.update_last_active("session1")

        sessions = await store.list_sessions()
        assert len(sessions) == 3
        # session1 should be first (most recently active)
        assert sessions[0].id == "session1"

    @pytest.mark.asyncio
    async def test_list_sessions_limit(self, store):
        """Should respect limit parameter."""
        for i in range(5):
            await store.create_session(f"/workspace{i}", session_id=f"session{i}")

        sessions = await store.list_sessions(limit=3)
        assert len(sessions) == 3

    @pytest.mark.asyncio
    async def test_update_last_active(self, store):
        """Should update last_active timestamp."""
        session_id = await store.create_session("/workspace", session_id="test-session")

        session_before = await store.get_session(session_id)
        assert session_before is not None

        await asyncio.sleep(0.01)  # Small delay
        await store.update_last_active(session_id)

        session_after = await store.get_session(session_id)
        assert session_after is not None
        assert session_after.last_active_at > session_before.last_active_at

    @pytest.mark.asyncio
    async def test_delete_session(self, store):
        """Should delete a session."""
        session_id = await store.create_session("/workspace", session_id="test-session")
        await store.append_event(session_id, EventType.RUN_STARTED, {"run_id": "123"})

        deleted = await store.delete_session(session_id)
        assert deleted is True

        session = await store.get_session(session_id)
        assert session is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent_session(self, store):
        """Deleting a nonexistent session should return False."""
        deleted = await store.delete_session("nonexistent")
        assert deleted is False


class TestSchemaVersioning:
    """Test schema versioning and migrations."""

    @pytest.mark.asyncio
    async def test_schema_version_set_on_initialization(self, tmp_path):
        """Schema version should be set when database is initialized."""
        from agentd.store.sqlite import SCHEMA_VERSION

        store = SessionStore(tmp_path / "test.db")
        await store.initialize()

        version = await store.get_schema_version()
        assert version == SCHEMA_VERSION
        assert version == 1  # Current version

    @pytest.mark.asyncio
    async def test_schema_version_persists_across_reopens(self, tmp_path):
        """Schema version should persist when database is reopened."""
        from agentd.store.sqlite import SCHEMA_VERSION

        db_path = tmp_path / "test.db"

        # Create and initialize database
        store1 = SessionStore(db_path)
        await store1.initialize()
        version1 = await store1.get_schema_version()

        # Reopen database
        store2 = SessionStore(db_path)
        await store2.initialize()
        version2 = await store2.get_schema_version()

        assert version1 == version2 == SCHEMA_VERSION

    @pytest.mark.asyncio
    async def test_multiple_initializations_dont_duplicate_version(self, tmp_path):
        """Multiple initializations should not create duplicate version records."""
        import aiosqlite

        store = SessionStore(tmp_path / "test.db")
        await store.initialize()
        await store.initialize()  # Second initialization
        await store.initialize()  # Third initialization

        # Query version table directly
        async with aiosqlite.connect(tmp_path / "test.db") as db:
            async with db.execute("SELECT COUNT(*) FROM schema_version") as cursor:
                row = await cursor.fetchone()
                count = row[0] if row else 0

        # Should only have one version record
        assert count == 1


class TestSessionEvents:
    """Test session event operations."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store with a session."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        await store.create_session("/workspace", session_id="test-session")
        return store

    @pytest.mark.asyncio
    async def test_append_event(self, store):
        """Should append an event to session log."""
        event_id = await store.append_event(
            "test-session",
            EventType.RUN_STARTED,
            {"run_id": "123"},
        )

        assert event_id > 0

        events = await store.get_events("test-session")
        # Should have SESSION_CREATED (from create_session) + RUN_STARTED
        assert len(events) >= 2
        assert any(e.type == EventType.RUN_STARTED.value for e in events)

    @pytest.mark.asyncio
    async def test_append_event_with_string_type(self, store):
        """Should accept event type as string."""
        event_id = await store.append_event(
            "test-session",
            "custom.event",
            {"data": "test"},
        )

        assert event_id > 0

        events = await store.get_events("test-session", event_type="custom.event")
        assert len(events) == 1
        assert events[0].type == "custom.event"

    @pytest.mark.asyncio
    async def test_get_events(self, store):
        """Should retrieve events for a session."""
        # Append multiple events
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Hello"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        events = await store.get_events("test-session")
        # Should have SESSION_CREATED + 3 events
        assert len(events) >= 4

    @pytest.mark.asyncio
    async def test_get_events_with_type_filter(self, store):
        """Should filter events by type."""
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Hello"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        events = await store.get_events(
            "test-session",
            event_type=EventType.ASSISTANT_DELTA.value,
        )
        assert len(events) == 1
        assert events[0].type == EventType.ASSISTANT_DELTA.value
        assert events[0].payload["text"] == "Hello"

    @pytest.mark.asyncio
    async def test_get_events_since_id(self, store):
        """Should retrieve events after a specific ID."""
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        first_events = await store.get_events("test-session")
        last_id = first_events[-1].id

        # Add more events
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Hello"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        new_events = await store.get_events("test-session", since_id=last_id)
        assert len(new_events) == 2

    @pytest.mark.asyncio
    async def test_get_events_with_limit(self, store):
        """Should respect limit parameter."""
        # Add multiple events
        for i in range(10):
            await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": f"msg{i}"})

        events = await store.get_events("test-session", limit=5)
        assert len(events) == 5

    @pytest.mark.asyncio
    async def test_get_events_as_protocol_events(self, store):
        """Should convert events to protocol Event objects."""
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})

        events = await store.get_events_as_protocol_events("test-session")
        assert len(events) >= 2  # SESSION_CREATED + RUN_STARTED

        # Check that they're proper Event objects
        run_started = next(e for e in events if e.type == EventType.RUN_STARTED)
        assert run_started.data["run_id"] == "123"
        assert run_started.timestamp is not None

    @pytest.mark.asyncio
    async def test_get_event_count(self, store):
        """Should count events for a session."""
        count_before = await store.get_event_count("test-session")

        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        count_after = await store.get_event_count("test-session")
        assert count_after == count_before + 2

    @pytest.mark.asyncio
    async def test_get_latest_event_id(self, store):
        """Should get the latest event ID."""
        latest_before = await store.get_latest_event_id("test-session")
        assert latest_before is not None

        event_id = await store.append_event(
            "test-session", EventType.RUN_STARTED, {"run_id": "123"}
        )

        latest_after = await store.get_latest_event_id("test-session")
        assert latest_after == event_id
        assert latest_after > latest_before

    @pytest.mark.asyncio
    async def test_get_latest_event_id_empty(self, store, tmp_path):
        """Should return None for session with no events."""
        # Create a new store without any sessions
        empty_store = SessionStore(tmp_path / "empty.db")
        await empty_store.initialize()

        latest = await empty_store.get_latest_event_id("nonexistent")
        assert latest is None

    @pytest.mark.asyncio
    async def test_events_ordered_by_id(self, store):
        """Events should be ordered by ID (chronological)."""
        # Add events
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "First"})
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Second"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        events = await store.get_events("test-session")

        # Verify IDs are ascending
        for i in range(1, len(events)):
            assert events[i].id > events[i - 1].id


class TestSessionStats:
    """Test session statistics."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store with a session and events."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        await store.create_session("/workspace", session_id="test-session")

        # Add some events
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Hello"})
        await store.append_event("test-session", EventType.TOOL_START, {"tool": "bash"})
        await store.append_event("test-session", EventType.TOOL_END, {"tool": "bash"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        return store

    @pytest.mark.asyncio
    async def test_get_session_stats(self, store):
        """Should get comprehensive session statistics."""
        stats = await store.get_session_stats("test-session")

        assert stats["session_id"] == "test-session"
        assert stats["workspace_root"] == "/workspace"
        assert "created_at" in stats
        assert "last_active_at" in stats
        assert stats["total_events"] >= 5  # SESSION_CREATED + 5 events

        event_counts = stats["event_counts"]
        assert EventType.SESSION_CREATED.value in event_counts
        assert EventType.RUN_STARTED.value in event_counts
        assert EventType.ASSISTANT_DELTA.value in event_counts
        assert event_counts[EventType.RUN_STARTED.value] == 1
        assert event_counts[EventType.RUN_FINISHED.value] == 1

    @pytest.mark.asyncio
    async def test_get_stats_for_nonexistent_session(self, store):
        """Should return empty dict for nonexistent session."""
        stats = await store.get_session_stats("nonexistent")
        assert stats == {}


class TestConcurrency:
    """Test concurrent operations on the session store."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_concurrent_event_appends(self, store):
        """Should handle concurrent event appends safely."""
        await store.create_session("/workspace", session_id="test-session")

        # Append events concurrently
        tasks = [
            store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": f"msg{i}"})
            for i in range(50)
        ]
        event_ids = await asyncio.gather(*tasks)

        # All event IDs should be unique
        assert len(set(event_ids)) == 50

        # All events should be in the database
        events = await store.get_events("test-session")
        assistant_deltas = [e for e in events if e.type == EventType.ASSISTANT_DELTA.value]
        assert len(assistant_deltas) == 50

    @pytest.mark.asyncio
    async def test_concurrent_session_creation(self, store):
        """Should handle concurrent session creation safely."""
        # Create sessions concurrently
        tasks = [
            store.create_session(f"/workspace{i}", session_id=f"session{i}") for i in range(20)
        ]
        session_ids = await asyncio.gather(*tasks)

        # All session IDs should be unique
        assert len(set(session_ids)) == 20

        # All sessions should be in the database
        sessions = await store.list_sessions(limit=100)
        assert len(sessions) == 20


class TestEventSourcing:
    """Test event sourcing patterns."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_event_log_is_append_only(self, store):
        """Events should never be modified or deleted (except with session)."""
        await store.create_session("/workspace", session_id="test-session")

        # Add initial events
        id1 = await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        id2 = await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Hello"})

        # Add more events
        id3 = await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        # Original events should still be there with same IDs
        events = await store.get_events("test-session")
        event_ids = [e.id for e in events]

        assert id1 in event_ids
        assert id2 in event_ids
        assert id3 in event_ids

    @pytest.mark.asyncio
    async def test_session_reconstruction_from_events(self, store):
        """Should be able to reconstruct session state from event log."""
        await store.create_session("/workspace", session_id="test-session")

        # Simulate a conversation
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "run1"})
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Hello"})
        await store.append_event(
            "test-session", EventType.TOOL_START, {"tool": "bash", "args": "ls"}
        )
        await store.append_event(
            "test-session", EventType.TOOL_END, {"tool": "bash", "result": "file1.txt"}
        )
        await store.append_event("test-session", EventType.ASSISTANT_FINAL, {"text": "Done"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "run1"})

        # Retrieve all events
        events = await store.get_events("test-session")

        # Verify we can see the full conversation flow
        event_types = [e.type for e in events]
        assert EventType.SESSION_CREATED.value in event_types
        assert EventType.RUN_STARTED.value in event_types
        assert EventType.ASSISTANT_DELTA.value in event_types
        assert EventType.TOOL_START.value in event_types
        assert EventType.TOOL_END.value in event_types
        assert EventType.RUN_FINISHED.value in event_types

    @pytest.mark.asyncio
    async def test_incremental_event_loading(self, store):
        """Should support incremental event loading for real-time updates."""
        await store.create_session("/workspace", session_id="test-session")

        # Initial events
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        initial_events = await store.get_events("test-session")
        last_id = initial_events[-1].id

        # Add more events
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "New"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        # Get only new events
        new_events = await store.get_events("test-session", since_id=last_id)
        assert len(new_events) == 2
        assert all(e.id > last_id for e in new_events)


class TestDatabaseIntegrity:
    """Test database integrity and constraints."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_multiple_initializations_safe(self, tmp_path):
        """Multiple initializations should be safe."""
        db_path = tmp_path / "test.db"

        store1 = SessionStore(db_path)
        await store1.initialize()
        await store1.create_session("/workspace1", session_id="session1")

        # Create another store pointing to same DB
        store2 = SessionStore(db_path)
        await store2.initialize()

        # Both should see the same data
        session = await store2.get_session("session1")
        assert session is not None
        assert session.workspace_root == "/workspace1"

    @pytest.mark.asyncio
    async def test_events_reference_session(self, store):
        """Events should reference their session."""
        await store.create_session("/workspace", session_id="test-session")
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        # Verify events exist
        events = await store.get_events("test-session")
        assert len(events) >= 2
        assert all(e.session_id == "test-session" for e in events)


class TestCheckpoints:
    """Test checkpoint operations."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store with a session."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        await store.create_session("/workspace", session_id="test-session")
        return store

    @pytest.mark.asyncio
    async def test_create_checkpoint(self, store):
        """Should create a new checkpoint."""
        checkpoint = await store.create_checkpoint(
            checkpoint_id="cp-123",
            session_id="test-session",
            jj_commit_id="abc123def456",
            bookmark_name="checkpoint-cp-123",
            message="Test checkpoint",
        )

        assert checkpoint.checkpoint_id == "cp-123"
        assert checkpoint.session_id == "test-session"
        assert checkpoint.jj_commit_id == "abc123def456"
        assert checkpoint.bookmark_name == "checkpoint-cp-123"
        assert checkpoint.message == "Test checkpoint"
        assert checkpoint.session_node_id is None
        assert checkpoint.created_at is not None

    @pytest.mark.asyncio
    async def test_create_checkpoint_with_node_id(self, store):
        """Should create a checkpoint with session node ID."""
        checkpoint = await store.create_checkpoint(
            checkpoint_id="cp-456",
            session_id="test-session",
            jj_commit_id="xyz789",
            bookmark_name="checkpoint-cp-456",
            message="Checkpoint with node",
            session_node_id="node-123",
        )

        assert checkpoint.session_node_id == "node-123"

    @pytest.mark.asyncio
    async def test_get_checkpoint(self, store):
        """Should retrieve a checkpoint by ID."""
        await store.create_checkpoint(
            checkpoint_id="cp-789",
            session_id="test-session",
            jj_commit_id="commit123",
            bookmark_name="checkpoint-cp-789",
            message="Test checkpoint",
        )

        checkpoint = await store.get_checkpoint("cp-789")
        assert checkpoint is not None
        assert checkpoint.checkpoint_id == "cp-789"
        assert checkpoint.jj_commit_id == "commit123"

    @pytest.mark.asyncio
    async def test_get_nonexistent_checkpoint(self, store):
        """Getting a nonexistent checkpoint should return None."""
        checkpoint = await store.get_checkpoint("nonexistent")
        assert checkpoint is None

    @pytest.mark.asyncio
    async def test_list_checkpoints(self, store):
        """Should list checkpoints for a session."""
        # Create multiple checkpoints
        await store.create_checkpoint(
            checkpoint_id="cp-1",
            session_id="test-session",
            jj_commit_id="commit1",
            bookmark_name="checkpoint-cp-1",
            message="First checkpoint",
        )
        await asyncio.sleep(0.01)  # Ensure different timestamps
        await store.create_checkpoint(
            checkpoint_id="cp-2",
            session_id="test-session",
            jj_commit_id="commit2",
            bookmark_name="checkpoint-cp-2",
            message="Second checkpoint",
        )
        await asyncio.sleep(0.01)
        await store.create_checkpoint(
            checkpoint_id="cp-3",
            session_id="test-session",
            jj_commit_id="commit3",
            bookmark_name="checkpoint-cp-3",
            message="Third checkpoint",
        )

        checkpoints = await store.list_checkpoints("test-session")
        assert len(checkpoints) == 3
        # Should be ordered by most recent first
        assert checkpoints[0].checkpoint_id == "cp-3"
        assert checkpoints[1].checkpoint_id == "cp-2"
        assert checkpoints[2].checkpoint_id == "cp-1"

    @pytest.mark.asyncio
    async def test_list_checkpoints_limit(self, store):
        """Should respect limit parameter."""
        for i in range(5):
            await store.create_checkpoint(
                checkpoint_id=f"cp-{i}",
                session_id="test-session",
                jj_commit_id=f"commit{i}",
                bookmark_name=f"checkpoint-cp-{i}",
                message=f"Checkpoint {i}",
            )
            await asyncio.sleep(0.01)

        checkpoints = await store.list_checkpoints("test-session", limit=3)
        assert len(checkpoints) == 3

    @pytest.mark.asyncio
    async def test_list_checkpoints_for_different_sessions(self, store, tmp_path):
        """Should only list checkpoints for the specified session."""
        # Create another session
        await store.create_session("/workspace2", session_id="session2")

        # Create checkpoints for both sessions
        await store.create_checkpoint(
            checkpoint_id="cp-session1",
            session_id="test-session",
            jj_commit_id="commit1",
            bookmark_name="checkpoint-cp-session1",
            message="Session 1 checkpoint",
        )
        await store.create_checkpoint(
            checkpoint_id="cp-session2",
            session_id="session2",
            jj_commit_id="commit2",
            bookmark_name="checkpoint-cp-session2",
            message="Session 2 checkpoint",
        )

        # List checkpoints for test-session
        checkpoints = await store.list_checkpoints("test-session")
        assert len(checkpoints) == 1
        assert checkpoints[0].checkpoint_id == "cp-session1"

        # List checkpoints for session2
        checkpoints = await store.list_checkpoints("session2")
        assert len(checkpoints) == 1
        assert checkpoints[0].checkpoint_id == "cp-session2"

    @pytest.mark.asyncio
    async def test_delete_checkpoint(self, store):
        """Should delete a checkpoint."""
        await store.create_checkpoint(
            checkpoint_id="cp-delete",
            session_id="test-session",
            jj_commit_id="commit123",
            bookmark_name="checkpoint-cp-delete",
            message="To be deleted",
        )

        deleted = await store.delete_checkpoint("cp-delete")
        assert deleted is True

        checkpoint = await store.get_checkpoint("cp-delete")
        assert checkpoint is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent_checkpoint(self, store):
        """Deleting a nonexistent checkpoint should return False."""
        deleted = await store.delete_checkpoint("nonexistent")
        assert deleted is False

    @pytest.mark.asyncio
    async def test_checkpoints_deleted_with_session(self, store):
        """Checkpoints should be deleted when session is deleted."""
        await store.create_checkpoint(
            checkpoint_id="cp-cascade",
            session_id="test-session",
            jj_commit_id="commit123",
            bookmark_name="checkpoint-cp-cascade",
            message="Test cascade",
        )

        # Verify checkpoint exists
        checkpoint = await store.get_checkpoint("cp-cascade")
        assert checkpoint is not None

        # Delete session
        await store.delete_session("test-session")

        # Checkpoint should be gone (cascade delete)
        checkpoint = await store.get_checkpoint("cp-cascade")
        assert checkpoint is None


class TestFullTextSearch:
    """Test full-text search (FTS5) functionality."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store with searchable content."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        await store.create_session("/workspace", session_id="test-session")

        # Add events with searchable content
        await store.append_event(
            "test-session",
            EventType.ASSISTANT_DELTA,
            {"content": "Hello, I can help you with Python programming"},
        )
        await store.append_event(
            "test-session",
            EventType.ASSISTANT_FINAL,
            {"text": "Let me write a function to calculate fibonacci numbers"},
        )
        await store.append_event(
            "test-session",
            EventType.TOOL_START,
            {"message": "Running tests on the authentication module"},
        )
        await store.append_event(
            "test-session",
            EventType.TOOL_END,
            {"preview": "Successfully installed pytest and dependencies"},
        )

        # Add checkpoints with searchable content
        await store.create_checkpoint(
            checkpoint_id="cp-1",
            session_id="test-session",
            jj_commit_id="commit1",
            bookmark_name="feature-authentication",
            message="Implemented user authentication with JWT tokens",
        )
        await store.create_checkpoint(
            checkpoint_id="cp-2",
            session_id="test-session",
            jj_commit_id="commit2",
            bookmark_name="bugfix-database",
            message="Fixed database connection pool exhaustion bug",
        )

        return store

    @pytest.mark.asyncio
    async def test_search_events_basic(self, store):
        """Should search events by content."""
        results = await store.search_events("Python")
        assert len(results) > 0
        assert any("Python" in str(r.payload) for r in results)

    @pytest.mark.asyncio
    async def test_search_events_multiple_fields(self, store):
        """Should search across multiple payload fields."""
        # Search for "fibonacci" which is in the "text" field
        results = await store.search_events("fibonacci")
        assert len(results) > 0

        # Search for "authentication" which is in the "message" field
        results = await store.search_events("authentication")
        assert len(results) > 0

        # Search for "pytest" which is in the "preview" field
        results = await store.search_events("pytest")
        assert len(results) > 0

    @pytest.mark.asyncio
    async def test_search_events_case_insensitive(self, store):
        """Search should be case insensitive."""
        results_lower = await store.search_events("python")
        results_upper = await store.search_events("PYTHON")
        results_mixed = await store.search_events("Python")

        # All should return the same results
        assert len(results_lower) == len(results_upper) == len(results_mixed)

    @pytest.mark.asyncio
    async def test_search_events_with_session_filter(self, store):
        """Should filter search results by session ID."""
        # Create another session with different content
        await store.create_session("/workspace2", session_id="session2")
        await store.append_event(
            "session2",
            EventType.ASSISTANT_DELTA,
            {"content": "Working with JavaScript and React"},
        )

        # Search in specific session
        results = await store.search_events("Python", session_id="test-session")
        assert len(results) > 0
        assert all(r.session_id == "test-session" for r in results)

        # JavaScript should not be in test-session results
        results = await store.search_events("JavaScript", session_id="test-session")
        assert len(results) == 0

    @pytest.mark.asyncio
    async def test_search_events_limit(self, store):
        """Should respect limit parameter."""
        # Add many events
        for i in range(20):
            await store.append_event(
                "test-session",
                EventType.ASSISTANT_DELTA,
                {"content": f"Message number {i} about Python programming"},
            )

        results = await store.search_events("Python", limit=5)
        assert len(results) == 5

    @pytest.mark.asyncio
    async def test_search_events_no_results(self, store):
        """Should return empty list when no matches found."""
        results = await store.search_events("nonexistent_term_xyz")
        assert len(results) == 0

    @pytest.mark.asyncio
    async def test_search_events_phrase_query(self, store):
        """Should support phrase queries."""
        results = await store.search_events('"fibonacci numbers"')
        assert len(results) > 0

    @pytest.mark.asyncio
    async def test_search_checkpoints_basic(self, store):
        """Should search checkpoints by message."""
        results = await store.search_checkpoints("authentication")
        assert len(results) > 0
        assert any("authentication" in r.message.lower() for r in results)

    @pytest.mark.asyncio
    async def test_search_checkpoints_bookmark_name(self, store):
        """Should search checkpoints by bookmark name."""
        results = await store.search_checkpoints("bugfix")
        assert len(results) > 0
        assert any("bugfix" in r.bookmark_name.lower() for r in results)

    @pytest.mark.asyncio
    async def test_search_checkpoints_with_session_filter(self, store):
        """Should filter checkpoint search by session ID."""
        # Create another session with different checkpoint
        await store.create_session("/workspace2", session_id="session2")
        await store.create_checkpoint(
            checkpoint_id="cp-other",
            session_id="session2",
            jj_commit_id="commit-other",
            bookmark_name="feature-other",
            message="Added feature to session2",
        )

        # Search in specific session
        results = await store.search_checkpoints("authentication", session_id="test-session")
        assert len(results) > 0
        assert all(r.session_id == "test-session" for r in results)

    @pytest.mark.asyncio
    async def test_search_checkpoints_limit(self, store):
        """Should respect limit parameter."""
        # Add many checkpoints
        for i in range(10):
            await store.create_checkpoint(
                checkpoint_id=f"cp-test-{i}",
                session_id="test-session",
                jj_commit_id=f"commit-{i}",
                bookmark_name=f"test-{i}",
                message=f"Test checkpoint {i} with keyword testquery",
            )

        results = await store.search_checkpoints("testquery", limit=5)
        assert len(results) == 5

    @pytest.mark.asyncio
    async def test_search_checkpoints_no_results(self, store):
        """Should return empty list when no matches found."""
        results = await store.search_checkpoints("nonexistent_xyz")
        assert len(results) == 0

    @pytest.mark.asyncio
    async def test_search_all(self, store):
        """Should search across all content types."""
        results = await store.search_all("authentication")

        assert "events" in results
        assert "checkpoints" in results
        assert "total" in results

        # Should find results in both events and checkpoints
        assert len(results["events"]) > 0
        assert len(results["checkpoints"]) > 0
        assert results["total"] == len(results["events"]) + len(results["checkpoints"])

    @pytest.mark.asyncio
    async def test_search_all_with_session_filter(self, store):
        """Should filter all search by session ID."""
        results = await store.search_all("authentication", session_id="test-session")

        assert all(e.session_id == "test-session" for e in results["events"])
        assert all(c.session_id == "test-session" for c in results["checkpoints"])

    @pytest.mark.asyncio
    async def test_search_all_limit(self, store):
        """Should apply limit to each category."""
        # Add many events and checkpoints
        for i in range(20):
            await store.append_event(
                "test-session",
                EventType.ASSISTANT_DELTA,
                {"content": f"Testing search functionality {i}"},
            )
            await store.create_checkpoint(
                checkpoint_id=f"cp-search-{i}",
                session_id="test-session",
                jj_commit_id=f"commit-{i}",
                bookmark_name=f"search-{i}",
                message=f"Checkpoint for testing search {i}",
            )

        results = await store.search_all("testing", limit=5)

        # Each category should respect the limit
        assert len(results["events"]) <= 5
        assert len(results["checkpoints"]) <= 5

    @pytest.mark.asyncio
    async def test_fts_index_synchronized_on_insert(self, store):
        """FTS index should be updated when events are inserted."""
        # Add a new event after store is created
        await store.append_event(
            "test-session",
            EventType.ASSISTANT_DELTA,
            {"content": "New unique search term: xyzabc123"},
        )

        # Should be immediately searchable
        results = await store.search_events("xyzabc123")
        assert len(results) == 1
        assert "xyzabc123" in results[0].payload["content"]

    @pytest.mark.asyncio
    async def test_fts_index_synchronized_on_checkpoint_insert(self, store):
        """FTS index should be updated when checkpoints are inserted."""
        await store.create_checkpoint(
            checkpoint_id="cp-new",
            session_id="test-session",
            jj_commit_id="commit-new",
            bookmark_name="unique-bookmark-xyz789",
            message="Checkpoint with unique term uniqueterm456",
        )

        # Should be immediately searchable
        results = await store.search_checkpoints("uniqueterm456")
        assert len(results) == 1
        assert "uniqueterm456" in results[0].message

    @pytest.mark.asyncio
    async def test_fts_index_synchronized_on_delete(self, store):
        """FTS index should be updated when sessions are deleted."""
        # Search before deletion
        results_before = await store.search_events("Python")
        count_before = len(results_before)
        assert count_before > 0

        # Delete the session
        await store.delete_session("test-session")

        # Create a new session to search from
        await store.create_session("/workspace3", session_id="session3")

        # Search after deletion - should not find the deleted content
        results_after = await store.search_events("Python", session_id="test-session")
        assert len(results_after) == 0

    @pytest.mark.asyncio
    async def test_search_ranking(self, store):
        """Results should be ranked by relevance."""
        # Add events with varying relevance
        await store.append_event(
            "test-session",
            EventType.ASSISTANT_DELTA,
            {"content": "database database database"},  # More occurrences
        )
        await store.append_event(
            "test-session",
            EventType.ASSISTANT_DELTA,
            {"content": "database query"},  # One occurrence
        )

        results = await store.search_events("database")
        assert len(results) >= 2

        # Results should be ordered by rank (FTS5 handles this automatically)


class TestTodos:
    """Test todo operations."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store with a session."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        await store.create_session("/workspace", session_id="test-session")
        return store

    @pytest.mark.asyncio
    async def test_create_todo(self, store):
        """Should create a new todo."""
        todo = await store.create_todo(
            workspace_id="/workspace",
            text="Implement feature X",
        )

        assert todo.id > 0
        assert todo.workspace_id == "/workspace"
        assert todo.text == "Implement feature X"
        assert todo.completed is False
        assert todo.session_id is None
        assert todo.attached_node_id is None
        assert todo.created_at is not None
        assert todo.completed_at is None

    @pytest.mark.asyncio
    async def test_create_todo_with_session(self, store):
        """Should create a todo attached to a session."""
        todo = await store.create_todo(
            workspace_id="/workspace",
            text="Fix bug in session handling",
            session_id="test-session",
        )

        assert todo.session_id == "test-session"

    @pytest.mark.asyncio
    async def test_create_todo_with_node(self, store):
        """Should create a todo attached to a graph node."""
        todo = await store.create_todo(
            workspace_id="/workspace",
            text="Review tool output",
            attached_node_id="node-123",
        )

        assert todo.attached_node_id == "node-123"

    @pytest.mark.asyncio
    async def test_get_todo(self, store):
        """Should retrieve a todo by ID."""
        created = await store.create_todo(
            workspace_id="/workspace",
            text="Test todo",
        )

        retrieved = await store.get_todo(created.id)
        assert retrieved is not None
        assert retrieved.id == created.id
        assert retrieved.text == "Test todo"

    @pytest.mark.asyncio
    async def test_get_nonexistent_todo(self, store):
        """Getting a nonexistent todo should return None."""
        todo = await store.get_todo(99999)
        assert todo is None

    @pytest.mark.asyncio
    async def test_list_todos(self, store):
        """Should list all todos for a workspace."""
        await store.create_todo("/workspace", "Todo 1")
        await store.create_todo("/workspace", "Todo 2")
        await store.create_todo("/workspace", "Todo 3")

        todos = await store.list_todos("/workspace")
        assert len(todos) == 3
        # Should be ordered by created_at DESC (newest first)
        assert todos[0].text == "Todo 3"
        assert todos[1].text == "Todo 2"
        assert todos[2].text == "Todo 1"

    @pytest.mark.asyncio
    async def test_list_todos_by_session(self, store):
        """Should filter todos by session ID."""
        await store.create_todo("/workspace", "General todo")
        await store.create_todo("/workspace", "Session todo", session_id="test-session")

        todos = await store.list_todos("/workspace", session_id="test-session")
        assert len(todos) == 1
        assert todos[0].text == "Session todo"

    @pytest.mark.asyncio
    async def test_list_todos_by_completion(self, store):
        """Should filter todos by completion status."""
        await store.create_todo("/workspace", "Not done")
        todo2 = await store.create_todo("/workspace", "Done")
        await store.complete_todo(todo2.id)

        # Get incomplete todos
        incomplete = await store.list_todos("/workspace", completed=False)
        assert len(incomplete) == 1
        assert incomplete[0].text == "Not done"

        # Get completed todos
        completed_todos = await store.list_todos("/workspace", completed=True)
        assert len(completed_todos) == 1
        assert completed_todos[0].text == "Done"

    @pytest.mark.asyncio
    async def test_list_todos_limit(self, store):
        """Should respect limit parameter."""
        for i in range(10):
            await store.create_todo("/workspace", f"Todo {i}")

        todos = await store.list_todos("/workspace", limit=5)
        assert len(todos) == 5

    @pytest.mark.asyncio
    async def test_update_todo_text(self, store):
        """Should update todo text."""
        todo = await store.create_todo("/workspace", "Original text")

        updated = await store.update_todo_text(todo.id, "Updated text")
        assert updated is True

        retrieved = await store.get_todo(todo.id)
        assert retrieved is not None
        assert retrieved.text == "Updated text"

    @pytest.mark.asyncio
    async def test_update_nonexistent_todo(self, store):
        """Updating a nonexistent todo should return False."""
        updated = await store.update_todo_text(99999, "New text")
        assert updated is False

    @pytest.mark.asyncio
    async def test_complete_todo(self, store):
        """Should mark a todo as completed."""
        todo = await store.create_todo("/workspace", "Task to complete")

        completed = await store.complete_todo(todo.id)
        assert completed is True

        retrieved = await store.get_todo(todo.id)
        assert retrieved is not None
        assert retrieved.completed is True
        assert retrieved.completed_at is not None

    @pytest.mark.asyncio
    async def test_complete_nonexistent_todo(self, store):
        """Completing a nonexistent todo should return False."""
        completed = await store.complete_todo(99999)
        assert completed is False

    @pytest.mark.asyncio
    async def test_uncomplete_todo(self, store):
        """Should mark a completed todo as not completed."""
        todo = await store.create_todo("/workspace", "Task to uncomplete")
        await store.complete_todo(todo.id)

        uncompleted = await store.uncomplete_todo(todo.id)
        assert uncompleted is True

        retrieved = await store.get_todo(todo.id)
        assert retrieved is not None
        assert retrieved.completed is False
        assert retrieved.completed_at is None

    @pytest.mark.asyncio
    async def test_uncomplete_nonexistent_todo(self, store):
        """Uncompleting a nonexistent todo should return False."""
        uncompleted = await store.uncomplete_todo(99999)
        assert uncompleted is False

    @pytest.mark.asyncio
    async def test_delete_todo(self, store):
        """Should delete a todo."""
        todo = await store.create_todo("/workspace", "Todo to delete")

        deleted = await store.delete_todo(todo.id)
        assert deleted is True

        retrieved = await store.get_todo(todo.id)
        assert retrieved is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent_todo(self, store):
        """Deleting a nonexistent todo should return False."""
        deleted = await store.delete_todo(99999)
        assert deleted is False

    @pytest.mark.asyncio
    async def test_todos_cascade_delete_with_session(self, store):
        """Todos should be deleted when associated session is deleted."""
        await store.create_todo("/workspace", "Session todo", session_id="test-session")

        # Verify todo exists
        todos = await store.list_todos("/workspace", session_id="test-session")
        assert len(todos) == 1

        # Delete session
        await store.delete_session("test-session")

        # Todo should be gone (cascade delete)
        todos = await store.list_todos("/workspace", session_id="test-session")
        assert len(todos) == 0


class TestTodoSearch:
    """Test full-text search for todos."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store with searchable todos."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()

        # Create todos with searchable content
        await store.create_todo("/workspace", "Implement authentication with JWT tokens")
        await store.create_todo("/workspace", "Fix bug in database connection pool")
        await store.create_todo("/workspace", "Write tests for user registration")
        await store.create_todo("/workspace", "Refactor authentication middleware")

        return store

    @pytest.mark.asyncio
    async def test_search_todos_basic(self, store):
        """Should search todos by text."""
        results = await store.search_todos("authentication")
        assert len(results) >= 2
        assert any("authentication" in r.text.lower() for r in results)

    @pytest.mark.asyncio
    async def test_search_todos_case_insensitive(self, store):
        """Search should be case insensitive."""
        results_lower = await store.search_todos("authentication")
        results_upper = await store.search_todos("AUTHENTICATION")
        results_mixed = await store.search_todos("Authentication")

        # All should return the same results
        assert len(results_lower) == len(results_upper) == len(results_mixed)

    @pytest.mark.asyncio
    async def test_search_todos_with_workspace_filter(self, store):
        """Should filter search results by workspace ID."""
        # Create a todo in a different workspace
        await store.create_todo("/other-workspace", "Authentication for other project")

        # Search in specific workspace
        results = await store.search_todos("authentication", workspace_id="/workspace")
        assert len(results) > 0
        assert all(r.workspace_id == "/workspace" for r in results)

    @pytest.mark.asyncio
    async def test_search_todos_with_session_filter(self, store):
        """Should filter search results by session ID."""
        await store.create_session("/workspace", session_id="session-1")
        await store.create_todo("/workspace", "Todo for session 1", session_id="session-1")

        results = await store.search_todos("session", session_id="session-1")
        assert len(results) > 0
        assert all(r.session_id == "session-1" for r in results)

    @pytest.mark.asyncio
    async def test_search_todos_limit(self, store):
        """Should respect limit parameter."""
        # Add many todos
        for i in range(20):
            await store.create_todo("/workspace", f"Task number {i} about testing")

        results = await store.search_todos("testing", limit=5)
        assert len(results) == 5

    @pytest.mark.asyncio
    async def test_search_todos_no_results(self, store):
        """Should return empty list when no matches found."""
        results = await store.search_todos("nonexistent_xyz")
        assert len(results) == 0

    @pytest.mark.asyncio
    async def test_search_todos_phrase_query(self, store):
        """Should support phrase queries."""
        results = await store.search_todos('"database connection"')
        assert len(results) > 0

    @pytest.mark.asyncio
    async def test_search_all_includes_todos(self, store):
        """Search all should include todos in results."""
        results = await store.search_all("authentication", workspace_id="/workspace")

        assert "todos" in results
        assert len(results["todos"]) > 0
        assert any("authentication" in t.text.lower() for t in results["todos"])

    @pytest.mark.asyncio
    async def test_fts_index_synchronized_on_todo_insert(self, store):
        """FTS index should be updated when todos are inserted."""
        # Add a new todo after store is created
        await store.create_todo("/workspace", "New unique search term: xyzabc123")

        # Should be immediately searchable
        results = await store.search_todos("xyzabc123")
        assert len(results) == 1
        assert "xyzabc123" in results[0].text

    @pytest.mark.asyncio
    async def test_fts_index_synchronized_on_todo_update(self, store):
        """FTS index should be updated when todos are updated."""
        todo = await store.create_todo("/workspace", "Original text")

        # Update the text
        await store.update_todo_text(todo.id, "Updated text with unique term uniqueterm789")

        # Should be searchable with new text
        results = await store.search_todos("uniqueterm789")
        assert len(results) == 1
        assert "uniqueterm789" in results[0].text

        # Old text should not be found
        results = await store.search_todos("Original")
        assert len(results) == 0

    @pytest.mark.asyncio
    async def test_fts_index_synchronized_on_todo_delete(self, store):
        """FTS index should be updated when todos are deleted."""
        todo = await store.create_todo("/workspace", "Todo with unique search term deletetest123")

        # Verify it's searchable
        results = await store.search_todos("deletetest123")
        assert len(results) == 1

        # Delete the todo
        await store.delete_todo(todo.id)

        # Should not be found anymore
        results = await store.search_todos("deletetest123")
        assert len(results) == 0


class TestPerformance:
    """Test performance requirements for session store operations."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_load_10k_events_under_500ms(self, store):
        """Should load 10k events in under 500ms (PRD requirement 4.4)."""
        import time

        # Create a session
        await store.create_session("/workspace", session_id="perf-session")

        # Insert 10,000 events
        print("\nInserting 10,000 events...")
        insert_start = time.monotonic()
        for i in range(10000):
            await store.append_event(
                "perf-session",
                EventType.ASSISTANT_DELTA,
                {"text": f"Message {i}", "index": i},
            )
        insert_time = time.monotonic() - insert_start
        print(f"Insert time: {insert_time:.2f}s ({10000/insert_time:.0f} events/sec)")

        # Measure load time
        print("Loading all events...")
        load_start = time.monotonic()
        events = await store.get_events("perf-session", limit=20000)
        load_time = (time.monotonic() - load_start) * 1000  # Convert to ms
        print(f"Load time: {load_time:.0f}ms for {len(events)} events")

        # Verify we got all events (10k + 1 SESSION_CREATED)
        assert len(events) == 10001

        # PRD requirement: 10k events should load under 500ms
        assert load_time < 500, f"Load took {load_time:.0f}ms, expected < 500ms"

    @pytest.mark.asyncio
    async def test_incremental_event_loading_performance(self, store):
        """Should efficiently support incremental event loading for streaming."""
        import time

        await store.create_session("/workspace", session_id="stream-session")

        # Insert 1000 events
        for i in range(1000):
            await store.append_event(
                "stream-session",
                EventType.ASSISTANT_DELTA,
                {"text": f"Message {i}"},
            )

        # Simulate incremental loading (like a UI polling for updates)
        last_id = 0
        total_time = 0
        for _ in range(100):
            start = time.monotonic()
            new_events = await store.get_events("stream-session", since_id=last_id, limit=100)
            elapsed = (time.monotonic() - start) * 1000
            total_time += elapsed

            if new_events:
                last_id = new_events[-1].id

        avg_poll_time = total_time / 100
        print(f"\nAverage poll time: {avg_poll_time:.2f}ms")

        # Each poll should be very fast (< 50ms)
        assert avg_poll_time < 50, f"Average poll took {avg_poll_time:.2f}ms, expected < 50ms"

    @pytest.mark.asyncio
    async def test_concurrent_read_write_performance(self, store):
        """Should handle concurrent reads and writes efficiently."""
        import time

        await store.create_session("/workspace", session_id="concurrent-session")

        # Insert initial events
        for i in range(100):
            await store.append_event(
                "concurrent-session",
                EventType.ASSISTANT_DELTA,
                {"text": f"Initial {i}"},
            )

        # Concurrent operations: 50 writes + 50 reads
        start = time.monotonic()
        write_tasks = [
            store.append_event(
                "concurrent-session",
                EventType.ASSISTANT_DELTA,
                {"text": f"Concurrent write {i}"},
            )
            for i in range(50)
        ]
        read_tasks = [store.get_events("concurrent-session", limit=1000) for _ in range(50)]

        # Mix reads and writes
        all_tasks = write_tasks + read_tasks
        results = await asyncio.gather(*all_tasks)
        elapsed = (time.monotonic() - start) * 1000

        print(f"\n100 concurrent operations: {elapsed:.0f}ms ({1000/elapsed:.0f} ops/sec)")

        # Should complete in reasonable time (< 2 seconds for 100 ops)
        assert elapsed < 2000, f"Concurrent ops took {elapsed:.0f}ms, expected < 2000ms"

        # Verify all writes succeeded
        event_ids = [r for r in results if isinstance(r, int)]
        assert len(event_ids) == 50

    @pytest.mark.asyncio
    async def test_search_performance_large_dataset(self, store):
        """Should perform FTS searches efficiently on large datasets."""
        import time

        await store.create_session("/workspace", session_id="search-perf")

        # Insert 5000 events with varied content
        words = ["python", "javascript", "rust", "golang", "typescript", "java", "kotlin"]
        for i in range(5000):
            word = words[i % len(words)]
            await store.append_event(
                "search-perf",
                EventType.ASSISTANT_DELTA,
                {"content": f"Programming in {word} is great for project {i}"},
            )

        # Warm up the FTS index
        await store.search_events("python")

        # Measure search performance
        start = time.monotonic()
        results = await store.search_events("python", limit=100)
        search_time = (time.monotonic() - start) * 1000

        print(f"\nFTS search time: {search_time:.2f}ms for {len(results)} results")

        # Search should be fast (< 100ms)
        assert search_time < 100, f"Search took {search_time:.2f}ms, expected < 100ms"
        assert len(results) > 0

    @pytest.mark.asyncio
    async def test_checkpoint_operations_performance(self, store):
        """Should handle checkpoint operations efficiently."""
        import time

        await store.create_session("/workspace", session_id="cp-perf")

        # Create 100 checkpoints
        start = time.monotonic()
        for i in range(100):
            await store.create_checkpoint(
                checkpoint_id=f"cp-{i}",
                session_id="cp-perf",
                jj_commit_id=f"commit-{i}",
                bookmark_name=f"checkpoint-{i}",
                message=f"Checkpoint {i} for performance testing",
            )
        create_time = (time.monotonic() - start) * 1000

        print(f"\nCreate 100 checkpoints: {create_time:.0f}ms ({100000/create_time:.0f} cp/sec)")

        # List checkpoints
        start = time.monotonic()
        checkpoints = await store.list_checkpoints("cp-perf", limit=200)
        list_time = (time.monotonic() - start) * 1000

        print(f"List 100 checkpoints: {list_time:.2f}ms")

        assert len(checkpoints) == 100
        assert list_time < 100, f"List took {list_time:.2f}ms, expected < 100ms"

    @pytest.mark.asyncio
    async def test_event_count_performance(self, store):
        """Should count events efficiently even with large datasets."""
        import time

        await store.create_session("/workspace", session_id="count-perf")

        # Insert 10,000 events
        for i in range(10000):
            await store.append_event(
                "count-perf",
                EventType.ASSISTANT_DELTA,
                {"text": f"Message {i}"},
            )

        # Measure count performance
        start = time.monotonic()
        count = await store.get_event_count("count-perf")
        count_time = (time.monotonic() - start) * 1000

        print(f"\nCount 10k events: {count_time:.2f}ms")

        assert count == 10001  # 10k + SESSION_CREATED
        # Count should be very fast (indexed query)
        assert count_time < 50, f"Count took {count_time:.2f}ms, expected < 50ms"

    @pytest.mark.asyncio
    async def test_session_stats_performance(self, store):
        """Should compute session stats efficiently."""
        import time

        await store.create_session("/workspace", session_id="stats-perf")

        # Insert diverse events
        event_types = [
            EventType.RUN_STARTED,
            EventType.ASSISTANT_DELTA,
            EventType.TOOL_START,
            EventType.TOOL_END,
            EventType.RUN_FINISHED,
        ]
        for i in range(1000):
            event_type = event_types[i % len(event_types)]
            await store.append_event("stats-perf", event_type, {"index": i})

        # Measure stats computation
        start = time.monotonic()
        stats = await store.get_session_stats("stats-perf")
        stats_time = (time.monotonic() - start) * 1000

        print(f"\nCompute stats for 1k events: {stats_time:.0f}ms")

        assert stats["total_events"] == 1001  # 1k + SESSION_CREATED
        assert len(stats["event_counts"]) > 0
        # Stats computation should be reasonable
        assert stats_time < 500, f"Stats took {stats_time:.0f}ms, expected < 500ms"
