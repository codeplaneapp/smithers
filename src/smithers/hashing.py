"""Canonical JSON hashing primitives.

This module implements content-addressed hashing for the Smithers cache.
Every node run is content-addressed:
    cache_key = H(workflow_id + code_hash + input_hash + runtime_hash)

This ensures:
- Deterministic cache keys across runs
- Proper invalidation when code or inputs change
- Version-aware caching (runtime_hash includes smithers version)
"""

from __future__ import annotations

import hashlib
import inspect
import json
import weakref
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

# Version is defined here to avoid circular import with __init__.py
_SMITHERS_VERSION = "0.1.0"

if TYPE_CHECKING:
    from smithers.workflow import Workflow


_CODE_HASH_CACHE: "weakref.WeakKeyDictionary[object, str]" = weakref.WeakKeyDictionary()

# Cache runtime hashes by model name to avoid repeated computation.
# The runtime hash only depends on the smithers version and model name,
# both of which are typically a small, fixed set of values.
_RUNTIME_HASH_CACHE: dict[str | None, str] = {}


def canonical_json(value: Any) -> str:
    """
    Serialize a value to canonical JSON for hashing.

    Canonical JSON ensures deterministic serialization:
    - Keys are sorted alphabetically
    - No whitespace
    - Unicode characters are escaped consistently
    - Pydantic models are dumped to JSON-compatible dicts

    Args:
        value: Any JSON-serializable value or Pydantic model

    Returns:
        Canonical JSON string
    """
    normalized = _normalize_value(value)
    return json.dumps(normalized, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def hash_bytes(data: bytes) -> str:
    """
    Compute SHA-256 hash of bytes.

    Args:
        data: Bytes to hash

    Returns:
        Hex-encoded SHA-256 hash
    """
    return hashlib.sha256(data).hexdigest()


def hash_string(data: str) -> str:
    """
    Compute SHA-256 hash of a string.

    Args:
        data: String to hash (encoded as UTF-8)

    Returns:
        Hex-encoded SHA-256 hash
    """
    return hash_bytes(data.encode("utf-8"))


def hash_json(value: Any) -> str:
    """
    Compute hash of a value via canonical JSON.

    Args:
        value: Any JSON-serializable value or Pydantic model

    Returns:
        Hex-encoded SHA-256 hash of canonical JSON
    """
    return hash_string(canonical_json(value))


def workflow_id(wf: Workflow) -> str:
    """
    Compute stable workflow identity.

    Identity is: module:qualname

    Args:
        wf: Workflow instance

    Returns:
        Workflow identity string
    """
    module = getattr(wf.fn, "__module__", "__main__")
    qualname = getattr(wf.fn, "__qualname__", wf.fn.__name__)
    return f"{module}:{qualname}"


def code_hash(wf: Workflow) -> str:
    """
    Compute hash of workflow source code.

    This allows cache invalidation when workflow code changes.
    Falls back to function repr if source is unavailable.

    Args:
        wf: Workflow instance

    Returns:
        Hex-encoded SHA-256 hash of source code
    """
    cached = _CODE_HASH_CACHE.get(wf.fn)
    if cached is not None:
        return cached
    try:
        source = inspect.getsource(wf.fn)
    except (OSError, TypeError):
        # Source not available (e.g., dynamically generated)
        source = repr(wf.fn)
    digest = hash_string(source)
    _CODE_HASH_CACHE[wf.fn] = digest
    return digest


def input_hash(inputs: dict[str, Any]) -> str:
    """
    Compute hash of workflow inputs.

    Inputs are serialized to canonical JSON before hashing.

    Args:
        inputs: Dictionary of input parameter names to values

    Returns:
        Hex-encoded SHA-256 hash of canonical JSON inputs
    """
    return hash_json(inputs)


def runtime_hash(*, model: str | None = None) -> str:
    """
    Compute hash of runtime configuration.

    Includes:
    - Smithers version
    - LLM model name (if provided)

    Results are cached by model name since the smithers version is constant
    and model names are typically a small, fixed set of values.

    Args:
        model: Optional LLM model name

    Returns:
        Hex-encoded SHA-256 hash of runtime config
    """
    cached = _RUNTIME_HASH_CACHE.get(model)
    if cached is not None:
        return cached

    config = {
        "smithers_version": _SMITHERS_VERSION,
        "model": model,
    }
    result = hash_json(config)
    _RUNTIME_HASH_CACHE[model] = result
    return result


def cache_key(
    wf: Workflow,
    inputs: dict[str, Any],
    *,
    model: str | None = None,
) -> str:
    """
    Compute content-addressed cache key for a workflow execution.

    cache_key = H(workflow_id + code_hash + input_hash + runtime_hash)

    Args:
        wf: Workflow instance
        inputs: Dictionary of input parameter names to values
        model: Optional LLM model name for runtime hash

    Returns:
        Hex-encoded SHA-256 cache key
    """
    components = {
        "workflow_id": workflow_id(wf),
        "code_hash": code_hash(wf),
        "input_hash": input_hash(inputs),
        "runtime_hash": runtime_hash(model=model),
    }
    return hash_json(components)


def output_hash(output: Any) -> str:
    """
    Compute hash of a workflow output.

    Used for cache integrity verification.

    Args:
        output: Workflow output (typically a Pydantic model)

    Returns:
        Hex-encoded SHA-256 hash of canonical JSON output
    """
    return hash_json(output)


def _sort_key(v: Any) -> tuple[str, str]:
    """
    Generate a deterministic sort key for any JSON-serializable value.

    Sorts by (type_name, json_repr) to handle mixed types deterministically.
    This allows sorting collections containing different types (e.g., int and str)
    that would otherwise raise TypeError when compared with '<'.

    Args:
        v: A normalized (JSON-serializable) value

    Returns:
        Tuple of (type_name, json_representation) for deterministic ordering
    """
    type_name = type(v).__name__
    # Use JSON serialization for deterministic string representation
    json_repr = json.dumps(v, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
    return (type_name, json_repr)


def _normalize_value(value: Any) -> Any:
    """
    Normalize a value for canonical JSON serialization.

    - Pydantic models -> dict via model_dump(mode="json")
    - dicts -> recursively normalized with string keys
    - lists/tuples/sets -> recursively normalized lists
    - Other values -> passed through (must be JSON-serializable)

    Args:
        value: Value to normalize

    Returns:
        JSON-serializable normalized value
    """
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return {str(k): _normalize_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalize_value(v) for v in value]
    if isinstance(value, (set, frozenset)):
        # Sets and frozensets are converted to sorted lists for determinism.
        # Use _sort_key to handle mixed types that can't be directly compared.
        normalized = [_normalize_value(v) for v in value]
        return sorted(normalized, key=_sort_key)
    if isinstance(value, bytes):
        # Bytes are hex-encoded
        return value.hex()
    return value
