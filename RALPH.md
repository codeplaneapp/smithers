# RALPH.md - Autonomous Agent Instructions

You are an autonomous agent working on the Smithers codebase. Follow these instructions precisely.

## Your Mission

1. **Read Documentation First** - Start by reading CLAUDE.md, ARCHITECTURE.md, and README.md to understand the project
2. **Self-Discover Work** - Based on the docs and codebase state, identify the single most impactful task you can complete
3. **Focus on Python Only** - This repo has non-Python code; ignore it entirely
4. **One Task, Done Well** - Complete exactly ONE meaningful task, then stop

## Development Philosophy

### Test-Driven Development (TDD)
- A task is **NOT complete** without a passing test proving it works
- Write tests first when adding new functionality
- Run tests before committing: `uv run pytest`

### Always Green
- The test suite must pass at all times
- If you encounter ANY failing tests (even from previous agents), fix them IMMEDIATELY
- Never commit code that breaks tests

### Atomic Commits
- Use emoji conventional commits: `<emoji> <type>(<scope>): <message>`
- Examples:
  - `✨ feat(core): add retry logic to executor`
  - `🐛 fix(store): handle missing cache entries`
  - `✅ test(graph): add cycle detection tests`
  - `♻️ refactor(llm): simplify provider interface`
  - `📝 docs(api): update workflow examples`

## Your Focus Area

You have been assigned a specific focus. Prioritize work in this area while still fixing any broken tests or critical issues you encounter.

### Focus Areas (Cycle 1-10)

1. **TESTING** - Add missing tests, improve coverage, ensure edge cases are handled
2. **CODE_REVIEW** - Review existing code for bugs, anti-patterns, and improvements
3. **TYPE_SAFETY** - Improve type hints, fix pyright errors, add generic types where helpful
4. **ERROR_HANDLING** - Improve error messages, add proper exception types, handle edge cases
5. **API_POLISH** - Clean up public API, ensure consistent naming, improve usability
6. **PERFORMANCE** - Profile and optimize slow paths, reduce unnecessary allocations
7. **REFACTORING** - Simplify complex functions, reduce duplication, improve readability
8. **DOCUMENTATION** - Fix inaccurate docstrings, add missing documentation, update examples
9. **BUG_HUNTING** - Actively search for bugs, edge cases, and race conditions
10. **FEATURE_COMPLETION** - Find incomplete features and finish them properly

---

## Current Focus: `{{FOCUS}}`

Prioritize `{{FOCUS}}` tasks, but always:
- Fix failing tests first
- Never leave the codebase in a broken state
- Complete one meaningful task

## Workflow

```
1. Read docs (CLAUDE.md, ARCHITECTURE.md, README.md)
2. Run tests to check current state: uv run pytest
3. If tests fail -> fix them first
4. Identify ONE task matching your focus
5. Implement with TDD
6. Run tests to verify: uv run pytest
7. Run type check: uv run pyright
8. Commit with emoji conventional commit
9. Done - let the next agent continue
```

## Commands Reference

```bash
uv run pytest                    # Run all tests
uv run pytest tests/test_X.py    # Run specific test file
uv run pyright                   # Type check
uv run ruff check .              # Lint
uv run ruff format .             # Format
```

## Running the Ralph Loop

The ralph loop is an autonomous system that runs agents in a continuous relay:

```bash
# Start in foreground (for debugging)
./scripts/ralph-loop.py

# Start in background
nohup ./scripts/ralph-loop.py > logs/ralph-loop.out 2>&1 &

# Check logs
tail -f logs/ralph-loop.log

# Stop the loop
pkill -f ralph-loop.py
```

## Remember

- You are part of a relay team - do your part well
- Leave the codebase better than you found it
- Quality over quantity
- One task, tested, reviewed, committed
