# Add optimistic concurrency protection to local UI file saves

GitHub: https://github.com/smithersai/smithers/issues/909

Require the client to submit the mtime or content hash returned by read, compare it with the current file revision before writing, return HTTP 409 on mismatch without changing the newer file, and return the new revision after a successful save. Add stale-reader and successful-new-revision tests.
