"""Tests for the Event Bus module."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

import pytest

from smithers.events import (
    Event,
    EventBus,
    EventTypes,
    Subscription,
    cache_hit,
    cache_miss,
    get_event_bus,
    llm_call_finished,
    llm_call_started,
    node_failed,
    node_finished,
    node_started,
    reset_event_bus,
    retry_scheduled,
    run_failed,
    run_finished,
    run_started,
    set_event_bus,
    tool_call_finished,
    tool_call_started,
)


class TestEvent:
    """Tests for the Event dataclass."""

    def test_create_basic_event(self) -> None:
        """Test creating a basic event."""
        event = Event(
            type="TestEvent",
            run_id="run-123",
        )
        assert event.type == "TestEvent"
        assert event.run_id == "run-123"
        assert event.node_id is None
        assert event.payload == {}
        assert event.event_id is None
        assert event.ts is not None

    def test_create_event_with_all_fields(self) -> None:
        """Test creating an event with all fields."""
        ts = datetime.now(UTC)
        event = Event(
            type="NodeStarted",
            run_id="run-123",
            node_id="analyze",
            ts=ts,
            payload={"key": "value"},
            event_id=42,
        )
        assert event.type == "NodeStarted"
        assert event.run_id == "run-123"
        assert event.node_id == "analyze"
        assert event.ts == ts
        assert event.payload == {"key": "value"}
        assert event.event_id == 42

    def test_with_payload(self) -> None:
        """Test creating a new event with additional payload."""
        event = Event(
            type="TestEvent",
            run_id="run-123",
            payload={"existing": "value"},
        )
        new_event = event.with_payload(new_key="new_value")

        # Original should be unchanged
        assert event.payload == {"existing": "value"}

        # New event should have combined payload
        assert new_event.payload == {"existing": "value", "new_key": "new_value"}

        # Other fields should be preserved
        assert new_event.type == event.type
        assert new_event.run_id == event.run_id
        assert new_event.ts == event.ts


class TestEventBus:
    """Tests for the EventBus class."""

    @pytest.fixture
    def bus(self) -> EventBus:
        """Create a fresh event bus for each test."""
        return EventBus()

    @pytest.mark.asyncio
    async def test_subscribe_and_emit(self, bus: EventBus) -> None:
        """Test basic subscribe and emit."""
        received: list[Event] = []

        def handler(event: Event) -> None:
            received.append(event)

        bus.subscribe("TestEvent", handler)

        event = Event(type="TestEvent", run_id="run-123")
        await bus.emit(event)

        assert len(received) == 1
        assert received[0] is event

    @pytest.mark.asyncio
    async def test_subscribe_all(self, bus: EventBus) -> None:
        """Test subscribing to all events."""
        received: list[Event] = []

        def handler(event: Event) -> None:
            received.append(event)

        bus.subscribe_all(handler)

        event1 = Event(type="EventA", run_id="run-123")
        event2 = Event(type="EventB", run_id="run-123")
        await bus.emit(event1)
        await bus.emit(event2)

        assert len(received) == 2
        assert received[0] is event1
        assert received[1] is event2

    @pytest.mark.asyncio
    async def test_type_filtering(self, bus: EventBus) -> None:
        """Test that handlers only receive events of subscribed type."""
        received_a: list[Event] = []
        received_b: list[Event] = []

        bus.subscribe("EventA", lambda e: received_a.append(e))
        bus.subscribe("EventB", lambda e: received_b.append(e))

        event_a = Event(type="EventA", run_id="run-123")
        event_b = Event(type="EventB", run_id="run-123")
        event_c = Event(type="EventC", run_id="run-123")

        await bus.emit(event_a)
        await bus.emit(event_b)
        await bus.emit(event_c)

        assert len(received_a) == 1
        assert received_a[0] is event_a
        assert len(received_b) == 1
        assert received_b[0] is event_b

    @pytest.mark.asyncio
    async def test_async_handler(self, bus: EventBus) -> None:
        """Test async event handlers."""
        received: list[Event] = []

        async def async_handler(event: Event) -> None:
            await asyncio.sleep(0.001)
            received.append(event)

        bus.subscribe("TestEvent", async_handler)

        event = Event(type="TestEvent", run_id="run-123")
        await bus.emit(event)

        assert len(received) == 1
        assert received[0] is event

    @pytest.mark.asyncio
    async def test_multiple_handlers_same_type(self, bus: EventBus) -> None:
        """Test multiple handlers for the same event type."""
        received_1: list[Event] = []
        received_2: list[Event] = []

        bus.subscribe("TestEvent", lambda e: received_1.append(e))
        bus.subscribe("TestEvent", lambda e: received_2.append(e))

        event = Event(type="TestEvent", run_id="run-123")
        await bus.emit(event)

        assert len(received_1) == 1
        assert len(received_2) == 1

    @pytest.mark.asyncio
    async def test_unsubscribe(self, bus: EventBus) -> None:
        """Test unsubscribing a handler."""
        received: list[Event] = []

        sub = bus.subscribe("TestEvent", lambda e: received.append(e))

        event1 = Event(type="TestEvent", run_id="run-123")
        await bus.emit(event1)
        assert len(received) == 1

        # Unsubscribe and emit again
        result = bus.unsubscribe(sub)
        assert result is True

        event2 = Event(type="TestEvent", run_id="run-456")
        await bus.emit(event2)
        assert len(received) == 1  # Still just one event

    def test_unsubscribe_via_subscription(self, bus: EventBus) -> None:
        """Test unsubscribing via the Subscription object."""
        sub = bus.subscribe("TestEvent", lambda e: None)
        assert bus.subscriber_count("TestEvent") == 1

        sub.unsubscribe()
        assert bus.subscriber_count("TestEvent") == 0

    @pytest.mark.asyncio
    async def test_unsubscribe_all_handler(self, bus: EventBus) -> None:
        """Test unsubscribing an all-events handler."""
        received: list[Event] = []
        sub = bus.subscribe_all(lambda e: received.append(e))

        event1 = Event(type="TestEvent", run_id="run-123")
        await bus.emit(event1)
        assert len(received) == 1

        sub.unsubscribe()

        event2 = Event(type="TestEvent", run_id="run-456")
        await bus.emit(event2)
        assert len(received) == 1

    def test_unsubscribe_nonexistent(self, bus: EventBus) -> None:
        """Test unsubscribing a non-existent subscription."""
        other_bus = EventBus()
        sub = other_bus.subscribe("TestEvent", lambda e: None)

        result = bus.unsubscribe(sub)
        assert result is False

    def test_unsubscribe_all(self, bus: EventBus) -> None:
        """Test removing all subscriptions."""
        bus.subscribe("EventA", lambda e: None)
        bus.subscribe("EventB", lambda e: None)
        bus.subscribe_all(lambda e: None)

        assert bus.subscriber_count() == 3

        count = bus.unsubscribe_all()
        assert count == 3
        assert bus.subscriber_count() == 0

    @pytest.mark.asyncio
    async def test_handler_error_isolation(self, bus: EventBus) -> None:
        """Test that handler errors don't affect other handlers."""
        received: list[Event] = []

        def bad_handler(event: Event) -> None:
            raise ValueError("Intentional error")

        def good_handler(event: Event) -> None:
            received.append(event)

        bus.subscribe("TestEvent", bad_handler)
        bus.subscribe("TestEvent", good_handler)

        event = Event(type="TestEvent", run_id="run-123")
        await bus.emit(event)  # Should not raise

        assert len(received) == 1

    @pytest.mark.asyncio
    async def test_pause_and_resume(self, bus: EventBus) -> None:
        """Test pausing and resuming event delivery."""
        received: list[Event] = []
        bus.subscribe("TestEvent", lambda e: received.append(e))

        bus.pause()
        assert bus.is_paused() is True

        # Events should be queued
        event1 = Event(type="TestEvent", run_id="run-123")
        event2 = Event(type="TestEvent", run_id="run-456")
        await bus.emit(event1)
        await bus.emit(event2)

        assert len(received) == 0
        assert bus.queued_count() == 2

        # Resume should deliver queued events
        count = await bus.resume()
        assert count == 2
        assert len(received) == 2
        assert bus.is_paused() is False
        assert bus.queued_count() == 0

    def test_subscriber_count(self, bus: EventBus) -> None:
        """Test counting subscribers."""
        assert bus.subscriber_count() == 0
        assert bus.subscriber_count("TestEvent") == 0

        bus.subscribe("TestEvent", lambda e: None)
        bus.subscribe("TestEvent", lambda e: None)
        bus.subscribe("OtherEvent", lambda e: None)
        bus.subscribe_all(lambda e: None)

        assert bus.subscriber_count("TestEvent") == 2
        assert bus.subscriber_count("OtherEvent") == 1
        assert bus.subscriber_count("NonExistent") == 0
        assert bus.subscriber_count() == 4

    def test_emit_sync(self, bus: EventBus) -> None:
        """Test synchronous emit (queues when no loop running)."""
        event = Event(type="TestEvent", run_id="run-123")

        # Should not raise when no loop is running
        bus.emit_sync(event)

        # Event should be queued
        assert bus.queued_count() == 1

    @pytest.mark.asyncio
    async def test_emit_sync_with_loop(self, bus: EventBus) -> None:
        """Test synchronous emit with running loop."""
        received: list[Event] = []
        bus.subscribe("TestEvent", lambda e: received.append(e))

        event = Event(type="TestEvent", run_id="run-123")
        bus.emit_sync(event)

        # Give the event loop a chance to process
        await asyncio.sleep(0.01)

        assert len(received) == 1


