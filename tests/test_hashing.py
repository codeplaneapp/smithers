"""Tests for hashing module."""

from pydantic import BaseModel

from smithers.hashing import (
    cache_key,
    canonical_json,
    code_hash,
    hash_bytes,
    hash_json,
    hash_string,
    input_hash,
    output_hash,
    runtime_hash,
    workflow_id,
)
from smithers.workflow import workflow


class SampleOutput(BaseModel):
    value: str
    count: int


class NestedOutput(BaseModel):
    data: SampleOutput
    tags: list[str]


class TestCanonicalJson:
    """Tests for canonical JSON serialization."""

    def test_simple_dict(self):
        result = canonical_json({"b": 2, "a": 1})
        # Keys should be sorted
        assert result == '{"a":1,"b":2}'

    def test_nested_dict(self):
        result = canonical_json({"outer": {"z": 1, "a": 2}})
        assert result == '{"outer":{"a":2,"z":1}}'

    def test_list_order_preserved(self):
        result = canonical_json([3, 1, 2])
        assert result == "[3,1,2]"

    def test_pydantic_model(self):
        model = SampleOutput(value="test", count=5)
        result = canonical_json(model)
        # Pydantic model should be serialized to dict
        assert '"value":"test"' in result
        assert '"count":5' in result

    def test_nested_pydantic_model(self):
        model = NestedOutput(
            data=SampleOutput(value="inner", count=10),
            tags=["a", "b"],
        )
        result = canonical_json(model)
        assert '"value":"inner"' in result
        assert '"tags":["a","b"]' in result

    def test_set_becomes_sorted_list(self):
        result = canonical_json({"items": {"c", "a", "b"}})
        # Sets should be sorted for determinism
        assert result == '{"items":["a","b","c"]}'

    def test_frozenset_becomes_sorted_list(self):
        result = canonical_json({"items": frozenset(["c", "a", "b"])})
        # Frozensets should be sorted for determinism, same as sets
        assert result == '{"items":["a","b","c"]}'

    def test_set_with_mixed_types(self):
        # Sets with mixed types (int and str) that can't be compared with '<'
        # should still be serializable and deterministic
        items = frozenset([3, "a", 1])  # type: ignore[arg-type]
        result1 = canonical_json({"items": items})
        result2 = canonical_json({"items": items})
        # Should be deterministic
        assert result1 == result2
        # Should contain all elements (order is by type, then value)
        assert "1" in result1
        assert "3" in result1
        assert '"a"' in result1

    def test_set_with_mixed_types_deterministic(self):
        # Same elements added in different order should produce same result
        items1 = frozenset([3, "a", 1])  # type: ignore[arg-type]
        items2 = frozenset(["a", 1, 3])  # type: ignore[arg-type]
        result1 = canonical_json({"items": items1})
        result2 = canonical_json({"items": items2})
        assert result1 == result2

    def test_bytes_hex_encoded(self):
        result = canonical_json({"data": b"\x00\xff"})
        assert result == '{"data":"00ff"}'

    def test_tuple_becomes_list(self):
        result = canonical_json({"coords": (1, 2, 3)})
        assert result == '{"coords":[1,2,3]}'

    def test_no_whitespace(self):
        result = canonical_json({"key": "value", "list": [1, 2]})
        assert " " not in result
        assert "\n" not in result


class TestHashFunctions:
    """Tests for hash functions."""

    def test_hash_bytes_deterministic(self):
        data = b"hello world"
        assert hash_bytes(data) == hash_bytes(data)

    def test_hash_bytes_different_for_different_input(self):
        assert hash_bytes(b"hello") != hash_bytes(b"world")

    def test_hash_string_deterministic(self):
        data = "hello world"
        assert hash_string(data) == hash_string(data)

    def test_hash_string_unicode(self):
        # Unicode should hash consistently
        data = "hello \u4e16\u754c"  # "hello 世界"
        hash1 = hash_string(data)
        hash2 = hash_string(data)
        assert hash1 == hash2

    def test_hash_json_deterministic(self):
        data = {"a": 1, "b": 2}
        assert hash_json(data) == hash_json(data)

    def test_hash_json_order_independent(self):
        # Different key orders should produce same hash
        assert hash_json({"a": 1, "b": 2}) == hash_json({"b": 2, "a": 1})

    def test_hash_json_pydantic_model(self):
        model = SampleOutput(value="test", count=5)
        hash1 = hash_json(model)
        hash2 = hash_json({"value": "test", "count": 5})
        assert hash1 == hash2


class TestWorkflowId:
    """Tests for workflow identity."""

    def test_workflow_id_format(self):
        @workflow
        async def my_workflow() -> SampleOutput:
            return SampleOutput(value="test", count=1)

        wf_id = workflow_id(my_workflow)
        # Should be module:qualname format
        assert ":" in wf_id
        assert "my_workflow" in wf_id

    def test_different_workflows_different_ids(self):
        @workflow
        async def workflow_a() -> SampleOutput:
            return SampleOutput(value="a", count=1)

        @workflow
        async def workflow_b() -> NestedOutput:
            return NestedOutput(
                data=SampleOutput(value="b", count=2),
                tags=["x"],
            )

        assert workflow_id(workflow_a) != workflow_id(workflow_b)


