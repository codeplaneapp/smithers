"""The `/smithers` slash command — works in the CLI and every gateway
(Discord/Telegram/Slack). A small dispatcher over the same CLI the tools use.
"""

from __future__ import annotations

import json
import shlex

from . import smithers_cli

_USAGE = (
    "Usage: /smithers <command>\n"
    "  run <workflow> [prompt...]   start a durable workflow run (detached)\n"
    "  ps                           list active / paused / recent runs\n"
    "  inspect <run-id>             full run state\n"
    "  approve <run-id> [node]      clear an approval gate\n"
    "  deny <run-id> [node]         reject an approval gate\n"
    "  output <run-id>              print a finished run's output\n"
    "  watch <run-id>               follow a run's events\n"
    "Smithers is your durable control plane: prefer a workflow over a one-off skill."
)


def handle(raw_args: str) -> str:
    try:
        tokens = shlex.split(raw_args or "")
    except ValueError:
        tokens = (raw_args or "").split()
    if not tokens:
        return _USAGE
    sub, rest = tokens[0], tokens[1:]

    if sub == "run":
        if not rest:
            return "Usage: /smithers run <workflow> [prompt...]"
        workflow = rest[0]
        cli_args = ["up", workflow] if workflow.endswith(".tsx") else ["workflow", "run", workflow]
        prompt = " ".join(rest[1:]).strip()
        if prompt:
            cli_args += ["--prompt", prompt]
        cli_args.append("--detach")
        return _render(smithers_cli.run(cli_args, timeout=180.0))

    if sub == "ps":
        return _render(smithers_cli.run(["ps"]))

    if sub in ("inspect", "output", "watch") and rest:
        verb = {"watch": "logs"}.get(sub, sub)
        extra = ["-f"] if sub == "watch" else []
        return _render(smithers_cli.run([verb, rest[0], *extra], timeout=20.0 if sub == "watch" else 60.0))

    if sub in ("approve", "deny") and rest:
        cli_args = [sub, rest[0]]
        if len(rest) > 1:
            cli_args += ["--node", rest[1]]
        return _render(smithers_cli.run(cli_args))

    return _USAGE


def _render(cli) -> str:
    if cli.ok:
        return (cli.stdout or "ok").strip()[:6000]
    err = (cli.stderr or cli.stdout or f"exited {cli.exit_code}").strip()
    return f"smithers error: {err[:2000]}"


# --- `hermes smithers ...` CLI subcommand ----------------------------------

def setup_cli(subparser) -> None:
    """Build the argparse tree for `hermes smithers <sub>`."""
    subs = subparser.add_subparsers(dest="smithers_command")
    run_p = subs.add_parser("run", help="Start a durable Smithers workflow run")
    run_p.add_argument("workflow")
    run_p.add_argument("prompt", nargs="*", default=[])
    ps_p = subs.add_parser("ps", help="List runs")  # noqa: F841
    for name in ("inspect", "output"):
        p = subs.add_parser(name, help=f"smithers {name} <run-id>")
        p.add_argument("run_id")


def handle_cli(args) -> None:
    command = getattr(args, "smithers_command", None)
    if command == "run":
        prompt = " ".join(getattr(args, "prompt", []) or [])
        line = f"run {args.workflow}{(' ' + prompt) if prompt else ''}"
        print(handle(line))
    elif command == "ps":
        print(handle("ps"))
    elif command in ("inspect", "output"):
        print(handle(f"{command} {args.run_id}"))
    else:
        print(_USAGE)
