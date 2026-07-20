import type { RunNode } from "./Run";

/**
 * The demo run, captured as discrete frames. A local engine advances the frame
 * index on a timer; the gateway would replace this by streaming real run events
 * into the same RunNode shape. Frame 4 is the deploy gate (overall "waiting").
 *
 * Steps: plan → edit-files (auth/session.ts, auth/token.ts) → run-tests.
 * The deploy gate is surfaced as a separate approval card, not a tree node.
 */
function frame(
  plan: RunNode,
  edit: RunNode,
  tests: RunNode,
  status: RunNode["status"],
): RunNode {
  return {
    id: "workflow",
    name: "workflow",
    kind: "merge",
    status,
    children: [plan, edit, tests],
  };
}

const PLAN_RUNNING: RunNode = {
  id: "plan",
  name: "plan",
  cardLabel: "Plan the change",
  kind: "agent",
  status: "running",
  meta: "running",
  agent: "claude-opus-4-8",
  output: "Mapping the token flow across auth/session.ts and auth/token.ts.",
};

const PLAN_OK: RunNode = {
  ...PLAN_RUNNING,
  status: "ok",
  meta: "8s",
  output: "3 steps drafted: rotate tokens, fix the suite, deploy.",
};

const SESSION_RUNNING: RunNode = {
  id: "edit-session",
  name: "auth/session.ts",
  kind: "compute",
  status: "running",
  meta: "running",
};
const SESSION_OK: RunNode = { ...SESSION_RUNNING, status: "ok", meta: "ok" };
const TOKEN_QUEUED: RunNode = {
  id: "edit-token",
  name: "auth/token.ts",
  kind: "compute",
  status: "queued",
  meta: "queued",
};
const TOKEN_RUNNING: RunNode = { ...TOKEN_QUEUED, status: "running", meta: "running" };
const TOKEN_OK: RunNode = { ...TOKEN_QUEUED, status: "ok", meta: "ok" };

function editFiles(
  status: RunNode["status"],
  meta: string,
  children: RunNode[],
  toolCalls: RunNode["toolCalls"],
): RunNode {
  return {
    id: "edit-files",
    name: "edit-files",
    cardLabel: "Edit 6 files",
    kind: "loop",
    status,
    meta,
    agent: "claude-opus-4-8",
    output: "Rotating tokens; setting ttl from ROTATE_TTL.",
    children,
    toolCalls,
  };
}

const TESTS_QUEUED: RunNode = {
  id: "run-tests",
  name: "run-tests",
  cardLabel: "Run test suite",
  kind: "compute",
  status: "queued",
  meta: "queued",
  output: "Waiting on edit-files.",
};
const TESTS_RUNNING: RunNode = {
  ...TESTS_QUEUED,
  status: "running",
  meta: "running",
  output: "bun test — 142 passing, 6 pending…",
};
const TESTS_OK: RunNode = {
  ...TESTS_QUEUED,
  status: "ok",
  meta: "12s",
  output: "bun test — 148 passing, 0 failing.",
};

export const AUTH_REFACTOR_FRAMES: RunNode[] = [
  // 0 — planning
  frame(
    PLAN_RUNNING,
    editFiles("queued", "queued", [TOKEN_QUEUED], []),
    TESTS_QUEUED,
    "running",
  ),
  // 1 — editing, first file in flight
  frame(
    PLAN_OK,
    editFiles(
      "running",
      "running",
      [SESSION_RUNNING, TOKEN_QUEUED],
      [{ id: "tc1", verb: "Edit", target: "auth/session.ts", status: "running" }],
    ),
    TESTS_QUEUED,
    "running",
  ),
  // 2 — screenshot state: session done (+18 −4), token writing
  frame(
    PLAN_OK,
    editFiles(
      "running",
      "running",
      [SESSION_OK, TOKEN_RUNNING],
      [
        { id: "tc1", verb: "Edit", target: "auth/session.ts", status: "ok", add: 18, del: 4 },
        { id: "tc2", verb: "Write", target: "auth/token.ts", status: "running" },
      ],
    ),
    TESTS_QUEUED,
    "running",
  ),
  // 3 — edits done, tests running
  frame(
    PLAN_OK,
    editFiles(
      "ok",
      "1m20s",
      [SESSION_OK, TOKEN_OK],
      [
        { id: "tc1", verb: "Edit", target: "auth/session.ts", status: "ok", add: 18, del: 4 },
        { id: "tc2", verb: "Write", target: "auth/token.ts", status: "ok", add: 31, del: 9 },
      ],
    ),
    TESTS_RUNNING,
    "running",
  ),
  // 4 — tests green, deploy gate raised (overall waiting)
  frame(
    PLAN_OK,
    editFiles(
      "ok",
      "1m20s",
      [SESSION_OK, TOKEN_OK],
      [
        { id: "tc1", verb: "Edit", target: "auth/session.ts", status: "ok", add: 18, del: 4 },
        { id: "tc2", verb: "Write", target: "auth/token.ts", status: "ok", add: 31, del: 9 },
      ],
    ),
    TESTS_OK,
    "waiting",
  ),
  // 5 — approved, deploying
  frame(
    PLAN_OK,
    editFiles(
      "ok",
      "1m20s",
      [SESSION_OK, TOKEN_OK],
      [
        { id: "tc1", verb: "Edit", target: "auth/session.ts", status: "ok", add: 18, del: 4 },
        { id: "tc2", verb: "Write", target: "auth/token.ts", status: "ok", add: 31, del: 9 },
      ],
    ),
    TESTS_OK,
    "running",
  ),
  // 6 — done
  frame(
    PLAN_OK,
    editFiles(
      "ok",
      "1m20s",
      [SESSION_OK, TOKEN_OK],
      [
        { id: "tc1", verb: "Edit", target: "auth/session.ts", status: "ok", add: 18, del: 4 },
        { id: "tc2", verb: "Write", target: "auth/token.ts", status: "ok", add: 31, del: 9 },
      ],
    ),
    TESTS_OK,
    "ok",
  ),
];

/** Frame index at which the deploy approval gate is pending. */
export const GATE_FRAME = 4;
