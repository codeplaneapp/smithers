#!/bin/bash
# Smithers v2 Implementation Scaffold Script
# This script creates the foundational structure for the v2 implementation
# as specified in prd/smithers-v2-task-guide.md

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "==================================================================="
echo "Smithers v2 Scaffold - Creating foundational components"
echo "==================================================================="
echo ""
echo "Project root: $PROJECT_ROOT"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# =============================================================================
# SLICE 0: Python agentd daemon skeleton
# =============================================================================

log_step "Creating Python agentd package structure..."

mkdir -p "$PROJECT_ROOT/src/agentd"
mkdir -p "$PROJECT_ROOT/src/agentd/protocol"
mkdir -p "$PROJECT_ROOT/src/agentd/adapters"
mkdir -p "$PROJECT_ROOT/src/agentd/tools"
mkdir -p "$PROJECT_ROOT/src/agentd/sandbox"

# agentd/__init__.py
cat > "$PROJECT_ROOT/src/agentd/__init__.py" << 'EOF'
"""
agentd: The Smithers Agent Daemon

A long-running daemon that handles agent runtime protocol,
session management, and tool execution.
"""

__version__ = "0.1.0"

from agentd.daemon import AgentDaemon
from agentd.session import Session, SessionManager
from agentd.protocol.events import Event, EventType

__all__ = [
    "AgentDaemon",
    "Session",
    "SessionManager",
    "Event",
    "EventType",
]
EOF

# agentd/daemon.py - Main daemon entry point
cat > "$PROJECT_ROOT/src/agentd/daemon.py" << 'EOF'
"""
AgentDaemon: Long-running process handling Swift <-> Python communication.

Implements the Agent Runtime Protocol over NDJSON.
"""

import asyncio
import json
import sys
from typing import Optional, TextIO
from dataclasses import dataclass

from agentd.session import SessionManager
from agentd.protocol.events import Event, EventType
from agentd.protocol.requests import Request, parse_request


@dataclass
class DaemonConfig:
    """Configuration for the agent daemon."""
    workspace_root: str
    sandbox_mode: str = "host"  # "host" | "linux_vm"
    agent_backend: str = "anthropic"  # "fake" | "anthropic"


class AgentDaemon:
    """
    Long-running daemon that:
    - Reads NDJSON requests from stdin (or socket)
    - Emits NDJSON events to stdout
    - Manages multiple sessions
    - Handles crash recovery
    """

    def __init__(
        self,
        config: DaemonConfig,
        input_stream: TextIO = sys.stdin,
        output_stream: TextIO = sys.stdout,
    ):
        self.config = config
        self.input_stream = input_stream
        self.output_stream = output_stream
        self.session_manager = SessionManager(config)
        self._running = False

    def emit_event(self, event: Event) -> None:
        """Send an event to the Swift client."""
        line = json.dumps(event.to_dict()) + "\n"
        self.output_stream.write(line)
        self.output_stream.flush()

    async def handle_request(self, request: Request) -> None:
        """Process an incoming request and emit appropriate events."""
        match request.method:
            case "session.create":
                session = await self.session_manager.create_session(
                    request.params.get("workspace_root", self.config.workspace_root)
                )
                self.emit_event(Event(
                    type=EventType.SESSION_CREATED,
                    data={"session_id": session.id}
                ))

            case "session.send":
                session_id = request.params["session_id"]
                message = request.params["message"]
                surfaces = request.params.get("surfaces", [])
                await self.session_manager.send_message(
                    session_id, message, surfaces, self.emit_event
                )

            case "run.cancel":
                run_id = request.params["run_id"]
                await self.session_manager.cancel_run(run_id)
                self.emit_event(Event(
                    type=EventType.RUN_CANCELLED,
                    data={"run_id": run_id}
                ))

            case _:
                self.emit_event(Event(
                    type=EventType.ERROR,
                    data={"message": f"Unknown method: {request.method}"}
                ))

    async def run(self) -> None:
        """Main event loop."""
        self._running = True
        self.emit_event(Event(
            type=EventType.DAEMON_READY,
            data={"version": "0.1.0", "config": {
                "sandbox_mode": self.config.sandbox_mode,
                "agent_backend": self.config.agent_backend,
            }}
        ))

        while self._running:
            try:
                line = await asyncio.get_event_loop().run_in_executor(
                    None, self.input_stream.readline
                )
                if not line:
                    break

                request = parse_request(line.strip())
                await self.handle_request(request)

            except json.JSONDecodeError as e:
                self.emit_event(Event(
                    type=EventType.ERROR,
                    data={"message": f"Invalid JSON: {e}"}
                ))
            except Exception as e:
                self.emit_event(Event(
                    type=EventType.ERROR,
                    data={"message": str(e)}
                ))

    def stop(self) -> None:
        """Stop the daemon gracefully."""
        self._running = False


