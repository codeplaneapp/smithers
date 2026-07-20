# Preserve Monitor selection and filters across gateway recovery

GitHub: https://github.com/smithersai/smithers/issues/1043

Parent: smithers/smithers-gh-855-add-complete-monitor-loadi-0h89cz9--make-gateway-disconnection-and-recovery-st-0z3jdjw.md

Context: The Monitor stores selected run, selected node, search text, status filter, workflow filter, and pagination locally, while gateway collections reconnect and refresh asynchronously. Acceptance criteria: 1. A gateway disconnect does not clear the selected run or node. 2. Search, status, workflow, and page selections remain intact during disconnect and after recovery. 3. Reconnected data replaces stale rows without resetting the user’s view. 4. A selected run that remains available becomes live again after recovery. 5. Add an integration test covering disconnect, reconnect, data refresh, selection, and filters.
