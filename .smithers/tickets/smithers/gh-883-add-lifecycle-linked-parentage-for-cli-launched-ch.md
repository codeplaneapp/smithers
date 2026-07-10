# Add lifecycle-linked parentage for CLI-launched child runs

GitHub: https://github.com/smithersai/smithers/issues/883

Add a supported parent-run option or engine API for detached child launches. Persist and validate the parentRunId, propagate it through detached process arguments, and expose the relationship in run inspection. Add integration tests proving dynamically launched children are linked to their parent.