def main() -> None:
    """Entry point for agentd."""
    import argparse

    parser = argparse.ArgumentParser(description="Smithers Agent Daemon")
    parser.add_argument("--workspace", required=True, help="Workspace root path")
    parser.add_argument("--sandbox", default="host", choices=["host", "linux_vm"])
    parser.add_argument("--backend", default="anthropic", choices=["fake", "anthropic"])
    args = parser.parse_args()

    config = DaemonConfig(
        workspace_root=args.workspace,
        sandbox_mode=args.sandbox,
        agent_backend=args.backend,
    )
    daemon = AgentDaemon(config)
    asyncio.run(daemon.run())


if __name__ == "__main__":
    main()
EOF

# agentd/session.py - Session management
cat > "$PROJECT_ROOT/src/agentd/session.py" << 'EOF'
"""
Session and SessionManager for agentd.

Each session represents an agent conversation with its own
graph state, checkpoints, and tool execution context.
"""

import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional
from datetime import datetime

from agentd.protocol.events import Event, EventType


@dataclass
class Session:
    """An agent session with its state."""
    id: str
    workspace_root: str
    created_at: datetime = field(default_factory=datetime.now)
    current_run_id: Optional[str] = None

    @classmethod
    def create(cls, workspace_root: str) -> "Session":
        return cls(
            id=str(uuid.uuid4()),
            workspace_root=workspace_root,
        )


class SessionManager:
    """Manages multiple concurrent sessions."""

    def __init__(self, config):
        self.config = config
        self.sessions: dict[str, Session] = {}
        self._adapter = None  # Will be set based on config

    async def create_session(self, workspace_root: str) -> Session:
        """Create a new session."""
        session = Session.create(workspace_root)
        self.sessions[session.id] = session
        return session

    async def send_message(
        self,
        session_id: str,
        message: str,
        surfaces: list,
        emit: Callable[[Event], None],
    ) -> None:
        """Send a user message to start/continue a run."""
        session = self.sessions.get(session_id)
        if not session:
            emit(Event(
                type=EventType.ERROR,
                data={"message": f"Session not found: {session_id}"}
            ))
            return

        run_id = str(uuid.uuid4())
        session.current_run_id = run_id

        emit(Event(
            type=EventType.RUN_STARTED,
            data={"run_id": run_id, "session_id": session_id}
        ))

        # TODO: Actually run the agent
        # For now, emit a fake response
        await self._run_agent(session, message, surfaces, emit)

        emit(Event(
            type=EventType.RUN_FINISHED,
            data={"run_id": run_id, "session_id": session_id}
        ))

    async def _run_agent(
        self,
        session: Session,
        message: str,
        surfaces: list,
        emit: Callable[[Event], None],
    ) -> None:
        """Run the agent (will be implemented by adapters)."""
        # Placeholder: emit streaming response
        import asyncio

        emit(Event(
            type=EventType.ASSISTANT_DELTA,
            data={"text": "I'm analyzing your request"}
        ))
        await asyncio.sleep(0.1)

        emit(Event(
            type=EventType.ASSISTANT_DELTA,
            data={"text": "..."}
        ))
        await asyncio.sleep(0.1)

        emit(Event(
            type=EventType.ASSISTANT_FINAL,
            data={"message_id": str(uuid.uuid4())}
        ))

    async def cancel_run(self, run_id: str) -> None:
        """Cancel a running agent."""
        for session in self.sessions.values():
            if session.current_run_id == run_id:
                session.current_run_id = None
                break
EOF

# agentd/protocol/__init__.py
cat > "$PROJECT_ROOT/src/agentd/protocol/__init__.py" << 'EOF'
"""
Agent Runtime Protocol definitions.

This module defines the NDJSON protocol between Swift and Python.
"""

from agentd.protocol.events import Event, EventType
from agentd.protocol.requests import Request, parse_request

__all__ = ["Event", "EventType", "Request", "parse_request"]
EOF

# agentd/protocol/events.py - Event definitions
cat > "$PROJECT_ROOT/src/agentd/protocol/events.py" << 'EOF'
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
    SESSION_CLOSED = "session.closed"

    # Run control
    RUN_STARTED = "run.started"
    RUN_FINISHED = "run.finished"
    RUN_CANCELLED = "run.cancelled"
    RUN_ERROR = "run.error"

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

    # Generic error
    ERROR = "error"


@dataclass
class Event:
    """A protocol event to send to Swift."""
    type: EventType
    data: dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict[str, Any]:
        """Serialize to JSON-compatible dict."""
        return {
            "type": self.type.value,
            "data": self.data,
            "timestamp": self.timestamp.isoformat(),
        }
EOF

# agentd/protocol/requests.py - Request parsing
cat > "$PROJECT_ROOT/src/agentd/protocol/requests.py" << 'EOF'
"""
Request parsing for the Agent Runtime Protocol.

Requests come from Swift as NDJSON lines.
"""

import json
from dataclasses import dataclass
from typing import Any