class TestSubscription:
    """Tests for the Subscription class."""

    def test_subscription_fields(self) -> None:
        """Test subscription has expected fields."""
        bus = EventBus()
        sub = bus.subscribe("TestEvent", lambda e: None)

        assert isinstance(sub, Subscription)
        assert sub.id is not None
        assert sub.event_type == "TestEvent"
        assert sub.handler is not None
        assert sub.bus is bus

    def test_all_subscription_type(self) -> None:
        """Test that all-events subscriptions have None event_type."""
        bus = EventBus()
        sub = bus.subscribe_all(lambda e: None)

        assert sub.event_type is None


class TestGlobalEventBus:
    """Tests for global event bus management."""

    def test_get_event_bus(self) -> None:
        """Test getting the global event bus."""
        reset_event_bus()
        bus = get_event_bus()
        assert isinstance(bus, EventBus)

        # Should return the same instance
        bus2 = get_event_bus()
        assert bus2 is bus

    def test_set_event_bus(self) -> None:
        """Test setting a custom event bus."""
        reset_event_bus()
        original = get_event_bus()

        custom = EventBus()
        previous = set_event_bus(custom)

        assert previous is original
        assert get_event_bus() is custom

        # Reset to None
        set_event_bus(None)
        new_bus = get_event_bus()
        assert new_bus is not custom

    def test_reset_event_bus(self) -> None:
        """Test resetting the global event bus."""
        bus1 = get_event_bus()
        bus1.subscribe("TestEvent", lambda e: None)
        assert bus1.subscriber_count() > 0

        reset_event_bus()
        bus2 = get_event_bus()

        assert bus2 is not bus1
        assert bus2.subscriber_count() == 0


