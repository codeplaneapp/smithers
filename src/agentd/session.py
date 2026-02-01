"""
Session and SessionManager for agentd.

Each session represents an agent conversation with its own
graph state, checkpoints, and tool execution context.
"""

import asyncio
import contextlib
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from agentd.adapters.base import AgentAdapter
from agentd.protocol.events import Event, EventType
from agentd.store.sqlite import SessionStore


@dataclass
class Session:
    """An agent session with its state."""

    id: str
    workspace_root: str
    created_at: datetime = field(default_factory=datetime.now)
    current_run_id: str | None = None
    message_history: list[dict[str, Any]] = field(default_factory=lambda: [])

    @classmethod
    def create(cls, workspace_root: str) -> "Session":
        return cls(
            id=str(uuid.uuid4()),
            workspace_root=workspace_root,
        )


class SessionManager:
    """Manages multiple concurrent sessions."""

    def __init__(
        self,
        adapter: AgentAdapter,
        store: SessionStore | None = None,
        config: Any = None,
    ):
        """Initialize the session manager with an agent adapter.

        Args:
            adapter: The agent adapter to use for running conversations
            store: Optional SQLite store for persisting events
            config: Optional configuration object (for future use)
        """
        self.adapter = adapter
        self.store = store
        self.config = config
        self.sessions: dict[str, Session] = {}
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self._running_tasks: dict[str, asyncio.Task[Any]] = {}

    async def create_session(self, workspace_root: str) -> Session:
        """Create a new session."""
        session = Session.create(workspace_root)
        self.sessions[session.id] = session

        # Persist session to store if available
        if self.store:
            await self.store.create_session(
                session_id=session.id,
                workspace_root=workspace_root,
            )

        return session

    async def send_message(
        self,
        session_id: str,
        message: str,
        surfaces: list[str] | None = None,
        emit: Callable[[Event], None] | None = None,
    ) -> None:
        """Send a user message to start/continue a run.

        Args:
            session_id: ID of the session to send message to
            message: User message text
            surfaces: Optional list of surface IDs (for future use)
            emit: Optional callback for events (for testing)
        """
        session = self.sessions.get(session_id)
        if not session:
            if emit:
                emit(
                    Event(
                        type=EventType.ERROR, data={"message": f"Session not found: {session_id}"}
                    )
                )
            return

        run_id = str(uuid.uuid4())
        session.current_run_id = run_id

        # Create a wrapper that persists events to the store before emitting
        def emit_with_persistence(event: Event) -> None:
            """Persist event to store and then emit to callback."""
            # Persist to store if available (schedule as background task)
            if self.store:
                task = asyncio.create_task(
                    self.store.append_event(
                        session_id=session_id,
                        event_type=event.type.value,
                        payload=event.data,
                    )
                )
                # Keep a reference to prevent garbage collection
                self._background_tasks.add(task)
                task.add_done_callback(self._background_tasks.discard)

            # Then emit to callback
            if emit:
                emit(event)

        emit_with_persistence(
            Event(type=EventType.RUN_STARTED, data={"run_id": run_id, "session_id": session_id})
        )

        # Add user message to history
        session.message_history.append({"role": "user", "content": message})

        try:
            # Run the agent through the adapter - wrap in task for cancellation
            agent_task = asyncio.create_task(
                self._run_agent(session, surfaces or [], emit_with_persistence)
            )
            # Track the running task so we can cancel it
            self._running_tasks[run_id] = agent_task

            # Wait for completion
            await agent_task

            emit_with_persistence(
                Event(
                    type=EventType.RUN_FINISHED, data={"run_id": run_id, "session_id": session_id}
                )
            )
        except asyncio.CancelledError:
            # Run was cancelled
            emit_with_persistence(
                Event(
                    type=EventType.RUN_CANCELLED, data={"run_id": run_id, "session_id": session_id}
                )
            )
            raise
        finally:
            # Clean up run tracking
            self._running_tasks.pop(run_id, None)
            if session.current_run_id == run_id:
                session.current_run_id = None

    async def _run_agent(
        self,
        session: Session,
        surfaces: list[str],
        emit: Callable[[Event], None] | None = None,
    ) -> None:
        """Run the agent using the configured adapter.

        Args:
            session: The session to run in
            surfaces: List of surface IDs (for future use)
            emit: Optional callback for events
        """
        # Build tool specs (empty for now, will be populated from surfaces)
        tools: list[dict[str, Any]] = []

        # Track assistant response text
        assistant_response = ""

        # Wrapper to capture assistant deltas
        def capture_and_emit(event: Event) -> None:
            nonlocal assistant_response
            if event.type == EventType.ASSISTANT_DELTA:
                assistant_response += event.data.get("text", "")
            if emit:
                emit(event)

        # Run the adapter with current message history
        async for _ in self.adapter.run(
            messages=session.message_history, tools=tools, emit=capture_and_emit
        ):
            # Events are already emitted by the adapter via the emit callback
            # We just consume the async iterator
            pass

        # Add assistant response to message history
        if assistant_response:
            session.message_history.append({"role": "assistant", "content": assistant_response})

    async def cancel_run(self, run_id: str) -> None:
        """Cancel a running agent.

        Args:
            run_id: The run ID to cancel
        """
        # Find and cancel the running task
        task = self._running_tasks.get(run_id)
        if task and not task.done():
            # Cancel the adapter (stops generating new events)
            await self.adapter.cancel()

            # Cancel the asyncio task
            task.cancel()

            # Wait for the task to finish canceling
            with contextlib.suppress(asyncio.CancelledError):
                await task

        # Clear current_run_id for the session
        for session in self.sessions.values():
            if session.current_run_id == run_id:
                session.current_run_id = None
                break

    async def run_skill(
        self,
        session_id: str,
        skill_id: str,
        args: str | None = None,
        emit: Callable[[Event], None] | None = None,
    ) -> None:
        """Execute a skill in the context of a session.

        Args:
            session_id: ID of the session to run skill in
            skill_id: ID of the skill to run
            args: Optional arguments for the skill
            emit: Optional callback for events
        """
        from agentd.skills.base import SkillContext
        from agentd.skills.registry import get_skill_registry

        session = self.sessions.get(session_id)
        if not session:
            if emit:
                emit(
                    Event(
                        type=EventType.ERROR,
                        data={"message": f"Session not found: {session_id}"},
                    )
                )
            return

        # Get the skill from registry
        registry = get_skill_registry()
        skill = registry.get(skill_id)
        if not skill:
            if emit:
                emit(
                    Event(
                        type=EventType.ERROR,
                        data={"message": f"Skill not found: {skill_id}"},
                    )
                )
            return

        # Emit skill start event
        if emit:
            emit(
                Event(
                    type=EventType.SKILL_START,
                    data={"skill_id": skill_id, "name": skill.name, "args": args or ""},
                )
            )

        # Build skill context
        context = SkillContext(
            workspace_path=session.workspace_root,
            session_id=session_id,
            session_messages=session.message_history,
        )

        try:
            # Execute the skill
            result = await skill.execute(context, args)

            # Emit result event
            if emit:
                emit(
                    Event(
                        type=EventType.SKILL_RESULT,
                        data={"skill_id": skill_id, "result": result.result},
                    )
                )

            # Emit end event
            if emit:
                status = "success" if result.success else "error"
                emit(
                    Event(
                        type=EventType.SKILL_END,
                        data={
                            "skill_id": skill_id,
                            "status": status,
                            "error": result.error or "",
                        },
                    )
                )

        except Exception as e:
            # Emit error events
            if emit:
                emit(
                    Event(
                        type=EventType.SKILL_END,
                        data={"skill_id": skill_id, "status": "error", "error": str(e)},
                    )
                )

    async def create_checkpoint(
        self,
        session_id: str,
        message: str,
        session_node_id: str | None = None,
        emit: Callable[[Event], None] | None = None,
    ) -> None:
        """Create a checkpoint in the session's workspace.

        Args:
            session_id: ID of the session to create checkpoint for
            message: Human-readable description of the checkpoint
            session_node_id: Optional graph node ID to associate with this checkpoint
            emit: Optional callback for events
        """
        from pathlib import Path

        from agentd.jj import JJNotFoundError, RepoStateService

        session = self.sessions.get(session_id)
        if not session:
            if emit:
                emit(
                    Event(
                        type=EventType.ERROR,
                        data={"message": f"Session not found: {session_id}"},
                    )
                )
            return

        # Generate checkpoint ID
        checkpoint_id = str(uuid.uuid4())

        try:
            # Initialize RepoStateService
            repo_service = RepoStateService(Path(session.workspace_root))

            # Create checkpoint
            checkpoint = await repo_service.create_checkpoint(checkpoint_id, message)

            # Persist to store if available
            if self.store:
                await self.store.create_checkpoint(
                    checkpoint_id=checkpoint_id,
                    session_id=session_id,
                    session_node_id=session_node_id,
                    jj_commit_id=checkpoint.jj_commit_id,
                    bookmark_name=checkpoint.bookmark_name,
                    message=message,
                )

            # Emit checkpoint created event
            if emit:
                emit(
                    Event(
                        type=EventType.CHECKPOINT_CREATED,
                        data={
                            "checkpoint_id": checkpoint_id,
                            "label": message,
                            "jj_commit_id": checkpoint.jj_commit_id,
                            "bookmark_name": checkpoint.bookmark_name,
                        },
                    )
                )

        except JJNotFoundError as e:
            if emit:
                emit(
                    Event(
                        type=EventType.ERROR,
                        data={"message": str(e)},
                    )
                )
        except Exception as e:
            if emit:
                emit(
                    Event(
                        type=EventType.ERROR,
                        data={"message": f"Failed to create checkpoint: {e}"},
                    )
                )

    async def restore_checkpoint(
        self,
        session_id: str,
        checkpoint_id: str,
        emit: Callable[[Event], None] | None = None,
    ) -> None:
        """Restore a checkpoint in the session's workspace.

        Args:
            session_id: ID of the session to restore checkpoint for
            checkpoint_id: The checkpoint ID to restore
            emit: Optional callback for events
        """
        from pathlib import Path

        from agentd.jj import JJNotFoundError, RepoStateService

        session = self.sessions.get(session_id)
        if not session:
            if emit:
                emit(
                    Event(
                        type=EventType.ERROR,
                        data={"message": f"Session not found: {session_id}"},
                    )
                )
            return

        try:
            # Verify checkpoint exists in store
            if self.store:
                checkpoint_record = await self.store.get_checkpoint(checkpoint_id)
                if not checkpoint_record:
                    if emit:
                        emit(
                            Event(
                                type=EventType.ERROR,
                                data={"message": f"Checkpoint not found: {checkpoint_id}"},
                            )
                        )
                    return

            # Initialize RepoStateService
            repo_service = RepoStateService(Path(session.workspace_root))

            # Restore checkpoint
            await repo_service.restore_checkpoint(checkpoint_id)

            # Emit checkpoint restored event
            if emit:
                emit(
                    Event(
                        type=EventType.CHECKPOINT_RESTORED,
                        data={
                            "checkpoint_id": checkpoint_id,
                        },
                    )
                )

        except JJNotFoundError as e:
            if emit:
                emit(
                    Event(
                        type=EventType.ERROR,
                        data={"message": str(e)},
                    )
                )
        except Exception as e:
            if emit:
                emit(
                    Event(
                        type=EventType.ERROR,
                        data={"message": f"Failed to restore checkpoint: {e}"},
                    )
                )