@dataclass
class Request:
    """A protocol request from Swift."""
    id: str
    method: str
    params: dict[str, Any]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Request":
        return cls(
            id=data.get("id", ""),
            method=data["method"],
            params=data.get("params", {}),
        )


def parse_request(line: str) -> Request:
    """Parse an NDJSON line into a Request."""
    data = json.loads(line)
    return Request.from_dict(data)
EOF

# agentd/adapters/__init__.py
cat > "$PROJECT_ROOT/src/agentd/adapters/__init__.py" << 'EOF'
"""
Agent adapters - pluggable backends for agent execution.

Supports:
- FakeAgentAdapter: Deterministic testing
- AnthropicAgentAdapter: Raw Anthropic API
"""

from agentd.adapters.base import AgentAdapter
from agentd.adapters.fake import FakeAgentAdapter
from agentd.adapters.anthropic import AnthropicAgentAdapter

__all__ = ["AgentAdapter", "FakeAgentAdapter", "AnthropicAgentAdapter"]
EOF

# agentd/adapters/base.py
cat > "$PROJECT_ROOT/src/agentd/adapters/base.py" << 'EOF'
"""Base class for agent adapters."""

from abc import ABC, abstractmethod
from typing import AsyncIterator, Callable

from agentd.protocol.events import Event


class AgentAdapter(ABC):
    """
    Abstract base for agent backends.

    All adapters must translate their native events into
    our internal Event types.
    """

    @abstractmethod
    async def run(
        self,
        messages: list[dict],
        tools: list[dict],
        emit: Callable[[Event], None],
    ) -> AsyncIterator[Event]:
        """
        Run the agent with given messages and tools.

        Yields events as they occur.
        """
        pass

    @abstractmethod
    async def cancel(self) -> None:
        """Cancel the current run."""
        pass
EOF

# agentd/adapters/fake.py
cat > "$PROJECT_ROOT/src/agentd/adapters/fake.py" << 'EOF'
"""Fake agent adapter for deterministic testing."""

import asyncio
from typing import AsyncIterator, Callable

from agentd.adapters.base import AgentAdapter
from agentd.protocol.events import Event, EventType


class FakeAgentAdapter(AgentAdapter):
    """
    Fake adapter that returns scripted responses.

    Used for:
    - UI development without API costs
    - Integration tests
    - Golden event log fixtures
    """

    def __init__(self, script: list[dict] | None = None):
        self.script = script or self._default_script()
        self._cancelled = False

    def _default_script(self) -> list[dict]:
        """Default script for demo purposes."""
        return [
            {"type": "assistant.delta", "text": "I'll help you with that. "},
            {"type": "assistant.delta", "text": "Let me analyze the code..."},
            {"type": "tool.start", "tool_use_id": "t1", "name": "Read", "input": {"path": "/src/main.py"}},
            {"type": "tool.end", "tool_use_id": "t1", "status": "success"},
            {"type": "assistant.delta", "text": "\n\nI found the issue."},
            {"type": "assistant.final", "message_id": "m1"},
        ]

    async def run(
        self,
        messages: list[dict],
        tools: list[dict],
        emit: Callable[[Event], None],
    ) -> AsyncIterator[Event]:
        """Execute the scripted response."""
        self._cancelled = False

        for item in self.script:
            if self._cancelled:
                break

            event_type = EventType(item["type"])
            data = {k: v for k, v in item.items() if k != "type"}
            event = Event(type=event_type, data=data)

            emit(event)
            yield event

            # Simulate realistic timing
            await asyncio.sleep(0.05)

    async def cancel(self) -> None:
        """Cancel the scripted run."""
        self._cancelled = True
EOF

# agentd/adapters/anthropic.py
cat > "$PROJECT_ROOT/src/agentd/adapters/anthropic.py" << 'EOF'
"""Anthropic API adapter using raw anthropic client."""

import os
from typing import AsyncIterator, Callable

from agentd.adapters.base import AgentAdapter
from agentd.protocol.events import Event, EventType

try:
    import anthropic
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False


