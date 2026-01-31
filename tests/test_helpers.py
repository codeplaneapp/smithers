"""Tests for the testing helpers module."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from smithers import workflow
from smithers.testing.helpers import (
    WorkflowTestCase,
    assert_graph_has_dependency,
    assert_graph_has_nodes,
    assert_graph_is_dag,
    assert_graph_levels,
    assert_workflow_depends_on,
    assert_workflow_produces,
    create_test_graph,
    mock_output,
)
from smithers.workflow import clear_registry


# Test models
class AnalysisOutput(BaseModel):
    files: list[str]
    summary: str


class ImplementOutput(BaseModel):
    changed_files: list[str]


class TestOutput(BaseModel):
    passed: bool
    count: int = 0


class DeployOutput(BaseModel):
    url: str


@pytest.fixture(autouse=True)
def clean_registry():
    """Clear the workflow registry before each test."""
    clear_registry()
    yield
    clear_registry()


class TestAssertGraphIsDag:
    """Tests for assert_graph_is_dag."""

    def test_valid_dag(self) -> None:
        """Test that a valid DAG passes the assertion."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        @workflow
        async def implement(analysis: AnalysisOutput) -> ImplementOutput:
            return ImplementOutput(changed_files=[])

        graph = create_test_graph(analyze, implement, target=implement)
        assert_graph_is_dag(graph)  # Should not raise


class TestAssertGraphHasNodes:
    """Tests for assert_graph_has_nodes."""

    def test_all_nodes_present(self) -> None:
        """Test assertion passes when all nodes are present."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        @workflow
        async def implement(analysis: AnalysisOutput) -> ImplementOutput:
            return ImplementOutput(changed_files=[])

        graph = create_test_graph(analyze, implement, target=implement)
        assert_graph_has_nodes(graph, "analyze", "implement")

    def test_missing_node_raises(self) -> None:
        """Test assertion fails when a node is missing."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        graph = create_test_graph(analyze)
        with pytest.raises(AssertionError, match="missing expected nodes"):
            assert_graph_has_nodes(graph, "analyze", "implement")


class TestAssertGraphHasDependency:
    """Tests for assert_graph_has_dependency."""

    def test_dependency_exists(self) -> None:
        """Test assertion passes when dependency exists."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        @workflow
        async def implement(analysis: AnalysisOutput) -> ImplementOutput:
            return ImplementOutput(changed_files=[])

        graph = create_test_graph(analyze, implement, target=implement)
        assert_graph_has_dependency(graph, "analyze", "implement")

    def test_missing_dependency_raises(self) -> None:
        """Test assertion fails when dependency is missing."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        @workflow
        async def implement(analysis: AnalysisOutput) -> ImplementOutput:
            return ImplementOutput(changed_files=[])

        graph = create_test_graph(analyze, implement, target=implement)
        with pytest.raises(AssertionError, match="to depend on"):
            assert_graph_has_dependency(graph, "implement", "analyze")  # Wrong direction

    def test_nonexistent_node_raises(self) -> None:
        """Test assertion fails when to_node doesn't exist."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        graph = create_test_graph(analyze)
        with pytest.raises(AssertionError, match="not found"):
            assert_graph_has_dependency(graph, "analyze", "nonexistent")


class TestAssertGraphLevels:
    """Tests for assert_graph_levels."""

    def test_correct_levels(self) -> None:
        """Test assertion passes with correct level structure."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        @workflow
        async def implement(analysis: AnalysisOutput) -> ImplementOutput:
            return ImplementOutput(changed_files=[])

        graph = create_test_graph(analyze, implement, target=implement)
        assert_graph_levels(graph, ["analyze"], ["implement"])

    def test_wrong_level_count_raises(self) -> None:
        """Test assertion fails with wrong level count."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        graph = create_test_graph(analyze)
        with pytest.raises(AssertionError, match="Expected 2 levels"):
            assert_graph_levels(graph, ["analyze"], ["extra"])

    def test_wrong_level_contents_raises(self) -> None:
        """Test assertion fails with wrong level contents."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        graph = create_test_graph(analyze)
        with pytest.raises(AssertionError, match="Level 0 mismatch"):
            assert_graph_levels(graph, ["wrong_name"])


