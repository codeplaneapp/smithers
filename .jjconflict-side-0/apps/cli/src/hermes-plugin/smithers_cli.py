"""Thin, dependency-free wrapper around the `smithers` CLI.

Every tool/hook/command in this plugin reaches Smithers by shelling out to the
CLI rather than importing anything — Smithers is a TypeScript/Bun project, so the
CLI is the stable cross-language surface. Resolution order for the binary:

1. ``$SMITHERS_BIN`` (explicit override),
2. a ``smithers`` on ``PATH``,
3. ``bunx smithers-orchestrator`` (works with no global install),
4. ``npx smithers-orchestrator`` as a last resort.

Nothing here raises: callers get a structured ``CliResult`` and decide what to do.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any, Optional

_DEFAULT_TIMEOUT = 60.0


@dataclass
class CliResult:
    ok: bool
    exit_code: int
    stdout: str
    stderr: str

    def json(self) -> Optional[Any]:
        """Parse stdout as JSON, tolerating a trailing CTA object that some
        commands append (parse the first JSON value only)."""
        text = self.stdout.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            decoder = json.JSONDecoder()
            try:
                value, _ = decoder.raw_decode(text)
                return value
            except json.JSONDecodeError:
                return None


def _base_command() -> list[str]:
    override = os.environ.get("SMITHERS_BIN")
    if override:
        return override.split()
    if shutil.which("smithers"):
        return ["smithers"]
    if shutil.which("bunx"):
        return ["bunx", "smithers-orchestrator"]
    if shutil.which("npx"):
        return ["npx", "smithers-orchestrator"]
    # Fall back to a bare name; the subprocess call will report the failure.
    return ["smithers"]


def run(args: list[str], *, timeout: float = _DEFAULT_TIMEOUT, cwd: Optional[str] = None) -> CliResult:
    """Run ``smithers <args>`` and capture the result. Never raises."""
    command = [*_base_command(), *args]
    try:
        proc = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
        )
        return CliResult(
            ok=proc.returncode == 0,
            exit_code=proc.returncode,
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
        )
    except subprocess.TimeoutExpired:
        return CliResult(ok=False, exit_code=124, stdout="", stderr=f"smithers timed out after {timeout}s")
    except FileNotFoundError:
        return CliResult(
            ok=False,
            exit_code=127,
            stdout="",
            stderr="smithers binary not found (set $SMITHERS_BIN, or install bun/node).",
        )
    except Exception as exc:  # noqa: BLE001 — never let a CLI hiccup crash Hermes.
        return CliResult(ok=False, exit_code=1, stdout="", stderr=str(exc))
