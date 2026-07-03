"""OpenAI-format tool schemas describing the Smithers tools to the LLM.

The descriptions are doctrine, not just docs: they steer Hermes to reach for
Smithers for anything multi-step, durable, or long-running, and to author a
workflow rather than do the work ad hoc.
"""

SMITHERS_RUN = {
    "name": "smithers_run",
    "description": (
        "Start a durable Smithers workflow run. Use this for ANY task that is "
        "multi-step, long-running, needs to survive a crash, loops until a "
        "condition holds, or needs a human approval mid-run — instead of doing "
        "the work yourself turn by turn. Smithers persists every finished step, "
        "retries on failure, and stays inspectable for days. Prefer a workflow "
        "over a one-off skill: a workflow is a superset of a skill. If no "
        "workflow fits yet, run the 'create-workflow' workflow first to author "
        "one from a plain-English description. After it starts, keep the human "
        "updated as it runs (a short summary, a diff of what changed, or a live "
        "page via `smithers ui`) so they always know what's happening; don't let "
        "a run go dark."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "workflow": {
                "type": "string",
                "description": (
                    "Workflow id to run (e.g. 'implement', 'review', 'plan', "
                    "'ralph', 'create-workflow'), or a path to a .tsx workflow file."
                ),
            },
            "prompt": {
                "type": "string",
                "description": "Plain-English task/prompt passed to the workflow as --prompt.",
            },
            "input": {
                "type": "object",
                "description": "Structured JSON input for the workflow (passed as --input). Optional.",
            },
            "detach": {
                "type": "boolean",
                "description": "Run in the background (default true) so the session stays responsive.",
            },
        },
        "required": ["workflow"],
    },
}

SMITHERS_PS = {
    "name": "smithers_ps",
    "description": "List active, paused, and recently completed Smithers runs, with any pending approval gates.",
    "parameters": {"type": "object", "properties": {}},
}

SMITHERS_INSPECT = {
    "name": "smithers_inspect",
    "description": "Show the full state of one Smithers run: steps, agents, outputs, and pending approvals.",
    "parameters": {
        "type": "object",
        "properties": {"run_id": {"type": "string", "description": "The run id to inspect."}},
        "required": ["run_id"],
    },
}

SMITHERS_APPROVE = {
    "name": "smithers_approve",
    "description": (
        "Approve a paused Smithers approval gate so the run continues. Relay the "
        "decision a human gave you; never approve irreversible work on your own."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "run_id": {"type": "string", "description": "The run id with the pending gate."},
            "node": {"type": "string", "description": "Gate node id (optional if exactly one is pending)."},
            "by": {"type": "string", "description": "Who approved (recorded on the decision)."},
            "note": {"type": "string", "description": "Optional reason."},
        },
        "required": ["run_id"],
    },
}

SMITHERS_DENY = {
    "name": "smithers_deny",
    "description": "Deny a paused Smithers approval gate. The run's onDeny policy decides what happens next.",
    "parameters": {
        "type": "object",
        "properties": {
            "run_id": {"type": "string", "description": "The run id with the pending gate."},
            "node": {"type": "string", "description": "Gate node id (optional if exactly one is pending)."},
            "by": {"type": "string", "description": "Who denied (recorded on the decision)."},
            "note": {"type": "string", "description": "Optional reason."},
        },
        "required": ["run_id"],
    },
}

SMITHERS_OUTPUT = {
    "name": "smithers_output",
    "description": "Print the structured output of a specific node in a finished Smithers run. A node id is required (find one with smithers_inspect).",
    "parameters": {
        "type": "object",
        "properties": {
            "run_id": {"type": "string", "description": "The run id."},
            "node": {"type": "string", "description": "The node id to print output for (required)."},
        },
        "required": ["run_id", "node"],
    },
}

SMITHERS_HUMAN_ANSWER = {
    "name": "smithers_human_answer",
    "description": (
        "Answer a blocking ask-human request raised by an agent inside a run. "
        "Relay the human's decision; the run unblocks with this value."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "request_id": {"type": "string", "description": "The human-request id (from `smithers human inbox`)."},
            "value": {"type": "string", "description": "The answer value to deliver."},
        },
        "required": ["request_id", "value"],
    },
}