class AnthropicAgentAdapter(AgentAdapter):
    """
    Adapter using the raw Anthropic API client.

    Translates Anthropic stream events into our internal Event types.
    """

    def __init__(self, model: str = "claude-sonnet-4-20250514"):
        if not HAS_ANTHROPIC:
            raise ImportError("anthropic package not installed")

        self.model = model
        self.client = anthropic.AsyncAnthropic()
        self._current_stream = None

    async def run(
        self,
        messages: list[dict],
        tools: list[dict],
        emit: Callable[[Event], None],
    ) -> AsyncIterator[Event]:
        """Run the agent using Anthropic streaming API."""

        # Convert tools to Anthropic format
        anthropic_tools = self._convert_tools(tools)

        async with self.client.messages.stream(
            model=self.model,
            max_tokens=8192,
            messages=messages,
            tools=anthropic_tools if anthropic_tools else anthropic.NOT_GIVEN,
        ) as stream:
            self._current_stream = stream

            current_tool_use = None

            async for event in stream:
                match event.type:
                    case "content_block_start":
                        if hasattr(event.content_block, "type"):
                            if event.content_block.type == "tool_use":
                                current_tool_use = event.content_block
                                ev = Event(
                                    type=EventType.TOOL_START,
                                    data={
                                        "tool_use_id": current_tool_use.id,
                                        "name": current_tool_use.name,
                                        "input": {},
                                    }
                                )
                                emit(ev)
                                yield ev

                    case "content_block_delta":
                        if hasattr(event.delta, "text"):
                            ev = Event(
                                type=EventType.ASSISTANT_DELTA,
                                data={"text": event.delta.text}
                            )
                            emit(ev)
                            yield ev

                    case "content_block_stop":
                        if current_tool_use:
                            ev = Event(
                                type=EventType.TOOL_END,
                                data={
                                    "tool_use_id": current_tool_use.id,
                                    "status": "success"
                                }
                            )
                            emit(ev)
                            yield ev
                            current_tool_use = None

                    case "message_stop":
                        ev = Event(
                            type=EventType.ASSISTANT_FINAL,
                            data={"message_id": stream.current_message_snapshot.id}
                        )
                        emit(ev)
                        yield ev

    async def cancel(self) -> None:
        """Cancel the current stream."""
        if self._current_stream:
            # Anthropic doesn't have explicit cancel, but we can stop iteration
            self._current_stream = None

    def _convert_tools(self, tools: list[dict]) -> list[dict]:
        """Convert internal tool format to Anthropic format."""
        return [
            {
                "name": t["name"],
                "description": t.get("description", ""),
                "input_schema": t.get("input_schema", {"type": "object", "properties": {}}),
            }
            for t in tools
        ]
EOF

# agentd/sandbox/__init__.py
cat > "$PROJECT_ROOT/src/agentd/sandbox/__init__.py" << 'EOF'
"""
Sandbox runtime abstraction.

Provides:
- HostRuntime: MVP, workspace-constrained host execution
- LinuxVMRuntime: Future, full VM isolation
"""

from agentd.sandbox.base import SandboxRuntime
from agentd.sandbox.host import HostRuntime

__all__ = ["SandboxRuntime", "HostRuntime"]
EOF

# agentd/sandbox/base.py
cat > "$PROJECT_ROOT/src/agentd/sandbox/base.py" << 'EOF'
"""Base class for sandbox runtimes."""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class ExecResult:
    """Result of executing a command in the sandbox."""
    exit_code: int
    stdout: str
    stderr: str


class SandboxRuntime(ABC):
    """
    Abstract sandbox runtime.

    All tool execution goes through this interface,
    allowing us to swap HostRuntime for LinuxVMRuntime later.
    """

    @abstractmethod
    async def create_sandbox(self, workspace_root: Path) -> str:
        """Create a new sandbox, return sandbox_id."""
        pass

    @abstractmethod
    async def exec(
        self,
        sandbox_id: str,
        command: list[str],
        cwd: Optional[Path] = None,
        env: Optional[dict[str, str]] = None,
    ) -> ExecResult:
        """Execute a command in the sandbox."""
        pass

    @abstractmethod
    async def read_file(self, sandbox_id: str, path: Path) -> str:
        """Read a file from the sandbox."""
        pass

    @abstractmethod
    async def write_file(self, sandbox_id: str, path: Path, content: str) -> None:
        """Write a file in the sandbox."""
        pass

    @abstractmethod
    async def attach_terminal(self, sandbox_id: str) -> str:
        """Get PTY endpoint for terminal attachment."""
        pass

    @abstractmethod
    async def destroy_sandbox(self, sandbox_id: str) -> None:
        """Clean up the sandbox."""
        pass
EOF

# agentd/sandbox/host.py
cat > "$PROJECT_ROOT/src/agentd/sandbox/host.py" << 'EOF'
"""
Host runtime - MVP sandbox with workspace containment.

NOT real security - just prevents accidental damage outside workspace.
"""

import asyncio
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from agentd.sandbox.base import ExecResult, SandboxRuntime


@dataclass
class HostSandbox:
    """A host sandbox instance."""
    id: str
    workspace_root: Path
    allowed_paths: set[Path] = field(default_factory=set)


