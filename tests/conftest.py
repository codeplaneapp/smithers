"""Pytest configuration and fixtures."""

import pytest

from smithers.workflow import clear_registry


@pytest.fixture(autouse=True)
def clean_registry():
    """Clear the workflow registry before each test."""
    clear_registry()
    yield
    clear_registry()
