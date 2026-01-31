#!/usr/bin/env python3
"""
Ralph Loop - Autonomous Agent Relay System

Runs a continuous loop of Codex agents, each with a different focus area.
Agents self-discover work, complete one task with TDD, get reviewed, and commit.
"""

import subprocess
import sys
import time
import os
from datetime import datetime
from pathlib import Path

# Project root
PROJECT_ROOT = Path(__file__).parent.parent

# 10 Focus areas that rotate
FOCUSES = [
    "TESTING",  # Add missing tests, improve coverage
    "CODE_REVIEW",  # Review code for bugs and anti-patterns
    "TYPE_SAFETY",  # Improve type hints, fix pyright errors
    "ERROR_HANDLING",  # Better error messages, proper exceptions
    "API_POLISH",  # Clean up public API, consistent naming
    "PERFORMANCE",  # Profile and optimize slow paths
    "REFACTORING",  # Simplify complex code, reduce duplication
    "DOCUMENTATION",  # Fix docstrings, add missing docs
    "BUG_HUNTING",  # Search for bugs and edge cases
    "FEATURE_COMPLETION",  # Find and finish incomplete features
]

# The prompt template for each agent
PROMPT_TEMPLATE = """You are an autonomous agent working on the Smithers codebase.

## Your Mission

1. **Read Documentation First** - Read CLAUDE.md, ARCHITECTURE.md, and README.md
2. **Check Test Status** - Run `uv run pytest` to see current state
3. **Fix Any Failures First** - If tests fail, fix them before anything else
4. **Self-Discover Work** - Based on your focus area, identify the single most impactful task
5. **Complete ONE Task** - Do one meaningful thing, tested and working
6. **Commit** - Use emoji conventional commit format

## Your Focus: {focus}

Focus descriptions:
- TESTING: Add missing tests, improve coverage, ensure edge cases handled
- CODE_REVIEW: Review code for bugs, anti-patterns, improvements
- TYPE_SAFETY: Improve type hints, fix pyright errors, add generics
- ERROR_HANDLING: Better error messages, proper exception types, edge cases
- API_POLISH: Clean public API, consistent naming, improve usability
- PERFORMANCE: Profile slow paths, reduce allocations, optimize
- REFACTORING: Simplify complex functions, reduce duplication, readability
- DOCUMENTATION: Fix docstrings, add missing docs, update examples
- BUG_HUNTING: Search for bugs, edge cases, race conditions
- FEATURE_COMPLETION: Find incomplete features and finish them

## Development Rules

### Test-Driven Development
- A task is NOT complete without a passing test
- Run tests before committing: `uv run pytest`

### Always Green
- Test suite must pass at all times
- Fix failing tests IMMEDIATELY if found
- Never commit code that breaks tests

### Commit Format
Use emoji conventional commits:
- ✨ feat(scope): add new feature
- 🐛 fix(scope): fix a bug
- ✅ test(scope): add tests
- ♻️ refactor(scope): refactor code
- 📝 docs(scope): documentation
- 🔧 chore(scope): maintenance

## Workflow

1. Read docs: CLAUDE.md, ARCHITECTURE.md, README.md
2. Run: `uv run pytest` - check current state
3. If tests fail -> FIX THEM FIRST
4. Identify ONE task matching your focus: {focus}
5. Implement with TDD
6. Run: `uv run pytest` to verify
7. Run: `uv run pyright` for type checking  
8. Commit with emoji conventional commit
9. Done - stop after ONE meaningful task

## Commands

```bash
uv run pytest                    # Run all tests
uv run pytest tests/test_X.py    # Run specific test
uv run pyright                   # Type check
uv run ruff check .              # Lint
uv run ruff format .             # Format
```

## Important

- Focus on Python code only (ignore Swift, Zig, etc.)
- Complete exactly ONE task, then stop
- Quality over quantity
- Leave the codebase better than you found it

Now begin. Read the docs, check tests, find your task, complete it, commit it.
"""

LOG_FILE = PROJECT_ROOT / "logs" / "ralph-loop.log"


def log(message: str) -> None:
    """Log a message with timestamp."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_line = f"[{timestamp}] {message}"
    print(log_line)

    # Also append to log file
    LOG_FILE.parent.mkdir(exist_ok=True)
    with open(LOG_FILE, "a") as f:
        f.write(log_line + "\n")


def run_codex_agent(focus: str, cycle: int) -> bool:
    """Run a Codex agent with the given focus. Returns True if successful."""
    prompt = PROMPT_TEMPLATE.format(focus=focus)

    log(f"=== Cycle {cycle} | Focus: {focus} ===")
    log(f"Starting Codex agent...")

    try:
        # Run codex exec with the prompt (non-interactive mode)
        # Use --dangerously-bypass-approvals-and-sandbox for full autonomous operation
        result = subprocess.run(
            [
                "codex",
                "exec",
                "--dangerously-bypass-approvals-and-sandbox",
                prompt,
            ],
            cwd=PROJECT_ROOT,
            capture_output=False,  # Let output stream to terminal
            timeout=1800,  # 30 minute timeout per agent
        )

        if result.returncode == 0:
            log(f"✅ Agent completed successfully (focus: {focus})")
            return True
        else:
            log(f"⚠️ Agent exited with code {result.returncode} (focus: {focus})")
            return False

    except subprocess.TimeoutExpired:
        log(f"⏰ Agent timed out after 30 minutes (focus: {focus})")
        return False
    except FileNotFoundError:
        log("❌ Error: 'codex' command not found. Is it installed?")
        return False
    except Exception as e:
        log(f"❌ Error running agent: {e}")
        return False


def verify_tests_pass() -> bool:
    """Quick check that tests are passing before starting."""
    log("Verifying test suite...")
    result = subprocess.run(
        ["uv", "run", "pytest", "-x", "-q"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode == 0:
        log("✅ Tests passing")
        return True
    else:
        log(f"❌ Tests failing:\n{result.stdout}\n{result.stderr}")
        return False


def main():
    """Main ralph loop."""
    log("=" * 60)
    log("🚀 Ralph Loop Starting")
    log(f"Project: {PROJECT_ROOT}")
    log(f"Focuses: {', '.join(FOCUSES)}")
    log("=" * 60)

    # Initial test verification
    if not verify_tests_pass():
        log("⚠️ Tests are failing - first agent will focus on fixing them")

    cycle = 0
    focus_index = 0
    consecutive_failures = 0
    max_consecutive_failures = 3

    while True:
        cycle += 1
        focus = FOCUSES[focus_index]

        log("")
        log(f"{'=' * 60}")
        log(f"Cycle {cycle} starting (focus: {focus})")
        log(f"{'=' * 60}")

        success = run_codex_agent(focus, cycle)

        if success:
            consecutive_failures = 0
        else:
            consecutive_failures += 1
            if consecutive_failures >= max_consecutive_failures:
                log(f"⚠️ {max_consecutive_failures} consecutive failures - pausing for 5 minutes")
                time.sleep(300)
                consecutive_failures = 0

        # Rotate to next focus
        focus_index = (focus_index + 1) % len(FOCUSES)

        # Sleep between runs
        sleep_seconds = 10
        log(f"💤 Sleeping {sleep_seconds} seconds before next cycle...")
        time.sleep(sleep_seconds)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("\n🛑 Ralph Loop stopped by user")
        sys.exit(0)
