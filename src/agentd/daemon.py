"""
AgentDaemon: Long-running process handling Swift <-> Python communication.

Implements the Agent Runtime Protocol over NDJSON.
"""

import asyncio
import json
import sys
from dataclasses import dataclass
from typing import TextIO

from agentd.adapters.base import AgentAdapter
from agentd.adapters.fake import FakeAgentAdapter
from agentd.protocol.events import Event, EventType
from agentd.protocol.requests import Request, parse_request
from agentd.session import SessionManager
from agentd.store.sqlite import SessionStore


@dataclass
class DaemonConfig:
    """Configuration for the agent daemon."""

    workspace_root: str
    sandbox_mode: str = "host"  # "host" | "linux_vm"
    agent_backend: str = "anthropic"  # "fake" | "anthropic"
    db_path: str = ".smithers/sessions.db"  # SQLite database path


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

        # Create the appropriate adapter based on config
        adapter = self._create_adapter()

        # Create SQLite store for event persistence
        self.store = SessionStore(config.db_path)

        self.session_manager = SessionManager(adapter=adapter, store=self.store, config=config)
        self._running = False

    def _create_adapter(self) -> AgentAdapter:
        """Create the agent adapter based on config."""
        if self.config.agent_backend == "fake":
            return FakeAgentAdapter()
        elif self.config.agent_backend == "anthropic":
            # Import here to avoid requiring anthropic for fake mode
            from agentd.adapters.anthropic import AnthropicAgentAdapter

            return AnthropicAgentAdapter()
        else:
            raise ValueError(f"Unknown agent backend: {self.config.agent_backend}")

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
                self.emit_event(
                    Event(type=EventType.SESSION_CREATED, data={"session_id": session.id})
                )

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
                self.emit_event(Event(type=EventType.RUN_CANCELLED, data={"run_id": run_id}))

            case "skill.run":
                session_id = request.params["session_id"]
                skill_id = request.params["skill_id"]
                args = request.params.get("args")
                await self.session_manager.run_skill(
                    session_id, skill_id, args, self.emit_event
                )

            case "checkpoint.create":
                session_id = request.params["session_id"]
                message = request.params["message"]
                session_node_id = request.params.get("session_node_id")
                await self.session_manager.create_checkpoint(
                    session_id, message, session_node_id, self.emit_event
                )

            case "checkpoint.restore":
                session_id = request.params["session_id"]
                checkpoint_id = request.params["checkpoint_id"]
                await self.session_manager.restore_checkpoint(
                    session_id, checkpoint_id, self.emit_event
                )

            case _:
                self.emit_event(
                    Event(
                        type=EventType.ERROR, data={"message": f"Unknown method: {request.method}"}
                    )
                )

    async def run(self) -> None:
        """Main event loop."""
        self._running = True

        # Initialize the SQLite store
        await self.store.initialize()

        self.emit_event(
            Event(
                type=EventType.DAEMON_READY,
                data={
                    "version": "0.1.0",
                    "config": {
                        "sandbox_mode": self.config.sandbox_mode,
                        "agent_backend": self.config.agent_backend,
                    },
                },
            )
        )

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
                self.emit_event(Event(type=EventType.ERROR, data={"message": f"Invalid JSON: {e}"}))
            except Exception as e:
                self.emit_event(Event(type=EventType.ERROR, data={"message": str(e)}))

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
