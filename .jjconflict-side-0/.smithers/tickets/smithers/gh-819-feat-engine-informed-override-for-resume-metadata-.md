# ✨ feat(engine): informed override for RESUME_METADATA_MISMATCH

GitHub: https://github.com/smithersai/smithers/issues/819

There is no way to resume a parked run after its workflow file changed, even when the operator knows the edit is compatible (e.g. swapping agent chains with no schema/node-id changes). Runs with hundreds of finished nodes become disposable over a one-line prompt tweak.

Proposal: `--accept-changed-workflow` on `up --resume` that re-hashes and updates the stored workflowHash after an explicit confirmation, logging old/new hashes to the run's event history. Default behavior unchanged.
