#!/usr/bin/env bash
# Prepare a RoadmapBench task for a smithers agent run.
#
# Layout (leak-proof by construction):
#
#   AGENT_HOME/                 <- a fresh, isolated temp dir
#     repo/                     <- the ONLY thing here; agent cwd; bind-mounted /app
#
#   CONTROL (= work_dir arg)/   <- lives elsewhere (e.g. .context/.../runs/<slug>)
#     manifest.json             <- paths to hidden tests etc. (read by smithers, NOT the agent)
#     instruction.md            <- embedded into the prompt anyway; agent never needs the file
#     score/ , events/          <- scorer + event outputs
#
# Because the agent's cwd is AGENT_HOME/repo and AGENT_HOME contains ONLY repo,
# relative traversal (../, ../../, ...) from the agent never reaches the dataset,
# the manifest, the hidden tests, or the oracle. There is no on-disk breadcrumb
# to the answer key. (Defense in depth: every command + the final diff are
# scanned afterwards by audit_run.py, and both containers run --network none.)
#
# Steps:
#   1. extract pristine V_old repo from the official image -> AGENT_HOME/repo
#   2. start a long-lived, OFFLINE agent container with repo bind-mounted at /app
#   3. refresh editable install so /app metadata matches the bind-mounted repo
#   4. emit CONTROL/manifest.json
#
# Usage: prepare_task.sh <task_dir> <control_dir>
set -euo pipefail
TASK_DIR="$(cd "${1:?task_dir}" && pwd)"
CONTROL="${2:?control_dir}"
TASK_ID="$(basename "$TASK_DIR")"
IMAGE="$(awk -F'"' '/docker_image/{print $2; exit}' "$TASK_DIR/task.toml")"
CONTAINER="rmb_$(echo "$TASK_ID" | tr -c 'a-zA-Z0-9_.-' '_')"

rm -rf "$CONTROL"; mkdir -p "$CONTROL"
CONTROL="$(cd "$CONTROL" && pwd)"

# isolated agent home far from the dataset tree. Use a persistent base (NOT
# $TMPDIR — macOS purges /var/folders, which would destroy the post-run diff
# before it can be audited). The base contains only agent homes, so there is
# still no on-disk breadcrumb to the dataset.
RMB_HOME_BASE="${RMB_HOME_BASE:-$HOME/.cache/roadmapbench/homes}"; mkdir -p "$RMB_HOME_BASE"
AGENT_HOME="${RMB_AGENT_HOME:-$(mktemp -d "$RMB_HOME_BASE/rmb-${TASK_ID}-XXXXXX")}"
rm -rf "$AGENT_HOME"; mkdir -p "$AGENT_HOME"
AGENT_HOME="$(cd "$AGENT_HOME" && pwd)"
REPO="$AGENT_HOME/repo"

echo "[prepare] $TASK_ID image=$IMAGE agent_home=$AGENT_HOME" >&2

# 1. extract pristine repo
cid="$(docker create --platform linux/amd64 "$IMAGE")"
docker cp "$cid:/app" "$AGENT_HOME/_app" >/dev/null
docker rm "$cid" >/dev/null
if [[ -d "$AGENT_HOME/_app/app" ]]; then mv "$AGENT_HOME/_app/app" "$REPO"; rm -rf "$AGENT_HOME/_app";
else mv "$AGENT_HOME/_app" "$REPO"; fi

# instruction copy lives in CONTROL (read by the smithers process only)
cp "$TASK_DIR/instruction.md" "$CONTROL/instruction.md"

# 2. start agent container (offline). All build/test deps are baked into the
#    image, so --network none is fully functional and makes it physically
#    impossible to fetch/install the upstream target release for the answer.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --platform linux/amd64 --network none \
  --cpus "${RMB_CPUS:-2}" --memory "${RMB_MEMORY:-4096m}" \
  -v "$REPO":/app -w /app "$IMAGE" sleep infinity >/dev/null

# 3. refresh editable metadata for the bind-mounted repo (no network needed)
docker exec "$CONTAINER" bash -lc 'cd /app && pip install -e . --no-deps --no-build-isolation -q' \
  >/dev/null 2>&1 || echo "[prepare] warn: editable refresh non-zero (continuing)" >&2

# 4. manifest (in CONTROL, never adjacent to the agent's repo)
cat > "$CONTROL/manifest.json" <<EOF
{
  "taskId": "$TASK_ID",
  "image": "$IMAGE",
  "container": "$CONTAINER",
  "repoDir": "$REPO",
  "agentHome": "$AGENT_HOME",
  "instructionPath": "$CONTROL/instruction.md",
  "testsDir": "$TASK_DIR/tests",
  "workDir": "$CONTROL"
}
EOF
echo "[prepare] ready: $CONTROL/manifest.json" >&2
cat "$CONTROL/manifest.json"
