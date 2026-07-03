"""Tool handlers. Each follows the Hermes contract strictly: take an ``args``
dict, do the work, and return a JSON string — never raise, never return a dict.
"""

from __future__ import annotations

import json
from typing import Any

from . import smithers_cli


def _result_json(cli, extra: dict[str, Any] | None = None) -> str:
    """Render a CliResult as the tool's JSON string. Prefer the CLI's own JSON
    output when it produced any, else fall back to trimmed text."""
    payload: dict[str, Any] = {"ok": cli.ok, "exit_code": cli.exit_code}
    parsed = cli.json()
    if parsed is not None:
        payload["result"] = parsed
    else:
        text = (cli.stdout or cli.stderr).strip()
        if text:
            payload["output"] = text[:6000]
    if not cli.ok and cli.stderr.strip():
        payload["error"] = cli.stderr.strip()[:2000]
    if extra:
        payload.update(extra)
    return json.dumps(payload)


def smithers_run(args: dict, **kwargs) -> str:
    workflow = str(args.get("workflow", "")).strip()
    if not workflow:
        return json.dumps({"error": "workflow is required"})
    is_tsx = workflow.endswith(".tsx")
    cli_args = ["up", workflow] if is_tsx else ["workflow", "run", workflow]
    prompt = args.get("prompt")
    prompt = prompt.strip() if isinstance(prompt, str) else ""
    user_input = args.get("input")
    user_input = dict(user_input) if isinstance(user_input, dict) else {}
    if is_tsx:
        # `smithers up` has no --prompt flag; fold any prompt into the workflow
        # input JSON (the workflow reads it from input) so the launch is not
        # rejected. `workflow run` DOES accept --prompt, so keep it there.
        if prompt:
            user_input.setdefault("prompt", prompt)
        if user_input:
            cli_args += ["--input", json.dumps(user_input)]
    else:
        if prompt:
            cli_args += ["--prompt", prompt]
        if user_input:
            cli_args += ["--input", json.dumps(user_input)]
    if args.get("detach", True):
        cli_args.append("--detach")
    # Runs can take a while to acknowledge; give the launch a generous window.
    cli = smithers_cli.run(cli_args, timeout=180.0)
    return _result_json(
        cli,
        extra={
            "hint": (
                "Watch it with smithers_ps / smithers_inspect. If a gate pauses, "
                "relay it to the human and use smithers_approve / smithers_deny."
            )
        },
    )


def smithers_ps(args: dict, **kwargs) -> str:
    return _result_json(smithers_cli.run(["ps", "--json"]))


def smithers_inspect(args: dict, **kwargs) -> str:
    run_id = str(args.get("run_id", "")).strip()
    if not run_id:
        return json.dumps({"error": "run_id is required"})
    return _result_json(smithers_cli.run(["inspect", run_id, "--json"]))


def _decision(verb: str, args: dict) -> str:
    run_id = str(args.get("run_id", "")).strip()
    if not run_id:
        return json.dumps({"error": "run_id is required"})
    cli_args = [verb, run_id]
    if args.get("node"):
        cli_args += ["--node", str(args["node"])]
    if args.get("by"):
        cli_args += ["--by", str(args["by"])]
    if args.get("note"):
        cli_args += ["--note", str(args["note"])]
    return _result_json(smithers_cli.run(cli_args))


def smithers_approve(args: dict, **kwargs) -> str:
    return _decision("approve", args)


def smithers_deny(args: dict, **kwargs) -> str:
    return _decision("deny", args)


def smithers_output(args: dict, **kwargs) -> str:
    run_id = str(args.get("run_id", "")).strip()
    if not run_id:
        return json.dumps({"error": "run_id is required"})
    # `smithers output` takes runId and nodeId as required POSITIONAL args (there
    # is no --node flag, and nodeId is not optional).
    node = str(args.get("node", "")).strip()
    if not node:
        return json.dumps({"error": "node is required (the CLI output command needs a node id)"})
    return _result_json(smithers_cli.run(["output", run_id, node]))


def smithers_human_answer(args: dict, **kwargs) -> str:
    request_id = str(args.get("request_id", "")).strip()
    value = args.get("value")
    if not request_id or value is None:
        return json.dumps({"error": "request_id and value are required"})
    return _result_json(
        smithers_cli.run(["human", "answer", request_id, "--value", json.dumps(str(value))])
    )
