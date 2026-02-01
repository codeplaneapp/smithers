"""
Integration tests for Swift <-> Python bridge via AgentDaemon.

These tests verify that the daemon properly receives requests and emits events
that Swift can consume to update the UI.
"""

import pytest


@pytest.mark.asyncio
async def test_swift_ui_can_connect_to_session_manager(tmp_path):
    """Test that Swift UI workflow of connecting to SessionManager works.

    This verifies:
    1. SessionManager can be created
    2. Sessions can be created
    3. Messages can be sent
    4. Events are emitted and captured
    """
    from agentd.adapters.fake import FakeAgentAdapter
    from agentd.protocol.events import EventType
    from agentd.session import SessionManager
    from agentd.store.sqlite import SessionStore

    # Create a session manager (simulating what Swift does)
    store = SessionStore(str(tmp_path / "test.db"))
    await store.initialize()

    adapter = FakeAgentAdapter()
    manager = SessionManager(adapter=adapter, store=store)

    # Create a session
    session = await manager.create_session("/tmp/test_workspace")
    assert session.id is not None

    # Track events
    events = []

    def capture_event(event):
        events.append(event)

    # Send a message (simulating user input from Swift UI)
    await manager.send_message(session.id, "Hello, agent!", emit=capture_event)

    # Verify events were emitted in correct order
    event_types = [e.type for e in events]
    assert EventType.RUN_STARTED in event_types
    assert EventType.USER_MESSAGE in event_types
    assert EventType.ASSISTANT_DELTA in event_types
    assert EventType.ASSISTANT_FINAL in event_types
    assert EventType.RUN_FINISHED in event_types

    # Verify user message content
    user_message = next(e for e in events if e.type == EventType.USER_MESSAGE)
    assert user_message.data["content"] == "Hello, agent!"

    # Verify assistant response was generated
    deltas = [e for e in events if e.type == EventType.ASSISTANT_DELTA]
    assert len(deltas) > 0

    # Verify session message history was updated
    assert len(session.message_history) == 2
    assert session.message_history[0]["role"] == "user"
    assert session.message_history[0]["content"] == "Hello, agent!"
    assert session.message_history[1]["role"] == "assistant"


@pytest.mark.asyncio
async def test_events_are_persisted_to_store(tmp_path):
    """Test that events are persisted to SQLite store for Swift to load."""
    from agentd.adapters.fake import FakeAgentAdapter
    from agentd.protocol.events import EventType
    from agentd.session import SessionManager
    from agentd.store.sqlite import SessionStore

    # Create a session manager with store
    store = SessionStore(str(tmp_path / "test.db"))
    await store.initialize()

    adapter = FakeAgentAdapter()
    manager = SessionManager(adapter=adapter, store=store)

    # Create a session
    session = await manager.create_session("/tmp/test_workspace")

    # Send a message
    await manager.send_message(session.id, "Test message")

    # Wait a moment for background persistence
    import asyncio

    await asyncio.sleep(0.1)

    # Verify events were persisted
    events = await store.get_events(session.id, limit=100)
    assert len(events) > 0

    # Verify event types
    event_types = [e.type for e in events]
    assert EventType.RUN_STARTED.value in event_types
    assert EventType.USER_MESSAGE.value in event_types

    # Verify session can be loaded
    sessions = await store.list_sessions()
    assert len(sessions) == 1
    assert sessions[0].id == session.id
