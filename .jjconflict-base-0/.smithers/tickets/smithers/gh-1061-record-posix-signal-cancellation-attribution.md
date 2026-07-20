# Record POSIX signal cancellation attribution

GitHub: https://github.com/smithersai/smithers/issues/1061

Capture the actual POSIX signal received by the process, such as SIGINT or SIGTERM, thread it through the cancellation path, and persist it as a signal source on the terminal run row and RunCancelled event. Add signal-focused tests.