class TestEventTypes:
    """Tests for EventTypes constants."""

    def test_event_types_exist(self) -> None:
        """Test that common event types are defined."""
        assert EventTypes.RUN_CREATED == "RunCreated"
        assert EventTypes.RUN_STARTED == "RunStarted"
        assert EventTypes.RUN_FINISHED == "RunFinished"
        assert EventTypes.RUN_FAILED == "RunFailed"
        assert EventTypes.NODE_STARTED == "NodeStarted"
        assert EventTypes.NODE_FINISHED == "NodeFinished"
        assert EventTypes.NODE_FAILED == "NodeFailed"
        assert EventTypes.CACHE_HIT == "CacheHit"
        assert EventTypes.CACHE_MISS == "CacheMiss"
        assert EventTypes.LLM_CALL_STARTED == "LLMCallStarted"
        assert EventTypes.LLM_CALL_FINISHED == "LLMCallFinished"
        assert EventTypes.TOOL_CALL_STARTED == "ToolCallStarted"
        assert EventTypes.TOOL_CALL_FINISHED == "ToolCallFinished"


class TestEventFactories:
    """Tests for event factory functions."""

    def test_run_started(self) -> None:
        """Test run_started factory."""
        event = run_started("run-123", "deploy", 5)
        assert event.type == EventTypes.RUN_STARTED
        assert event.run_id == "run-123"
        assert event.payload["target"] == "deploy"
        assert event.payload["node_count"] == 5

    def test_run_finished(self) -> None:
        """Test run_finished factory."""
        event = run_finished("run-123", "SUCCESS", duration_ms=1500.5)
        assert event.type == EventTypes.RUN_FINISHED
        assert event.run_id == "run-123"
        assert event.payload["status"] == "SUCCESS"
        assert event.payload["duration_ms"] == 1500.5

    def test_run_finished_without_duration(self) -> None:
        """Test run_finished without duration."""
        event = run_finished("run-123", "FAILED")
        assert event.type == EventTypes.RUN_FINISHED
        assert "duration_ms" not in event.payload

    def test_run_failed(self) -> None:
        """Test run_failed factory."""
        event = run_failed("run-123", "Network error", node_id="analyze")
        assert event.type == EventTypes.RUN_FAILED
        assert event.run_id == "run-123"
        assert event.node_id == "analyze"
        assert event.payload["error"] == "Network error"

    def test_node_started(self) -> None:
        """Test node_started factory."""
        event = node_started("run-123", "analyze", workflow_name="my_workflow")
        assert event.type == EventTypes.NODE_STARTED
        assert event.run_id == "run-123"
        assert event.node_id == "analyze"
        assert event.payload["workflow"] == "my_workflow"

    def test_node_finished(self) -> None:
        """Test node_finished factory."""
        event = node_finished("run-123", "analyze", duration_ms=500.0, cached=True)
        assert event.type == EventTypes.NODE_FINISHED
        assert event.node_id == "analyze"
        assert event.payload["duration_ms"] == 500.0
        assert event.payload["cached"] is True

    def test_node_failed(self) -> None:
        """Test node_failed factory."""
        event = node_failed("run-123", "analyze", "Validation error")
        assert event.type == EventTypes.NODE_FAILED
        assert event.node_id == "analyze"
        assert event.payload["error"] == "Validation error"

    def test_cache_hit(self) -> None:
        """Test cache_hit factory."""
        event = cache_hit("run-123", "analyze", "cache-key-abc")
        assert event.type == EventTypes.CACHE_HIT
        assert event.payload["cache_key"] == "cache-key-abc"

    def test_cache_miss(self) -> None:
        """Test cache_miss factory."""
        event = cache_miss("run-123", "analyze", "cache-key-abc")
        assert event.type == EventTypes.CACHE_MISS
        assert event.payload["cache_key"] == "cache-key-abc"

    def test_llm_call_started(self) -> None:
        """Test llm_call_started factory."""
        event = llm_call_started("run-123", "analyze", "claude-3", call_id=42)
        assert event.type == EventTypes.LLM_CALL_STARTED
        assert event.payload["model"] == "claude-3"
        assert event.payload["call_id"] == 42

    def test_llm_call_finished(self) -> None:
        """Test llm_call_finished factory."""
        event = llm_call_finished(
            "run-123",
            "analyze",
            "claude-3",
            input_tokens=100,
            output_tokens=50,
            cost_usd=0.01,
            call_id=42,
        )
        assert event.type == EventTypes.LLM_CALL_FINISHED
        assert event.payload["model"] == "claude-3"
        assert event.payload["input_tokens"] == 100
        assert event.payload["output_tokens"] == 50
        assert event.payload["cost_usd"] == 0.01
        assert event.payload["call_id"] == 42

    def test_tool_call_started(self) -> None:
        """Test tool_call_started factory."""
        event = tool_call_started("run-123", "analyze", "Read", tool_call_id=10)
        assert event.type == EventTypes.TOOL_CALL_STARTED
        assert event.payload["tool"] == "Read"
        assert event.payload["tool_call_id"] == 10

    def test_tool_call_finished(self) -> None:
        """Test tool_call_finished factory."""
        event = tool_call_finished(
            "run-123", "analyze", "Read", "SUCCESS", tool_call_id=10
        )
        assert event.type == EventTypes.TOOL_CALL_FINISHED
        assert event.payload["tool"] == "Read"
        assert event.payload["status"] == "SUCCESS"
        assert event.payload["tool_call_id"] == 10

    def test_retry_scheduled(self) -> None:
        """Test retry_scheduled factory."""
        event = retry_scheduled("run-123", "analyze", 2, 5.0, "Rate limit")
        assert event.type == EventTypes.RETRY_SCHEDULED
        assert event.payload["attempt"] == 2
        assert event.payload["delay_seconds"] == 5.0
        assert event.payload["error"] == "Rate limit"