class TestAssertWorkflowProduces:
    """Tests for assert_workflow_produces."""

    def test_correct_output_type(self) -> None:
        """Test assertion passes with correct output type."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        assert_workflow_produces(analyze, AnalysisOutput)

    def test_wrong_output_type_raises(self) -> None:
        """Test assertion fails with wrong output type."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        with pytest.raises(AssertionError, match="produces AnalysisOutput"):
            assert_workflow_produces(analyze, ImplementOutput)


class TestAssertWorkflowDependsOn:
    """Tests for assert_workflow_depends_on."""

    def test_correct_dependencies(self) -> None:
        """Test assertion passes with correct dependencies."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        @workflow
        async def implement(analysis: AnalysisOutput) -> ImplementOutput:
            return ImplementOutput(changed_files=[])

        assert_workflow_depends_on(implement, AnalysisOutput)

    def test_missing_dependency_raises(self) -> None:
        """Test assertion fails when dependency is missing."""

        @workflow
        async def standalone() -> ImplementOutput:
            return ImplementOutput(changed_files=[])

        with pytest.raises(AssertionError, match="missing expected dependencies"):
            assert_workflow_depends_on(standalone, AnalysisOutput)


class TestMockOutput:
    """Tests for mock_output."""

    def test_with_all_fields(self) -> None:
        """Test creating a mock with all fields specified."""
        output = mock_output(
            AnalysisOutput,
            files=["a.py", "b.py"],
            summary="Test summary",
        )
        assert output.files == ["a.py", "b.py"]
        assert output.summary == "Test summary"

    def test_with_some_fields(self) -> None:
        """Test creating a mock with some fields specified."""
        output = mock_output(AnalysisOutput, files=["a.py"])
        assert output.files == ["a.py"]
        assert isinstance(output.summary, str)  # Auto-generated

    def test_with_defaults(self) -> None:
        """Test that defaults are used when available."""
        output = mock_output(TestOutput, passed=True)
        assert output.passed is True
        assert output.count == 0  # Default value

    def test_auto_generates_list(self) -> None:
        """Test that lists are auto-generated as empty."""
        output = mock_output(AnalysisOutput, summary="Test")
        assert output.files == []


class TestCreateTestGraph:
    """Tests for create_test_graph."""

    def test_single_workflow(self) -> None:
        """Test creating a graph with a single workflow."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        graph = create_test_graph(analyze)
        assert "analyze" in graph.nodes
        assert graph.root == "analyze"

    def test_multiple_workflows(self) -> None:
        """Test creating a graph with multiple workflows."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        @workflow
        async def implement(analysis: AnalysisOutput) -> ImplementOutput:
            return ImplementOutput(changed_files=[])

        graph = create_test_graph(analyze, implement)
        assert "analyze" in graph.nodes
        assert "implement" in graph.nodes
        assert graph.root == "implement"  # Last workflow

    def test_explicit_target(self) -> None:
        """Test creating a graph with explicit target."""

        @workflow
        async def analyze() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        @workflow
        async def implement(analysis: AnalysisOutput) -> ImplementOutput:
            return ImplementOutput(changed_files=[])

        graph = create_test_graph(analyze, implement, target=analyze)
        assert graph.root == "analyze"


class TestWorkflowTestCase:
    """Tests for WorkflowTestCase base class."""

    def test_create_fake_llm(self) -> None:
        """Test creating a fake LLM provider."""
        tc = WorkflowTestCase()
        fake = tc.create_fake_llm([{"files": ["a.py"], "summary": "Test"}])
        assert len(fake.responses) == 1

    def test_create_fake_llm_by_type(self) -> None:
        """Test creating a fake LLM provider with type-based responses."""
        tc = WorkflowTestCase()
        fake = tc.create_fake_llm_by_type(
            {
                AnalysisOutput: {"files": ["a.py"], "summary": "Test"},
            }
        )
        assert AnalysisOutput in fake.responses_by_type

    def test_use_fake_context_manager(self) -> None:
        """Test using the fake context manager."""
        tc = WorkflowTestCase()
        fake = tc.create_fake_llm([{"files": [], "summary": ""}])
        with tc.use_fake(fake):
            from smithers.testing.fakes import get_fake_llm_provider

            assert get_fake_llm_provider() is fake

    def test_use_runtime_context_manager(self) -> None:
        """Test using the runtime context manager."""
        tc = WorkflowTestCase()
        fake = tc.create_fake_llm([{"files": [], "summary": ""}])
        with tc.use_runtime(llm=fake):
            from smithers.testing.fakes import get_fake_llm_provider

            assert get_fake_llm_provider() is fake


class TestWorkflowCallCount:
    """Tests for workflow_call_count."""

    @pytest.mark.asyncio
    async def test_counts_workflow_calls(self) -> None:
        """Test that workflow_call_count correctly counts invocations."""
        from smithers.testing.helpers import workflow_call_count

        @workflow
        async def counter_workflow() -> AnalysisOutput:
            return AnalysisOutput(files=["test.py"], summary="Test")

        count = workflow_call_count(counter_workflow)

        assert count() == 0

        # Call the workflow
        await counter_workflow()
        assert count() == 1

        # Call again
        await counter_workflow()
        assert count() == 2

    @pytest.mark.asyncio
    async def test_counts_workflow_with_args(self) -> None:
        """Test counting workflows that take arguments."""
        from smithers.testing.helpers import workflow_call_count

        @workflow(register=False)
        async def workflow_with_args(data: str) -> AnalysisOutput:
            return AnalysisOutput(files=[data], summary="Processed")

        count = workflow_call_count(workflow_with_args)

        await workflow_with_args(data="file1.py")
        await workflow_with_args(data="file2.py")

        assert count() == 2

    @pytest.mark.asyncio
    async def test_counts_workflow_with_dependencies(self) -> None:
        """Test counting workflows that have dependencies."""
        from smithers.testing.helpers import workflow_call_count

        @workflow
        async def producer_for_count() -> AnalysisOutput:
            return AnalysisOutput(files=["src.py"], summary="Source")

        @workflow
        async def consumer_for_count(analysis: AnalysisOutput) -> ImplementOutput:
            return ImplementOutput(changed_files=analysis.files)

        producer_count = workflow_call_count(producer_for_count)
        consumer_count = workflow_call_count(consumer_for_count)

        # Direct call to producer
        result = await producer_for_count()
        assert producer_count() == 1
        assert consumer_count() == 0

        # Direct call to consumer with explicit arg
        await consumer_for_count(analysis=result)
        assert producer_count() == 1
        assert consumer_count() == 1

    @pytest.mark.asyncio
    async def test_counter_returns_callable(self) -> None:
        """Test that workflow_call_count returns a callable."""
        from smithers.testing.helpers import workflow_call_count

        @workflow
        async def callable_test_wf() -> AnalysisOutput:
            return AnalysisOutput(files=[], summary="")

        count = workflow_call_count(callable_test_wf)

        # Count should be a callable
        assert callable(count)
        # And return an integer
        assert isinstance(count(), int)

    @pytest.mark.asyncio
    async def test_preserves_workflow_output(self) -> None:
        """Test that counting wrapper preserves the workflow's output."""
        from smithers.testing.helpers import workflow_call_count

        expected_files = ["a.py", "b.py"]
        expected_summary = "Expected output"

        @workflow
        async def output_preserving_wf() -> AnalysisOutput:
            return AnalysisOutput(files=expected_files, summary=expected_summary)

        workflow_call_count(output_preserving_wf)  # Apply the counter

        result = await output_preserving_wf()

        assert result.files == expected_files
        assert result.summary == expected_summary

    @pytest.mark.asyncio
    async def test_multiple_counters_independent(self) -> None:
        """Test that counters for different workflows are independent."""
        from smithers.testing.helpers import workflow_call_count

        @workflow
        async def workflow_a() -> AnalysisOutput:
            return AnalysisOutput(files=["a.py"], summary="A")

        @workflow
        async def workflow_b() -> ImplementOutput:
            return ImplementOutput(changed_files=["b.py"])

        count_a = workflow_call_count(workflow_a)
        count_b = workflow_call_count(workflow_b)

        await workflow_a()
        await workflow_a()
        await workflow_b()

        assert count_a() == 2
        assert count_b() == 1


