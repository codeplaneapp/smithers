# Bug Report: Potential Race Condition in ExecutionContext

**Severity**: Medium (Low impact currently due to Python GIL, High impact with free-threaded Python)

**Status**: Documented, Test Added

**Discovered**: 2026-01-31

## Summary

The `ExecutionContext` class in `src/smithers/executor.py` contains shared mutable state (`outputs`, `statuses`, `errors`, `results`) that is accessed and modified concurrently by multiple async tasks during parallel workflow execution. While Python's Global Interpreter Lock (GIL) currently provides some protection for simple dictionary operations, this design is not thread-safe and could cause issues with:

1. **Free-threaded Python** (PEP 703, Python 3.13+) where the GIL can be disabled
2. **Complex dictionary operations** that aren't atomic
3. **Future refactorings** that might introduce more complex state updates

## Location

**File**: `src/smithers/executor.py`

**Lines**: 465-477 (ExecutionContext class definition)

**Concurrent Access Points**:
- Line 130: `ctx.outputs[name] = output`
- Lines 585-586: `ctx.outputs[name] = cached_value; ctx.statuses[name] = "cached"`
- Lines 698-699: `ctx.outputs[name] = validated; ctx.statuses[name] = "success"`
- Lines 758-759: `ctx.statuses[name] = "failed"; ctx.errors[name] = exc`
- Lines 776-777: `ctx.statuses[name] = "failed"; ctx.errors[name] = exc`
- Line 132: `ctx.results.append(...)`

**Parallel Execution Sites**:
- Line 970: `tasks = [asyncio.create_task(run_node_with_semaphore_main(name)) for name in level]`
- Line 989: `await asyncio.gather(*tasks)`
- Line 1005: `await asyncio.gather(*tasks, return_exceptions=False)`

## Code

```python
@dataclass
class ExecutionContext:
    """Context for a single graph execution."""

    graph: WorkflowGraph
    run_id: str
    store: SqliteStore | None = None
    cache: Cache | None = None
    outputs: dict[str, Any] = field(default_factory=dict)  # ← Concurrent write access
    statuses: dict[str, str] = field(default_factory=dict)  # ← Concurrent write access
    errors: dict[str, BaseException] = field(default_factory=dict)  # ← Concurrent write access
    results: list[WorkflowResult] = field(default_factory=list)  # ← Concurrent append
    approvals: list[ApprovalRecord] = field(default_factory=list)
```

## Problem Analysis

### Current Protection

Python's GIL ensures that:
- Simple dict operations like `dict[key] = value` are atomic
- List `append()` operations are atomic

### Potential Issues

1. **Non-atomic compound operations**:
   ```python
   # Lines 585-586 - two separate dict writes
   ctx.outputs[name] = cached_value
   ctx.statuses[name] = "cached"
   ```
   If task A and task B both execute between these lines, the state could become inconsistent.

2. **Dictionary resize during iteration**:
   While we don't iterate during writes in the current code, dict resizing during concurrent writes could theoretically cause issues.

3. **Free-threaded Python**:
   With PEP 703's free-threaded mode (opt-in starting Python 3.13), the GIL can be disabled, removing all atomicity guarantees.

4. **Memory visibility**:
   Even with the GIL, there are edge cases around memory visibility across async tasks that could theoretically cause stale reads.

## Reproduction

A stress test has been added in `tests/test_executor.py::TestExecutorApprovals::test_parallel_execution_stress`.

The test creates a graph with 5 workflows executing in parallel (in the same level), each modifying the shared `ExecutionContext` state concurrently. The test runs 20 iterations to stress-test the concurrent access patterns.

**Current Result**: Test passes ✓ (GIL provides protection)

**Expected Future Behavior**: May fail intermittently with free-threaded Python or under heavy load.

## Recommended Fix

Add an `asyncio.Lock` to protect concurrent access to shared state:

```python
@dataclass
class ExecutionContext:
    """Context for a single graph execution."""

    graph: WorkflowGraph
    run_id: str
    store: SqliteStore | None = None
    cache: Cache | None = None
    outputs: dict[str, Any] = field(default_factory=dict)
    statuses: dict[str, str] = field(default_factory=dict)
    errors: dict[str, BaseException] = field(default_factory=dict)
    results: list[WorkflowResult] = field(default_factory=list)
    approvals: list[ApprovalRecord] = field(default_factory=list)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)  # ← Add lock

    async def set_output(self, name: str, output: Any, status: str) -> None:
        """Thread-safe output setting."""
        async with self._lock:
            self.outputs[name] = output
            self.statuses[name] = status

    async def record_error(self, name: str, exc: BaseException) -> None:
        """Thread-safe error recording."""
        async with self._lock:
            self.errors[name] = exc
            self.statuses[name] = "failed"

    async def append_result(self, result: WorkflowResult) -> None:
        """Thread-safe result appending."""
        async with self._lock:
            self.results.append(result)
```

Then update all access sites to use these methods instead of direct dictionary access.

## Impact Assessment

**Current Impact**: **Low**
- Python's GIL provides protection for most operations
- No reports of issues in production
- Test coverage is good

**Future Impact**: **High**
- Free-threaded Python adoption will remove GIL protection
- Complex state updates could expose latent bugs
- Subtle corruption could be hard to debug

## Priority

**Recommended Priority**: P2 (Medium)

Fix before:
- Enabling free-threaded Python support
- Adding more complex state tracking
- Production deployment at scale

## Related Issues

- Python PEP 703: Making the Global Interpreter Lock Optional
- asyncio best practices for shared state
- Thread-safety in async Python applications

## Test Coverage

✓ Stress test added: `tests/test_executor.py::TestExecutorApprovals::test_parallel_execution_stress`
- Tests parallel execution with 5 concurrent workflows
- Runs 20 iterations to stress concurrent access
- Verifies outputs, statuses, and results are correct
- Currently passes with GIL protection

## Notes

This bug was discovered during a systematic code review focused on race conditions in async code. While the current implementation works correctly due to Python's GIL, documenting this potential issue helps ensure the codebase remains robust as Python evolves and as the project scales.
