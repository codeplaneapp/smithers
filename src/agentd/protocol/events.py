"""
Event types for the Agent Runtime Protocol.

All events are serialized as NDJSON and sent to the Swift client.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class EventType(str, Enum):
    """All event types in the protocol."""

    # Daemon lifecycle
    DAEMON_READY = "daemon.ready"
    DAEMON_ERROR = "daemon.error"

    # Session events
    SESSION_CREATED = "session.created"
    SESSION_LIST = "session.list"
    SESSION_CLOSED = "session.closed"

    # Run control
    RUN_STARTED = "run.started"
    RUN_FINISHED = "run.finished"
    RUN_CANCELLED = "run.cancelled"
    RUN_ERROR = "run.error"

    # Messages
    USER_MESSAGE = "user.message"

    # Streaming
    ASSISTANT_DELTA = "assistant.delta"
    ASSISTANT_FINAL = "assistant.final"

    # Tools
    TOOL_START = "tool.start"
    TOOL_OUTPUT_REF = "tool.output_ref"
    TOOL_END = "tool.end"

    # Checkpoints
    CHECKPOINT_CREATED = "checkpoint.created"
    CHECKPOINT_RESTORED = "checkpoint.restored"

    # Stack operations
    STACK_REBASED = "stack.rebased"
    SYNC_STATUS = "sync.status"

    # Subagents
    SUBAGENT_START = "subagent.start"
    SUBAGENT_END = "subagent.end"

    # Skills
    SKILL_START = "skill.start"
    SKILL_RESULT = "skill.result"
    SKILL_END = "skill.end"

    # Forms
    FORM_CREATE = "form.create"
    FORM_SUBMIT = "form.submit"

    # Search
    SEARCH_RESULTS = "search.results"

    # Generic error
    ERROR = "error"


@dataclass
class Event:
    """A protocol event to send to Swift."""

    type: EventType
    data: dict[str, Any] = field(default_factory=lambda: {})
    timestamp: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict[str, Any]:
        """Serialize to JSON-compatible dict."""
        return {
            "type": self.type.value,
            "data": self.data,
            "timestamp": self.timestamp.isoformat(),
        }

    def validate(self) -> None:
        """
        Validate this event against the protocol schema.

        Raises:
            ValidationError: If the event doesn't match the schema
        """
        from agentd.protocol.validation import validate_event

        validate_event(self.to_dict())