class HostRuntime(SandboxRuntime):
    """
    Host-based sandbox with workspace containment.

    Security model (MVP):
    - All paths must resolve within workspace_root
    - Symlinks pointing outside are blocked
    - Environment is controlled (no secrets leak)
    - CWD is always within workspace
    """

    def __init__(self):
        self.sandboxes: dict[str, HostSandbox] = {}

    def _resolve_path(self, sandbox: HostSandbox, path: Path) -> Path:
        """Resolve and validate a path is within workspace."""
        # Make absolute
        if not path.is_absolute():
            path = sandbox.workspace_root / path

        # Resolve symlinks and normalize
        try:
            resolved = path.resolve(strict=False)
        except (OSError, ValueError) as e:
            raise PermissionError(f"Invalid path: {path}") from e

        # Check it's within workspace
        try:
            resolved.relative_to(sandbox.workspace_root.resolve())
        except ValueError:
            raise PermissionError(
                f"Path escape blocked: {path} -> {resolved} "
                f"(outside {sandbox.workspace_root})"
            )

        return resolved

    async def create_sandbox(self, workspace_root: Path) -> str:
        """Create a host sandbox."""
        sandbox_id = str(uuid.uuid4())
        workspace = Path(workspace_root).resolve()

        if not workspace.exists():
            raise ValueError(f"Workspace does not exist: {workspace}")

        self.sandboxes[sandbox_id] = HostSandbox(
            id=sandbox_id,
            workspace_root=workspace,
        )
        return sandbox_id

    async def exec(
        self,
        sandbox_id: str,
        command: list[str],
        cwd: Optional[Path] = None,
        env: Optional[dict[str, str]] = None,
    ) -> ExecResult:
        """Execute command with workspace containment."""
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            raise ValueError(f"Sandbox not found: {sandbox_id}")

        # Resolve cwd
        exec_cwd = sandbox.workspace_root
        if cwd:
            exec_cwd = self._resolve_path(sandbox, cwd)

        # Build safe environment
        safe_env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(sandbox.workspace_root),
            "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8",
        }
        if env:
            safe_env.update(env)

        # Execute
        proc = await asyncio.create_subprocess_exec(
            *command,
            cwd=exec_cwd,
            env=safe_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        stdout, stderr = await proc.communicate()

        return ExecResult(
            exit_code=proc.returncode or 0,
            stdout=stdout.decode("utf-8", errors="replace"),
            stderr=stderr.decode("utf-8", errors="replace"),
        )

    async def read_file(self, sandbox_id: str, path: Path) -> str:
        """Read file with path validation."""
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            raise ValueError(f"Sandbox not found: {sandbox_id}")

        resolved = self._resolve_path(sandbox, path)
        return resolved.read_text()

    async def write_file(self, sandbox_id: str, path: Path, content: str) -> None:
        """Write file with path validation."""
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            raise ValueError(f"Sandbox not found: {sandbox_id}")

        resolved = self._resolve_path(sandbox, path)
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_text(content)

    async def attach_terminal(self, sandbox_id: str) -> str:
        """Get PTY endpoint - returns workspace root for terminal cwd."""
        sandbox = self.sandboxes.get(sandbox_id)
        if not sandbox:
            raise ValueError(f"Sandbox not found: {sandbox_id}")

        # For MVP, just return the workspace root
        # Full PTY implementation would spawn a shell and return a pty path
        return str(sandbox.workspace_root)

    async def destroy_sandbox(self, sandbox_id: str) -> None:
        """Clean up sandbox state."""
        if sandbox_id in self.sandboxes:
            del self.sandboxes[sandbox_id]
EOF

log_success "Created agentd Python package"

# =============================================================================
# SLICE 0: Swift Protocol Types
# =============================================================================

log_step "Creating Swift protocol types..."

mkdir -p "$PROJECT_ROOT/macos/Sources/Features/Smithers/Protocol"
mkdir -p "$PROJECT_ROOT/macos/Sources/Features/Smithers/Agent"
mkdir -p "$PROJECT_ROOT/macos/Sources/Features/Smithers/Graph"
mkdir -p "$PROJECT_ROOT/macos/Sources/Features/Smithers/Terminal"
mkdir -p "$PROJECT_ROOT/macos/Sources/Features/Smithers/Inspector"

# Swift Protocol/Event.swift
cat > "$PROJECT_ROOT/macos/Sources/Features/Smithers/Protocol/Event.swift" << 'EOF'
import Foundation

/// All event types from the Agent Runtime Protocol
enum AgentEventType: String, Codable {
    // Daemon lifecycle
    case daemonReady = "daemon.ready"
    case daemonError = "daemon.error"

    // Session events
    case sessionCreated = "session.created"
    case sessionClosed = "session.closed"

    // Run control
    case runStarted = "run.started"
    case runFinished = "run.finished"
    case runCancelled = "run.cancelled"
    case runError = "run.error"

    // Streaming
    case assistantDelta = "assistant.delta"
    case assistantFinal = "assistant.final"

    // Tools
    case toolStart = "tool.start"
    case toolOutputRef = "tool.output_ref"
    case toolEnd = "tool.end"

    // Checkpoints
    case checkpointCreated = "checkpoint.created"
    case checkpointRestored = "checkpoint.restored"

    // Stack operations
    case stackRebased = "stack.rebased"
    case syncStatus = "sync.status"

    // Subagents
    case subagentStart = "subagent.start"
    case subagentEnd = "subagent.end"

    // Skills
    case skillStart = "skill.start"
    case skillResult = "skill.result"
    case skillEnd = "skill.end"

    // Forms
    case formCreate = "form.create"
    case formSubmit = "form.submit"

    // Generic error
    case error = "error"
}

/// A protocol event received from agentd
struct AgentEvent: Codable, Identifiable {
    let id: UUID
    let type: AgentEventType
    let data: [String: AnyCodable]
    let timestamp: Date

    init(type: AgentEventType, data: [String: AnyCodable] = [:]) {
        self.id = UUID()
        self.type = type
        self.data = data
        self.timestamp = Date()
    }
}

/// Type-erased Codable for JSON data
struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            value = string
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else {
            value = NSNull()
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let string as String:
            try container.encode(string)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let bool as Bool:
            try container.encode(bool)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            try container.encodeNil()
        }
    }
}
EOF

