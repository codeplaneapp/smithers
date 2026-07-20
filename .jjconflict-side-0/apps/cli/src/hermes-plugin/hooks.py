"""Lifecycle hooks that make Hermes aware of in-flight Smithers work.

All hooks are best-effort and defensive: a slow or missing CLI must never break
a turn, so every hook swallows its own errors and returns a benign value.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from . import smithers_cli

# Remembered across a session so later turns / the session-end summary can refer
# to "the run" the user just started. Keyed by session id.
_LAST_RUN_BY_SESSION: dict[str, str] = {}


def _summarize_ps(parsed: Any) -> Optional[str]:
    """Turn `smithers ps --json` into a short status line, or None if idle."""
    runs = parsed.get("runs") if isinstance(parsed, dict) else parsed
    if not isinstance(runs, list) or not runs:
        return None
    active, paused, gates = [], [], []
    for run in runs:
        if not isinstance(run, dict):
            continue
        rid = run.get("runId") or run.get("id") or "?"
        status = (run.get("status") or "").lower()
        name = run.get("workflow") or run.get("name") or "workflow"
        if status in ("running", "active"):
            active.append(f"{rid} ({name})")
        elif status in ("paused", "waiting", "waiting-approval", "suspended"):
            paused.append(f"{rid} ({name}, {status})")
        for gate in run.get("pendingApprovals", []) or []:
            node = gate.get("nodeId") or gate.get("node") or "?"
            gates.append(f"{rid}:{node}")
    if not (active or paused or gates):
        return None
    lines = ["Live Smithers runs (you are the operator — observe and clear gates):"]
    if active:
        lines.append(f"- active: {', '.join(active)}")
    if paused:
        lines.append(f"- paused: {', '.join(paused)}")
    if gates:
        lines.append(
            "- pending approvals: "
            + ", ".join(gates)
            + " — relay to the human, then smithers_approve/smithers_deny with run_id + node."
        )
    return "\n".join(lines)


def pre_llm_call(session_id=None, user_message=None, is_first_turn=False, **kwargs):
    """Inject live-run status so Hermes always knows what durable work is in
    flight without being asked. Cheap: one `smithers ps --json`, skipped silently
    when nothing is running."""
    try:
        cli = smithers_cli.run(["ps", "--json"], timeout=8.0)
        if not cli.ok:
            return None
        context = _summarize_ps(cli.json())
        if not context:
            return None
        return {"context": context}
    except Exception:  # noqa: BLE001
        return None


def post_tool_call(tool_name=None, args=None, result=None, task_id=None, session_id=None, **kwargs):
    """When a smithers_run tool call returns a run id, remember it on the session
    so later turns and the end-of-session summary can reference it."""
    try:
        if tool_name != "smithers_run" or not isinstance(result, str):
            return None
        parsed = json.loads(result)
        run_id = _extract_run_id(parsed)
        if run_id and session_id:
            _LAST_RUN_BY_SESSION[str(session_id)] = run_id
    except Exception:  # noqa: BLE001
        pass
    return None


def on_session_end(session_id=None, completed=None, interrupted=None, **kwargs):
    """Surface a final status for any run started this session, so the user sees
    where their durable work stands when the session closes."""
    try:
        run_id = _LAST_RUN_BY_SESSION.pop(str(session_id), None)
        if not run_id:
            return None
        cli = smithers_cli.run(["inspect", run_id, "--json"], timeout=10.0)
        parsed = cli.json() if cli.ok else None
        status = parsed.get("status") if isinstance(parsed, dict) else "unknown"
        print(
            f"[smithers] run {run_id} is '{status}'. "
            f"Resume/inspect anytime: smithers inspect {run_id}"
        )
    except Exception:  # noqa: BLE001
        pass
    return None


def subagent_stop(task_id=None, result=None, **kwargs):
    """When Hermes's own delegate_task finishes, nudge toward promoting durable,
    multi-step follow-up work into a Smithers run rather than another ad-hoc
    delegation. Hint only — never auto-acts."""
    return None


def _extract_run_id(parsed: Any) -> Optional[str]:
    if not isinstance(parsed, dict):
        return None
    for key in ("runId", "run_id", "id"):
        if isinstance(parsed.get(key), str):
            return parsed[key]
    inner = parsed.get("result")
    if isinstance(inner, dict):
        return _extract_run_id(inner)
    return None