class TestGenerateDefault:
    """Tests for _generate_default helper function."""

    def test_string_default(self) -> None:
        """Test default generation for string type."""
        from smithers.testing.helpers import _generate_default

        result = _generate_default(str, "name")
        assert result == "mock_name"

    def test_int_default(self) -> None:
        """Test default generation for int type."""
        from smithers.testing.helpers import _generate_default

        result = _generate_default(int, "count")
        assert result == 0

    def test_float_default(self) -> None:
        """Test default generation for float type."""
        from smithers.testing.helpers import _generate_default

        result = _generate_default(float, "score")
        assert result == 0.0

    def test_bool_default(self) -> None:
        """Test default generation for bool type."""
        from smithers.testing.helpers import _generate_default

        result = _generate_default(bool, "flag")
        assert result is False

    def test_list_default(self) -> None:
        """Test default generation for list type."""
        from smithers.testing.helpers import _generate_default

        result = _generate_default(list, "items")
        assert result == []

    def test_dict_default(self) -> None:
        """Test default generation for dict type."""
        from smithers.testing.helpers import _generate_default

        result = _generate_default(dict, "data")
        assert result == {}

    def test_generic_list_default(self) -> None:
        """Test default generation for generic list type (list[str])."""
        from smithers.testing.helpers import _generate_default

        result = _generate_default(list[str], "strings")
        assert result == []

    def test_generic_dict_default(self) -> None:
        """Test default generation for generic dict type (dict[str, int])."""
        from smithers.testing.helpers import _generate_default

        result = _generate_default(dict[str, int], "mapping")
        assert result == {}

    def test_optional_type_returns_none(self) -> None:
        """Test default generation for Optional types."""
        from smithers.testing.helpers import _generate_default

        # Test str | None
        result = _generate_default(str | None, "optional_str")
        assert result is None

    def test_unknown_type_returns_none(self) -> None:
        """Test default generation for unknown types."""
        from smithers.testing.helpers import _generate_default

        class CustomType:
            pass

        result = _generate_default(CustomType, "custom")
        assert result is None