# Swift Protocol/Request.swift
cat > "$PROJECT_ROOT/macos/Sources/Features/Smithers/Protocol/Request.swift" << 'EOF'
import Foundation

/// A request to send to agentd
struct AgentRequest: Encodable {
    let id: String
    let method: String
    let params: [String: AnyCodable]

    init(method: String, params: [String: Any] = [:]) {
        self.id = UUID().uuidString
        self.method = method
        self.params = params.mapValues { AnyCodable($0) }
    }

    /// Create a session
    static func createSession(workspaceRoot: String) -> AgentRequest {
        AgentRequest(method: "session.create", params: ["workspace_root": workspaceRoot])
    }

    /// Send a message to a session
    static func sendMessage(sessionId: String, message: String, surfaces: [[String: Any]] = []) -> AgentRequest {
        AgentRequest(method: "session.send", params: [
            "session_id": sessionId,
            "message": message,
            "surfaces": surfaces,
        ])
    }

    /// Cancel a run
    static func cancelRun(runId: String) -> AgentRequest {
        AgentRequest(method: "run.cancel", params: ["run_id": runId])
    }
}
EOF

log_success "Created Swift protocol types"

# =============================================================================
# Swift AgentClient
# =============================================================================

log_step "Creating Swift AgentClient..."

cat > "$PROJECT_ROOT/macos/Sources/Features/Smithers/Agent/AgentClient.swift" << 'EOF'
import Foundation
import Combine

/// Client for communicating with agentd
@MainActor
class AgentClient: ObservableObject {
    @Published var isConnected = false
    @Published var lastError: String?

    private var process: Process?
    private var inputPipe: Pipe?
    private var outputPipe: Pipe?
    private var cancellables = Set<AnyCancellable>()

    private let eventSubject = PassthroughSubject<AgentEvent, Never>()
    var events: AnyPublisher<AgentEvent, Never> {
        eventSubject.eraseToAnyPublisher()
    }

    private let workspaceRoot: String
    private let sandboxMode: String
    private let agentBackend: String

    init(
        workspaceRoot: String,
        sandboxMode: String = "host",
        agentBackend: String = "fake"
    ) {
        self.workspaceRoot = workspaceRoot
        self.sandboxMode = sandboxMode
        self.agentBackend = agentBackend
    }

    func start() async throws {
        // Find Python and agentd
        let pythonPath = "/usr/bin/env"
        let agentdModule = "agentd"

        process = Process()
        process?.executableURL = URL(fileURLWithPath: pythonPath)
        process?.arguments = [
            "python", "-m", agentdModule,
            "--workspace", workspaceRoot,
            "--sandbox", sandboxMode,
            "--backend", agentBackend,
        ]

        inputPipe = Pipe()
        outputPipe = Pipe()
        process?.standardInput = inputPipe
        process?.standardOutput = outputPipe
        process?.standardError = FileHandle.nullDevice

        // Handle process termination
        process?.terminationHandler = { [weak self] proc in
            Task { @MainActor in
                self?.isConnected = false
                if proc.terminationStatus != 0 {
                    self?.lastError = "agentd exited with code \(proc.terminationStatus)"
                }
            }
        }

        // Read output in background
        Task.detached { [weak self] in
            await self?.readOutput()
        }

        try process?.run()
        isConnected = true
    }

    func stop() {
        process?.terminate()
        process = nil
        isConnected = false
    }

    func send(_ request: AgentRequest) throws {
        guard let pipe = inputPipe else {
            throw AgentClientError.notConnected
        }

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(request)
        let line = String(data: data, encoding: .utf8)! + "\n"

        pipe.fileHandleForWriting.write(line.data(using: .utf8)!)
    }

    private func readOutput() async {
        guard let pipe = outputPipe else { return }

        let handle = pipe.fileHandleForReading
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        while true {
            guard let data = try? handle.availableData, !data.isEmpty else {
                break
            }

            let lines = String(data: data, encoding: .utf8)?
                .split(separator: "\n")
                .map(String.init) ?? []

            for line in lines where !line.isEmpty {
                if let lineData = line.data(using: .utf8),
                   let event = try? decoder.decode(AgentEvent.self, from: lineData) {
                    await MainActor.run {
                        eventSubject.send(event)
                    }
                }
            }
        }
    }
}

