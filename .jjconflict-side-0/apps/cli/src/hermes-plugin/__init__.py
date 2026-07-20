"""Smithers plugin for Hermes Agent.

Wires Smithers into Hermes as a first-class plugin (not just an MCP entry):
tools, slash command, CLI subcommand, lifecycle hooks (live-run status injector,
run-id memory, end-of-session summary), a bundled skill, and — where the host
Hermes supports them — Slack approval buttons.

Everything is registered defensively: each `ctx.register_*` call is guarded so a
Hermes version that lacks a given surface skips that piece instead of failing to
load the whole plugin.
"""

from __future__ import annotations

from pathlib import Path

from . import commands, hooks, schemas, tools


def _try(label, fn):
    try:
        fn()
    except Exception as exc:  # noqa: BLE001 — a missing surface must not break load.
        print(f"[smithers] skipped {label}: {exc}")


def register(ctx) -> None:
    # --- Tools -------------------------------------------------------------
    tool_specs = [
        (schemas.SMITHERS_RUN, tools.smithers_run),
        (schemas.SMITHERS_PS, tools.smithers_ps),
        (schemas.SMITHERS_INSPECT, tools.smithers_inspect),
        (schemas.SMITHERS_APPROVE, tools.smithers_approve),
        (schemas.SMITHERS_DENY, tools.smithers_deny),
        (schemas.SMITHERS_OUTPUT, tools.smithers_output),
        (schemas.SMITHERS_HUMAN_ANSWER, tools.smithers_human_answer),
    ]
    for schema, handler in tool_specs:
        _try(
            f"tool {schema['name']}",
            lambda schema=schema, handler=handler: ctx.register_tool(
                name=schema["name"], toolset="smithers", schema=schema, handler=handler
            ),
        )

    # --- Lifecycle hooks ---------------------------------------------------
    for event, callback in (
        ("pre_llm_call", hooks.pre_llm_call),
        ("post_tool_call", hooks.post_tool_call),
        ("on_session_end", hooks.on_session_end),
        ("subagent_stop", hooks.subagent_stop),
    ):
        _try(f"hook {event}", lambda event=event, callback=callback: ctx.register_hook(event, callback))

    # --- Slash command (CLI + every gateway) -------------------------------
    _try(
        "command /smithers",
        lambda: ctx.register_command(
            "smithers",
            handler=commands.handle,
            description="Run and operate durable Smithers workflows",
        ),
    )

    # --- `hermes smithers ...` CLI subcommand ------------------------------
    if hasattr(ctx, "register_cli_command"):
        _try(
            "cli smithers",
            lambda: ctx.register_cli_command(
                "smithers",
                help="Run and operate durable Smithers workflows",
                setup_fn=commands.setup_cli,
                handler_fn=commands.handle_cli,
            ),
        )

    # --- Bundled skill: smithers:orchestrate -------------------------------
    skill_md = Path(__file__).parent / "skills" / "orchestrate" / "SKILL.md"
    if hasattr(ctx, "register_skill") and skill_md.exists():
        _try("skill orchestrate", lambda: ctx.register_skill("orchestrate", skill_md))

    # --- Slack approval buttons (optional surface) -------------------------
    # Buttons carry "<runId>:<nodeId>" in the Slack action `value`; we map a
    # click straight to `smithers approve/deny`. The payload shape varies by
    # Hermes version, so read it defensively.
    if hasattr(ctx, "register_slack_action_handler"):
        def _approval(verb):
            def _handler(payload=None, **kwargs):
                run_id, node = _read_action_target(payload, kwargs)
                if not run_id:
                    return None
                args = {"run_id": run_id, "node": node, "by": _read_actor(payload, kwargs)}
                return tools.smithers_approve(args) if verb == "approve" else tools.smithers_deny(args)
            return _handler

        _try(
            "slack smithers_approve",
            lambda: ctx.register_slack_action_handler("smithers_approve", _approval("approve")),
        )
        _try(
            "slack smithers_deny",
            lambda: ctx.register_slack_action_handler("smithers_deny", _approval("deny")),
        )


def _read_action_target(payload, kwargs):
    """Pull "<runId>:<nodeId>" out of whatever shape the Slack payload takes."""
    value = None
    if isinstance(payload, dict):
        value = payload.get("value") or payload.get("action_value")
        actions = payload.get("actions")
        if not value and isinstance(actions, list) and actions:
            value = actions[0].get("value")
    value = value or kwargs.get("value")
    if not isinstance(value, str) or ":" not in value:
        return (None, None)
    run_id, _, node = value.partition(":")
    return (run_id or None, node or None)


def _read_actor(payload, kwargs):
    if isinstance(payload, dict):
        user = payload.get("user")
        if isinstance(user, dict):
            return user.get("id") or user.get("username")
        if isinstance(user, str):
            return user
    return kwargs.get("user") or "hermes"
