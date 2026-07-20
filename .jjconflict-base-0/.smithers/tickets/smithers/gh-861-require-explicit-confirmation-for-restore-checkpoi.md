# Require explicit confirmation for restore_checkpoint MCP tool

GitHub: https://github.com/smithersai/smithers/issues/861

Add a confirm field that defaults to false or otherwise requires true in restore_checkpoint's input schema, reject calls without confirm=true before checkpoint selection or worktree mutation, update the description, and add unit/integration tests proving unconfirmed calls do not invoke restore and confirmed calls still work.
