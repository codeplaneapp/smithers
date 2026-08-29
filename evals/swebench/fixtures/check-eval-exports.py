"""Checks what `lib/grade.py` puts inside the official eval script, and where.

    .venv-swb/bin/python fixtures/check-eval-exports.py

`SWB_EVAL_EXPORTS` is how the rig gives the psf/requests family the httpbin its
graded tests were always written against (see `lib/grade.py` and
`lib/httpbin.sh`). It rewrites a script the official evaluator generates, so the
rewrite is checked here rather than discovered in a grading run:

- the exports land after `set -uxo pipefail` and before the evaluator's first
  command, so they are in scope for all of it;
- every command the evaluator wrote survives, in order, unchanged;
- values are shell-quoted, so a URL with a shell metacharacter in it cannot
  become a command;
- `SWB_EVAL_EXPORTS_REPOS` really does scope the rewrite — an instance from
  another repo gets the untouched official script, byte for byte;
- and with no `SWB_EVAL_EXPORTS` set, nothing is patched at all.

Spends no tokens, needs no docker and no dataset. Needs the evaluator venv.
"""

import importlib
import json
import os
import sys
from pathlib import Path

RIG = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RIG / "lib"))

from swebench.harness.test_spec.test_spec import TestSpec  # noqa: E402

PRISTINE = TestSpec.eval_script

COMMANDS = [
    "source /opt/miniconda3/bin/activate",
    "conda activate testbed",
    "cd /testbed",
    ": '>>>>> Start Test Output'",
    "pytest -rA test_requests.py",
    ": '>>>>> End Test Output'",
]


def spec(instance_id: str, repo: str) -> TestSpec:
    return TestSpec(
        instance_id=instance_id,
        repo=repo,
        version="2.3",
        repo_script_list=[],
        eval_script_list=list(COMMANDS),
        env_script_list=[],
        arch="x86_64",
        FAIL_TO_PASS=[],
        PASS_TO_PASS=[],
        language="py",
        docker_specs={},
        namespace="swebench",
    )


def reload_grade(exports: str | None, repos: str | None):
    for key, value in (("SWB_EVAL_EXPORTS", exports), ("SWB_EVAL_EXPORTS_REPOS", repos)):
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    TestSpec.eval_script = PRISTINE
    grade = importlib.import_module("grade")
    importlib.reload(grade)
    grade._install_eval_exports()
    return grade


def fail(message: str) -> None:
    print(f"check-eval-exports: {message}", file=sys.stderr)
    raise SystemExit(1)


requests_spec = spec("psf__requests-2317", "psf/requests")
django_spec = spec("django__django-16612", "django/django")

official = PRISTINE.fget(requests_spec)
official_django = PRISTINE.fget(django_spec)

# 1. No request, no rewrite.
reload_grade(None, None)
if TestSpec.eval_script.fget(requests_spec) != official:
    fail("an unset SWB_EVAL_EXPORTS still rewrote the eval script")

# 2. The exports land in the one right place, and nothing else moves.
url = "http://192.168.215.7/"
reload_grade(json.dumps({"HTTPBIN_URL": url}), "psf/requests")
patched = TestSpec.eval_script.fget(requests_spec)
lines = patched.split("\n")
if lines[:2] != ["#!/bin/bash", "set -uxo pipefail"]:
    fail(f"the script no longer opens with the official two lines: {lines[:2]}")
if lines[2] != f"export HTTPBIN_URL={url!r}".replace('"', "'"):
    # shlex.quote leaves an unproblematic URL bare; accept either form.
    if lines[2] not in (f"export HTTPBIN_URL={url}", f"export HTTPBIN_URL='{url}'"):
        fail(f"line 3 is not the export: {lines[2]!r}")
if lines[3:3 + len(COMMANDS)] != COMMANDS:
    fail("the evaluator's own commands did not survive the rewrite in order")
if patched.count("export HTTPBIN_URL") != 1:
    fail("the export was injected more than once")

# 3. Another repo is graded against the untouched official script.
if TestSpec.eval_script.fget(django_spec) != official_django:
    fail("SWB_EVAL_EXPORTS_REPOS did not scope the rewrite to psf/requests")

# 4. An unscoped request reaches every instance.
reload_grade(json.dumps({"HTTPBIN_URL": url}), None)
if "export HTTPBIN_URL" not in TestSpec.eval_script.fget(django_spec):
    fail("an unscoped SWB_EVAL_EXPORTS skipped an instance")