enum AgentClientError: Error {
    case notConnected
    case encodingError
}
EOF

log_success "Created Swift AgentClient"

# =============================================================================
# Swift Session Graph Model
# =============================================================================

log_step "Creating Swift session graph model..."

cat > "$PROJECT_ROOT/macos/Sources/Features/Smithers/Graph/GraphNode.swift" << 'EOF'
import Foundation

/// Types of nodes in the session graph
enum GraphNodeType: String, Codable {
    case message         // User or assistant message
    case toolUse         // Tool invocation
    case toolResult      // Tool result (references artifact)
    case checkpoint      // Code snapshot
    case subagentRun     // Subagent execution
    case skillRun        // Skill execution
    case promptRebase    // Prompt rebase point
    case browserSnapshot // Captured browser state
}

/// A node in the session graph
struct GraphNode: Identifiable, Codable {
    let id: UUID
    let type: GraphNodeType
    let parentId: UUID?
    let timestamp: Date
    var data: [String: AnyCodable]

    // Computed properties for common data fields
    var text: String? {
        data["text"]?.value as? String
    }

    var toolName: String? {
        data["tool_name"]?.value as? String
    }

    var artifactRef: String? {
        data["artifact_ref"]?.value as? String
    }
}

/// The session graph - a DAG of nodes
class SessionGraph: ObservableObject {
    @Published var nodes: [UUID: GraphNode] = [:]
    @Published var rootIds: [UUID] = []

    /// All nodes in topological order
    var orderedNodes: [GraphNode] {
        var result: [GraphNode] = []
        var visited = Set<UUID>()

        func visit(_ id: UUID) {
            guard !visited.contains(id), let node = nodes[id] else { return }
            visited.insert(id)
            if let parentId = node.parentId {
                visit(parentId)
            }
            result.append(node)
        }

        for id in nodes.keys {
            visit(id)
        }

        return result
    }

    /// Children of a node
    func children(of nodeId: UUID) -> [GraphNode] {
        nodes.values.filter { $0.parentId == nodeId }
    }

    /// Add a node to the graph
    func addNode(_ node: GraphNode) {
        nodes[node.id] = node
        if node.parentId == nil {
            rootIds.append(node.id)
        }
    }

    /// Project to chat messages (for Chat Mode)
    func projectToChat() -> [ChatMessage] {
        orderedNodes.compactMap { node -> ChatMessage? in
            switch node.type {
            case .message:
                let role = (node.data["role"]?.value as? String) ?? "assistant"
                return ChatMessage(
                    id: node.id,
                    role: role == "user" ? .user : .assistant,
                    content: node.text ?? "",
                    timestamp: node.timestamp
                )
            default:
                return nil
            }
        }
    }
}

/// A chat message (projection from graph)
struct ChatMessage: Identifiable {
    enum Role {
        case user
        case assistant
    }

    let id: UUID
    let role: Role
    let content: String
    let timestamp: Date
}
EOF

log_success "Created Swift session graph model"

# =============================================================================
# Test fixtures
# =============================================================================

log_step "Creating test fixtures..."

mkdir -p "$PROJECT_ROOT/tests/fixtures"

# Python test for agentd
cat > "$PROJECT_ROOT/tests/test_agentd.py" << 'EOF'
"""Tests for the agentd daemon."""

import pytest
import json
import asyncio
from io import StringIO

from agentd.daemon import AgentDaemon, DaemonConfig
from agentd.protocol.events import EventType


class TestAgentDaemon:
    """Test the agent daemon."""

    @pytest.fixture
    def config(self, tmp_path):
        return DaemonConfig(
            workspace_root=str(tmp_path),
            sandbox_mode="host",
            agent_backend="fake",
        )

    @pytest.fixture
    def streams(self):
        return StringIO(), StringIO()

    def test_daemon_emits_ready_event(self, config, streams):
        """Daemon should emit ready event on start."""
        input_stream, output_stream = streams

        # Send EOF to stop the daemon
        input_stream.write("")
        input_stream.seek(0)

        daemon = AgentDaemon(config, input_stream, output_stream)

        async def run():
            await daemon.run()

        asyncio.run(run())

        output_stream.seek(0)
        lines = output_stream.read().strip().split("\n")

        assert len(lines) >= 1
        event = json.loads(lines[0])
        assert event["type"] == "daemon.ready"
        assert event["data"]["version"] == "0.1.0"


class TestProtocolEvents:
    """Test protocol event serialization."""

    def test_event_serialization(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.ASSISTANT_DELTA,
            data={"text": "Hello, world!"},
        )

        d = event.to_dict()
        assert d["type"] == "assistant.delta"
        assert d["data"]["text"] == "Hello, world!"
        assert "timestamp" in d


