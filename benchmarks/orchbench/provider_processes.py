#!/usr/bin/env python3
"""List one root process for each live non-excluded provider-client tree."""

from __future__ import annotations

import argparse
import re
import subprocess


PROVIDER = re.compile(
    r"(?:^|/)(?:codex)\s+exec\b|"
    r"(?:^|/)(?:claude)\s+--print\b|"
    r"(?:^|/)(?:opencode)\s+(?:run|--print)\b|"
    r"(?:^|/)(?:kimi)\s+(?:run|--print|-p)\b"
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exclude-root", type=int)
    args = parser.parse_args()

    output = subprocess.check_output(
        ["ps", "-axo", "pid=,ppid=,command="], text=True
    )
    processes: dict[int, tuple[int, str]] = {}
    for raw in output.splitlines():
        parts = raw.strip().split(None, 2)
        if len(parts) != 3:
            continue
        pid, ppid, command = int(parts[0]), int(parts[1]), parts[2]
        processes[pid] = (ppid, command)

    def descends_from(pid: int, root: int | None) -> bool:
        if root is None:
            return False
        seen: set[int] = set()
        while pid in processes and pid not in seen:
            if pid == root:
                return True
            seen.add(pid)
            pid = processes[pid][0]
        return False

    matches = {
        pid
        for pid, (_, command) in processes.items()
        if PROVIDER.search(command) and not descends_from(pid, args.exclude_root)
    }
    # Node/wrapper and native clients often both match. Report only the root of
    # each matching provider subtree so counts describe sessions, not wrappers.
    roots = [pid for pid in matches if processes[pid][0] not in matches]
    for pid in sorted(roots):
        ppid, command = processes[pid]
        if "codex exec" in command:
            provider = "codex"
        elif "claude --print" in command:
            provider = "claude"
        elif "opencode" in command:
            provider = "opencode"
        else:
            provider = "kimi"
        print(f"{pid} {ppid} {provider}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
