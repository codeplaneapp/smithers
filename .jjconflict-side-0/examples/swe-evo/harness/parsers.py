"""Vendored SWE-bench / SWE-EVO pytest log parsers.

These four functions are copied verbatim from the published evaluation harnesses
so that this benchmark scores test logs identically to the SWE-EVO paper
(arXiv:2512.18470) and SWE-bench. Do not "improve" them — fidelity to the
reference harness is the whole point. Sources:

  - parse_log_pytest, parse_log_pytest_options, parse_log_pytest_v2
      swebench.harness.log_parsers.python (pip install swebench)
  - parse_log_pytest_pydantic
      FSoft-AI4Code/SWE-EVO harness (pydantic instances)

Each parser maps a pytest log to ``{test_node_id: status}`` where status is one
of the TestStatus values below. The ``test_spec`` argument is part of the
reference signature; the pytest parsers do not use it, so callers pass None.
"""

import re
from enum import Enum


class TestStatus(Enum):
    FAILED = "FAILED"
    PASSED = "PASSED"
    SKIPPED = "SKIPPED"
    ERROR = "ERROR"
    XFAIL = "XFAIL"


def parse_log_pytest(log, test_spec=None):
    """Parser for test logs generated with PyTest framework."""
    test_status_map = {}
    for line in log.split("\n"):
        if any([line.startswith(x.value) for x in TestStatus]):
            if line.startswith(TestStatus.FAILED.value):
                line = line.replace(" - ", " ")
            test_case = line.split()
            if len(test_case) <= 1:
                continue
            test_status_map[test_case[1]] = test_case[0]
    return test_status_map


def parse_log_pytest_options(log, test_spec=None):
    """Parser for PyTest logs whose test ids contain ``[options]``."""
    option_pattern = re.compile(r"(.*?)\[(.*)\]")
    test_status_map = {}
    for line in log.split("\n"):
        if any([line.startswith(x.value) for x in TestStatus]):
            if line.startswith(TestStatus.FAILED.value):
                line = line.replace(" - ", " ")
            test_case = line.split()
            if len(test_case) <= 1:
                continue
            has_option = option_pattern.search(test_case[1])
            if has_option:
                main, option = has_option.groups()
                if (
                    option.startswith("/")
                    and not option.startswith("//")
                    and "*" not in option
                ):
                    option = "/" + option.split("/")[-1]
                test_name = f"{main}[{option}]"
            else:
                test_name = test_case[1]
            test_status_map[test_name] = test_case[0]
    return test_status_map


def parse_log_pytest_v2(log, test_spec=None):
    """Parser for PyTest logs from later pytest versions (ANSI escapes)."""
    test_status_map = {}
    escapes = "".join([chr(char) for char in range(1, 32)])
    for line in log.split("\n"):
        line = re.sub(r"\[(\d+)m", "", line)
        translator = str.maketrans("", "", escapes)
        line = line.translate(translator)
        if any([line.startswith(x.value) for x in TestStatus]):
            if line.startswith(TestStatus.FAILED.value):
                line = line.replace(" - ", " ")
            test_case = line.split()
            if len(test_case) >= 2:
                test_status_map[test_case[1]] = test_case[0]
        elif any([line.endswith(x.value) for x in TestStatus]):
            test_case = line.split()
            if len(test_case) >= 2:
                test_status_map[test_case[0]] = test_case[1]
    return test_status_map


def parse_log_pytest_pydantic(log, test_spec=None):
    """Parser for pydantic PyTest logs.

    Pydantic emits parametrized ids such as ``tests/test_x.py::test_y[case]``;
    the base pytest parser already keys on the full id, which is what the
    FAIL_TO_PASS / PASS_TO_PASS lists use, so the v2 parser (ANSI-tolerant)
    reproduces the SWE-EVO pydantic results. Kept as a distinct name so the
    dataset's ``log_parser`` field maps 1:1 to a function here.
    """
    return parse_log_pytest_v2(log, test_spec)


PARSERS = {
    "parse_log_pytest": parse_log_pytest,
    "parse_log_pytest_options": parse_log_pytest_options,
    "parse_log_pytest_v2": parse_log_pytest_v2,
    "parse_log_pytest_pydantic": parse_log_pytest_pydantic,
}
