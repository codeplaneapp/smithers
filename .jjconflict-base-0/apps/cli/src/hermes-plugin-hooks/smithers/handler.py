"""Gateway hook: surface Smithers run status back into a gateway session.

Fires on gateway lifecycle events (`agent:end`, `session:start`). This is the
push-back path that MCP cannot do: a detached Smithers run launched from a
Discord/Telegram/Slack session can report its result into that same chat.

The exact gateway hook context API is young and varies by Hermes version, so this
handler is fully defensive: it discovers a "send a message" callable on the event
context if one exists, and otherwise just logs. It never raises.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess


def _smithers_base() -> list[str]:
    override = os.environ.get("SMITHERS_BIN")
    if override:
        return override.split()
    if shutil.which("smithers"):
        return ["smithers"]
    if shutil.which("bunx"):
        return ["bunx", "smithers-orchestrator"]
    return ["smithers"]


def _active_summary() -> str | None:
    try:
        proc = subprocess.run(
            [*_smithers_base(), "ps", "--json"],
            capture_output=True,
            text=True,
            timeout=8.0,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return None
        data = json.loads(proc.stdout.strip())
        runs = data.get("runs") if isinstance(data, dict) else data
        if not isinstance(runs, list) or not runs:
            return None
        gates = []
        lines = []
        for run in runs:
            if not isinstance(run, dict):
                continue
            rid = run.get("runId") or run.get("id") or "?"
            status = run.get("status") or "?"
            name = run.get("workflow") or run.get("name") or "workflow"
            lines.append(f"• {rid} — {name} [{status}]")
            for gate in run.get("pendingApprovals", []) or []:
                node = gate.get("nodeId") or gate.get("node") or "?"
                gates.append(f"{rid}:{node}")
        body = "Smithers runs:\n" + "\n".join(lines)
        if gates:
            body += "\nPending approvals (relay to a human): " + ", ".join(gates)
        return body
    except Exception:  # noqa: BLE001
        return None


def _find_sender(ctx):
    """Best-effort discovery of a 'send message to this session' callable."""
    for name in ("send_message", "reply", "post", "respond", "say"):
        fn = getattr(ctx, name, None)
        if callable(fn):
            return fn
    if isinstance(ctx, dict):
        for name in ("send_message", "reply", "post"):
            fn = ctx.get(name)
            if callable(fn):
                return fn
    return None


async def handle(event=None, ctx=None, **kwargs):
    """Async gateway-hook entrypoint. Posts a run summary if there is one and a
    sender is available; otherwise logs and returns."""
    try:
        summary = _active_summary()
        if not summary:
            return None
        sender = _find_sender(ctx) or _find_sender(event)
        if sender is None:
            print(f"[smithers gateway hook] {summary}")
            return None
        result = sender(summary)
        # Support both sync and async senders.
        if hasattr(result, "__await__"):
            await result
    except Exception as exc:  # noqa: BLE001
        print(f"[smithers gateway hook] skipped: {exc}")
    return None


# Some hosts look for `handler` / `run` rather than `handle`.
handler = handle
run = handle