class TestEventBusIntegration:
    """Integration tests for the EventBus."""

    @pytest.mark.asyncio
    async def test_full_workflow_events(self) -> None:
        """Test emitting a full workflow's worth of events."""
        bus = EventBus()
        events_received: list[Event] = []
        bus.subscribe_all(lambda e: events_received.append(e))

        # Simulate a workflow run
        await bus.emit(run_started("run-123", "deploy", 3))
        await bus.emit(node_started("run-123", "analyze"))
        await bus.emit(cache_miss("run-123", "analyze", "key-1"))
        await bus.emit(llm_call_started("run-123", "analyze", "claude-3"))
        await bus.emit(llm_call_finished("run-123", "analyze", "claude-3", 100, 50))
        await bus.emit(node_finished("run-123", "analyze", 500.0))
        await bus.emit(node_started("run-123", "implement"))
        await bus.emit(cache_hit("run-123", "implement", "key-2"))
        await bus.emit(node_finished("run-123", "implement", cached=True))
        await bus.emit(run_finished("run-123", "SUCCESS", 1500.0))

        assert len(events_received) == 10
        assert events_received[0].type == EventTypes.RUN_STARTED
        assert events_received[-1].type == EventTypes.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_filtered_subscriptions(self) -> None:
        """Test filtering events by type."""
        bus = EventBus()
        llm_events: list[Event] = []
        node_events: list[Event] = []

        bus.subscribe(EventTypes.LLM_CALL_STARTED, lambda e: llm_events.append(e))
        bus.subscribe(EventTypes.LLM_CALL_FINISHED, lambda e: llm_events.append(e))
        bus.subscribe(EventTypes.NODE_STARTED, lambda e: node_events.append(e))
        bus.subscribe(EventTypes.NODE_FINISHED, lambda e: node_events.append(e))

        await bus.emit(node_started("run-123", "analyze"))
        await bus.emit(llm_call_started("run-123", "analyze", "claude-3"))
        await bus.emit(llm_call_finished("run-123", "analyze", "claude-3"))
        await bus.emit(node_finished("run-123", "analyze"))
        await bus.emit(run_finished("run-123", "SUCCESS"))

        assert len(llm_events) == 2
        assert len(node_events) == 2

    @pytest.mark.asyncio
    async def test_concurrent_handlers(self) -> None:
        """Test that multiple async handlers run concurrently."""
        bus = EventBus()
        results: list[str] = []

        async def slow_handler(event: Event) -> None:
            await asyncio.sleep(0.05)
            results.append("slow")

        async def fast_handler(event: Event) -> None:
            results.append("fast")

        bus.subscribe("Test", slow_handler)
        bus.subscribe("Test", fast_handler)

        await bus.emit(Event(type="Test", run_id="run-123"))

        # Both handlers should complete
        assert "slow" in results
        assert "fast" in results