# 5. A value carrying shell syntax is quoted, not executed.
reload_grade(json.dumps({"HTTPBIN_URL": "http://x/;rm -rf /"}), "psf/requests")
hostile = TestSpec.eval_script.fget(requests_spec).split("\n")[2]
if hostile != "export HTTPBIN_URL='http://x/;rm -rf /'":
    fail(f"a value with shell syntax was not quoted: {hostile!r}")

# 6. Malformed input is refused rather than silently ignored.
for bad in ("not json", '["HTTPBIN_URL"]', '{"not an identifier!": "x"}'):
    TestSpec.eval_script = PRISTINE
    os.environ["SWB_EVAL_EXPORTS"] = bad
    grade = importlib.reload(importlib.import_module("grade"))
    try:
        grade._install_eval_exports()
    except SystemExit:
        continue
    fail(f"SWB_EVAL_EXPORTS={bad!r} was accepted")

TestSpec.eval_script = PRISTINE
print("check-eval-exports: the export lands after `set -uxo pipefail`, quoted, scoped, once.")

# ---------------------------------------------------------------------------
# The scoped image cleanup: one grading may not delete another's image.
#
# This is the defect that produced every `eval error` verdict in the r90
# benchmark — the evaluator's `clean_images` removes every `sweb.eval` image
# that appeared while it was running, including one a concurrent worker pulled
# for an instance this grading was never asked about.
# ---------------------------------------------------------------------------
import swebench.harness.docker_utils as docker_utils  # noqa: E402

PRISTINE_CLEAN = docker_utils.clean_images


class FakeImage:
    def __init__(self, tag: str) -> None:
        self.tags = [tag]


class FakeImages:
    def __init__(self, tags: list[str]) -> None:
        self._tags = list(tags)

    def list(self, all: bool = False):  # noqa: A002 - the docker SDK's own name
        return [FakeImage(tag) for tag in self._tags]


class FakeClient:
    def __init__(self, tags: list[str]) -> None:
        self.images = FakeImages(tags)


OURS = "swebench/sweb.eval.x86_64.django_1776_django-12741:latest"
THEIRS = "swebench/sweb.eval.x86_64.astropy_1776_astropy-7166:latest"
ENV_IMAGE = "swebench/sweb.env.x86_64.abc123:latest"

grade = importlib.reload(importlib.import_module("grade"))

if grade._instance_of(OURS) != "django__django-12741":
    fail(f"an eval tag did not resolve to its instance id: {grade._instance_of(OURS)!r}")
if grade._instance_of(ENV_IMAGE) != "":
    fail("an env image was read as an instance's eval image")
if grade._instance_of("alpine:latest") != "":
    fail("an unrelated image was read as an instance's eval image")

sys.argv = [
    "grade.py",
    "--predictions_path", "/dev/null",
    "--instance_ids", "django__django-12741", "django__django-13406",
    "--max_workers", "1",
]
if grade._graded_instance_ids() != {"django__django-12741", "django__django-13406"}:
    fail("--instance_ids were not read off the command line")

seen: dict[str, object] = {}


def record(client, prior_images, cache_level, clean):  # noqa: ANN001
    seen["prior"] = set(prior_images)
    seen["cache_level"] = cache_level


docker_utils.clean_images = record
grade._install_scoped_image_cleanup()
docker_utils.clean_images(FakeClient([OURS, THEIRS, ENV_IMAGE]), set(), "env", False)
if THEIRS not in seen["prior"]:
    fail("a concurrent grading's image was left unprotected — this is the eval-error defect")
if OURS in seen["prior"]:
    fail("the graded instance's own image was protected, so --cache_level env would leak it")
if ENV_IMAGE in seen["prior"]:
    fail("an env image was needlessly protected; --cache_level env never removes one")
if seen["cache_level"] != "env":
    fail("the cache level did not reach the evaluator's own cleanup")

# With no ids to scope to, the evaluator's own behaviour is left alone.
docker_utils.clean_images = PRISTINE_CLEAN
sys.argv = ["grade.py", "--max_workers", "1"]
grade._install_scoped_image_cleanup()
if docker_utils.clean_images is not PRISTINE_CLEAN:
    fail("an unscopeable grading still wrapped the evaluator's cleanup")

docker_utils.clean_images = PRISTINE_CLEAN
print("check-eval-exports: one grading's cleanup cannot delete another grading's image.")