class TestHostRuntime:
    """Test the host sandbox runtime."""

    @pytest.fixture
    def runtime(self):
        from agentd.sandbox.host import HostRuntime
        return HostRuntime()

    @pytest.mark.asyncio
    async def test_create_sandbox(self, runtime, tmp_path):
        sandbox_id = await runtime.create_sandbox(tmp_path)
        assert sandbox_id is not None
        assert sandbox_id in runtime.sandboxes

    @pytest.mark.asyncio
    async def test_path_escape_blocked(self, runtime, tmp_path):
        sandbox_id = await runtime.create_sandbox(tmp_path)

        with pytest.raises(PermissionError, match="Path escape blocked"):
            await runtime.read_file(sandbox_id, tmp_path / ".." / "etc" / "passwd")

    @pytest.mark.asyncio
    async def test_exec_in_workspace(self, runtime, tmp_path):
        sandbox_id = await runtime.create_sandbox(tmp_path)

        result = await runtime.exec(sandbox_id, ["pwd"])
        assert result.exit_code == 0
        assert str(tmp_path) in result.stdout

    @pytest.mark.asyncio
    async def test_read_write_file(self, runtime, tmp_path):
        sandbox_id = await runtime.create_sandbox(tmp_path)

        test_file = tmp_path / "test.txt"
        await runtime.write_file(sandbox_id, test_file, "Hello, world!")

        content = await runtime.read_file(sandbox_id, test_file)
        assert content == "Hello, world!"
EOF

# Golden event fixture
cat > "$PROJECT_ROOT/tests/fixtures/golden_events.json" << 'EOF'
[
  {"type": "daemon.ready", "data": {"version": "0.1.0", "config": {"sandbox_mode": "host", "agent_backend": "fake"}}},
  {"type": "session.created", "data": {"session_id": "test-session-1"}},
  {"type": "run.started", "data": {"run_id": "run-1", "session_id": "test-session-1"}},
  {"type": "assistant.delta", "data": {"text": "I'll help you with that. "}},
  {"type": "assistant.delta", "data": {"text": "Let me analyze the code..."}},
  {"type": "tool.start", "data": {"tool_use_id": "t1", "name": "Read", "input": {"path": "/src/main.py"}}},
  {"type": "tool.output_ref", "data": {"tool_use_id": "t1", "artifact_ref": "sha256:abc123", "preview": "def main():\n    ..."}},
  {"type": "tool.end", "data": {"tool_use_id": "t1", "status": "success"}},
  {"type": "assistant.delta", "data": {"text": "\n\nI found the issue. The authentication function..."}},
  {"type": "assistant.final", "data": {"message_id": "msg-1"}},
  {"type": "checkpoint.created", "data": {"checkpoint_id": "cp-1", "label": "Before fix", "stack_position": 0}},
  {"type": "run.finished", "data": {"run_id": "run-1", "session_id": "test-session-1"}}
]
EOF

log_success "Created test fixtures"

# =============================================================================
# Update pyproject.toml
# =============================================================================

log_step "Updating pyproject.toml..."

# Check if agentd is already in the package list
if ! grep -q '"agentd"' "$PROJECT_ROOT/pyproject.toml"; then
    # Add agentd to packages
    sed -i.bak 's/packages = \["src\/smithers"\]/packages = ["src\/smithers", "src\/agentd"]/' "$PROJECT_ROOT/pyproject.toml"
    rm -f "$PROJECT_ROOT/pyproject.toml.bak"
    log_success "Added agentd to pyproject.toml"
else
    log_warn "agentd already in pyproject.toml"
fi

# =============================================================================
# Summary
# =============================================================================

echo ""
echo "==================================================================="
echo -e "${GREEN}Smithers v2 Scaffold Complete!${NC}"
echo "==================================================================="
echo ""
echo "Created:"
echo "  📦 src/agentd/           - Python agent daemon"
echo "     ├── daemon.py         - Main daemon entry point"
echo "     ├── session.py        - Session management"
echo "     ├── protocol/         - Event/Request definitions"
echo "     ├── adapters/         - Agent backends (Fake, Anthropic)"
echo "     └── sandbox/          - Sandbox runtimes (Host, VM stub)"
echo ""
echo "  🍎 macos/Sources/Features/Smithers/"
echo "     ├── Protocol/         - Swift event/request types"
echo "     ├── Agent/            - AgentClient (Swift<->Python bridge)"
echo "     └── Graph/            - Session graph model"
echo ""
echo "  🧪 tests/"
echo "     ├── test_agentd.py    - Python tests"
echo "     └── fixtures/         - Golden event logs"
echo ""
echo "Next steps:"
echo "  1. Run 'uv sync' to install dependencies"
echo "  2. Run 'zig build test' to verify Python tests pass"
echo "  3. Start implementing Category tasks from smithers-v2-task-guide.md"
echo ""
echo "Recommended first slice (Slice 0):"
echo "  - Wire FakeAgentAdapter to Swift UI"
echo "  - Render transcript from events"
echo "  - Add tool cards with output viewer"
echo ""
