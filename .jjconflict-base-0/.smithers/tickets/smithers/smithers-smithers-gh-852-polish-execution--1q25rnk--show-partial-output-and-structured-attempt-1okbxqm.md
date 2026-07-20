# Show partial output and structured attempt failure details

GitHub: https://github.com/smithersai/smithers/issues/1151

Parent: smithers/smithers-gh-852-polish-execution-tree-retr-051acv6--complete-structured-node-output-and-error--0jj8193.md

Context: Failed output responses already carry partial heartbeat data and structured error metadata, but the execution-tree inspector does not display the partial field. Acceptance criteria: Render partial output when present; render error name, code, message, and attempt; support raw or malformed stored errors with a useful message; add success and failure tests covering these fields.