class TestMockOutputEdgeCases:
    """Additional edge case tests for mock_output."""

    def test_model_with_optional_fields(self) -> None:
        """Test mock_output with Optional field types."""

        class ModelWithOptional(BaseModel):
            required: str
            optional: str | None = None

        output = mock_output(ModelWithOptional, required="test")
        assert output.required == "test"
        assert output.optional is None

    def test_model_with_int_field(self) -> None:
        """Test mock_output generates int defaults."""

        class IntModel(BaseModel):
            count: int

        output = mock_output(IntModel)
        assert output.count == 0

    def test_model_with_float_field(self) -> None:
        """Test mock_output generates float defaults."""

        class FloatModel(BaseModel):
            score: float

        output = mock_output(FloatModel)
        assert output.score == 0.0

    def test_model_with_bool_field(self) -> None:
        """Test mock_output generates bool defaults."""

        class BoolModel(BaseModel):
            enabled: bool

        output = mock_output(BoolModel)
        assert output.enabled is False

    def test_model_with_dict_field(self) -> None:
        """Test mock_output generates empty dict for dict fields."""

        class DictModel(BaseModel):
            metadata: dict[str, str]

        output = mock_output(DictModel)
        assert output.metadata == {}

    def test_model_with_default_factory(self) -> None:
        """Test mock_output uses default_factory when present."""
        from pydantic import Field

        class FactoryModel(BaseModel):
            items: list[str] = Field(default_factory=lambda: ["default_item"])

        output = mock_output(FactoryModel)
        assert output.items == ["default_item"]
