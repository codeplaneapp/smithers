"""Token-free regression tests for the repository test-command selector."""

import importlib.util
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
MODULE_PATH = Path(__file__).parents[1] / "lib" / "test-command.py"
SPEC = importlib.util.spec_from_file_location("test_command", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class TestCommand(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = [{"instance_id": "django__django-1", "repo": "django/django", "version": "4.1"}]

    def test_returns_string_and_list_commands(self) -> None:
        specs = {"django/django": {"4.1": {"test_cmd": "./tests/runtests.py --verbosity 2"}}}
        self.assertEqual(
            MODULE.command_for(self.rows, specs, "django__django-1"),
            "./tests/runtests.py --verbosity 2",
        )
        specs["django/django"]["4.1"]["test_cmd"] = ["configure", "pytest -rA"]
        self.assertEqual(MODULE.command_for(self.rows, specs, "django__django-1"), "configure && pytest -rA")

    def test_refuses_missing_instances_commands_and_grader_fields(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown instance"):
            MODULE.command_for(self.rows, {}, "missing")
        with self.assertRaisesRegex(ValueError, "no test_cmd"):
            MODULE.command_for(self.rows, {}, "django__django-1")
        specs = {"django/django": {"4.1": {"test_cmd": "pytest FAIL_TO_PASS"}}}
        with self.assertRaisesRegex(ValueError, "refusing to print"):
            MODULE.command_for(self.rows, specs, "django__django-1")


if __name__ == "__main__":
    unittest.main()