class TestCodeHash:
    """Tests for code hashing."""

    def test_code_hash_deterministic(self):
        @workflow
        async def stable() -> SampleOutput:
            return SampleOutput(value="stable", count=1)

        hash1 = code_hash(stable)
        hash2 = code_hash(stable)
        assert hash1 == hash2

    def test_different_code_different_hash(self):
        @workflow
        async def version1() -> SampleOutput:
            return SampleOutput(value="v1", count=1)

        @workflow
        async def version2() -> NestedOutput:
            return NestedOutput(
                data=SampleOutput(value="v2", count=2),
                tags=["tag"],
            )

        assert code_hash(version1) != code_hash(version2)

    def test_code_hash_cached(self):
        @workflow
        async def cached() -> SampleOutput:
            return SampleOutput(value="cached", count=1)

        first = code_hash(cached)
        assert code_hash(cached) == first


class TestInputHash:
    """Tests for input hashing."""

    def test_input_hash_deterministic(self):
        inputs = {"param1": "value1", "param2": 42}
        assert input_hash(inputs) == input_hash(inputs)

    def test_input_hash_order_independent(self):
        inputs1 = {"a": 1, "b": 2}
        inputs2 = {"b": 2, "a": 1}
        assert input_hash(inputs1) == input_hash(inputs2)

    def test_input_hash_with_pydantic(self):
        model = SampleOutput(value="test", count=5)
        inputs1 = {"data": model}
        inputs2 = {"data": {"value": "test", "count": 5}}
        assert input_hash(inputs1) == input_hash(inputs2)

    def test_different_inputs_different_hash(self):
        inputs1 = {"value": "one"}
        inputs2 = {"value": "two"}
        assert input_hash(inputs1) != input_hash(inputs2)


class TestRuntimeHash:
    """Tests for runtime configuration hashing."""

    def test_runtime_hash_includes_version(self):
        # Runtime hash should be deterministic for same config
        hash1 = runtime_hash()
        hash2 = runtime_hash()
        assert hash1 == hash2

    def test_runtime_hash_differs_with_model(self):
        hash1 = runtime_hash(model="claude-3-opus-20240229")
        hash2 = runtime_hash(model="claude-3-sonnet-20240229")
        assert hash1 != hash2

    def test_runtime_hash_none_model_consistent(self):
        hash1 = runtime_hash(model=None)
        hash2 = runtime_hash()
        assert hash1 == hash2


class TestCacheKey:
    """Tests for cache key computation."""

    def test_cache_key_deterministic(self):
        @workflow
        async def cached() -> SampleOutput:
            return SampleOutput(value="cached", count=1)

        inputs = {"param": "value"}
        key1 = cache_key(cached, inputs)
        key2 = cache_key(cached, inputs)
        assert key1 == key2

    def test_cache_key_different_inputs(self):
        @workflow
        async def cached() -> SampleOutput:
            return SampleOutput(value="cached", count=1)

        key1 = cache_key(cached, {"param": "value1"})
        key2 = cache_key(cached, {"param": "value2"})
        assert key1 != key2

    def test_cache_key_different_workflows(self):
        @workflow
        async def workflow1() -> SampleOutput:
            return SampleOutput(value="one", count=1)

        @workflow
        async def workflow2() -> NestedOutput:
            return NestedOutput(
                data=SampleOutput(value="two", count=2),
                tags=["x"],
            )

        key1 = cache_key(workflow1, {})
        key2 = cache_key(workflow2, {})
        assert key1 != key2

    def test_cache_key_with_model(self):
        @workflow
        async def cached() -> SampleOutput:
            return SampleOutput(value="cached", count=1)

        key1 = cache_key(cached, {}, model="claude-3-opus")
        key2 = cache_key(cached, {}, model="claude-3-sonnet")
        assert key1 != key2

    def test_cache_key_is_valid_hex(self):
        @workflow
        async def cached() -> SampleOutput:
            return SampleOutput(value="cached", count=1)

        key = cache_key(cached, {})
        # Should be 64 hex characters (SHA-256)
        assert len(key) == 64
        assert all(c in "0123456789abcdef" for c in key)


class TestOutputHash:
    """Tests for output hashing."""

    def test_output_hash_pydantic_model(self):
        output = SampleOutput(value="result", count=42)
        h = output_hash(output)
        assert len(h) == 64  # SHA-256

    def test_output_hash_deterministic(self):
        output = SampleOutput(value="result", count=42)
        assert output_hash(output) == output_hash(output)

    def test_output_hash_dict_equivalent(self):
        model = SampleOutput(value="result", count=42)
        dict_output = {"value": "result", "count": 42}
        assert output_hash(model) == output_hash(dict_output)

    def test_different_outputs_different_hash(self):
        output1 = SampleOutput(value="one", count=1)
        output2 = SampleOutput(value="two", count=2)
        assert output_hash(output1) != output_hash(output2)
