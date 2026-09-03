# fix

Validation failed. Fix the cause, not the symptom.

For each reported failure:

1. Quote the error and name the file and line it points at.
2. Say what the code was trying to do and why the error says it does not.
3. Make the smallest change that removes the cause. Do not widen a type, delete
   an assertion, or catch an error to make a check pass.
4. Re-validate. A failure that reappears with a different message is the same
   failure; go back to step 2.

If three attempts do not clear a failure, stop and report the step as failed
with the error text. A build that reports success over a failing validation is
worse than one that reports the failure.
